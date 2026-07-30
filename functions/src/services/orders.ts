/**
 * Ciclo de vida de una orden.
 *
 * Flujo del documento técnico:
 *   crear orden → mostrar datos de Pago Móvil y monto exacto en Bs →
 *   el cliente paga y envía la referencia → se consulta a Pabilo →
 *   si `is_new === true` el pago es válido → despacho automático (Inefable)
 *   o generación del enlace de WhatsApp (producto manual).
 *
 * Dos protecciones importantes viven aquí:
 *
 *  1. El monto en bolívares se CONGELA al crear la orden. Si la tasa cambia
 *     mientras el cliente está pagando, se le sigue exigiendo (y verificando)
 *     el monto que vio en pantalla.
 *  2. Antes de consultar a Pabilo se toma un candado local sobre la referencia
 *     (`paymentRefs/{referencia}`). `is_new` protege contra reutilizar una
 *     referencia ya consumida, pero no contra dos peticiones simultáneas con la
 *     misma referencia: ambas verían `is_new === true`. El candado sí.
 */
import { FieldValue } from 'firebase-admin/firestore';
import type { Query } from 'firebase-admin/firestore';
import {
  db,
  orders,
  paymentRefs,
  now,
  minutesFromNow,
  Timestamp,
} from '../config/firebase';
import {
  failedPrecondition,
  forbidden,
  invalidArgument,
  maintenance,
  notFound,
  paymentRejected,
} from '../lib/errors';
import { generateOrderCode, normalizeReference } from '../lib/ids';
import { amountMatches, round, usdToBs } from '../lib/money';
import { log } from '../lib/logger';
import * as catalog from './catalog';
import * as couponsService from './coupons';
import * as pabilo from './pabilo';
import * as dispatchService from './dispatch';
import * as audit from './audit';
import * as notifications from './notifications';
import * as stats from './stats';
import * as usersService from './users';
import { addEvent } from './orderEvents';
import { getConfig } from './settings';
import { buildCallPlan } from './dispatch';
import type { AuthUser } from '../middleware/auth';
import type { Order, OrderPricing, OrderStatus, UserProfile } from '../types/models';

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function getOrder(orderId: string): Promise<Order> {
  const snap = await orders().doc(orderId).get();
  if (!snap.exists) throw notFound('Orden no encontrada.');
  return { id: snap.id, ...snap.data() } as Order;
}

/** Carga la orden verificando que pertenezca al usuario (o que sea staff). */
export async function getOrderFor(orderId: string, user: AuthUser): Promise<Order> {
  const order = await getOrder(orderId);
  if (order.uid !== user.uid && !user.isStaff) {
    throw forbidden('Esa orden no es tuya.');
  }
  return order;
}

export interface ListOrdersOptions {
  uid?: string;
  status?: OrderStatus | OrderStatus[];
  gameId?: string;
  fulfillment?: 'auto' | 'manual';
  playerId?: string;
  limit: number;
  /** Cursor de paginación: milisegundos de `createdAt` del último resultado. */
  beforeMillis?: number;
}

export async function listOrders(options: ListOrdersOptions): Promise<Order[]> {
  let query: Query = orders();

  if (options.uid) query = query.where('uid', '==', options.uid);
  if (options.gameId) query = query.where('gameId', '==', options.gameId);
  if (options.fulfillment) query = query.where('fulfillment', '==', options.fulfillment);
  if (options.playerId) query = query.where('playerId', '==', options.playerId);

  if (Array.isArray(options.status)) {
    if (options.status.length > 0) query = query.where('status', 'in', options.status.slice(0, 10));
  } else if (options.status) {
    query = query.where('status', '==', options.status);
  }

  query = query.orderBy('createdAt', 'desc');

  if (options.beforeMillis) {
    query = query.startAfter(Timestamp.fromMillis(options.beforeMillis));
  }

  const snap = await query.limit(options.limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Order);
}

/**
 * Vista de la orden para el cliente: sin la nota interna, sin los metadatos
 * anti-fraude y, sobre todo, sin el costo ni la utilidad del negocio.
 */
export type CustomerOrder = Omit<Order, 'adminNote' | 'meta' | 'pricing'> & {
  pricing: Omit<OrderPricing, 'costUsd' | 'profitUsd'>;
};

export function toCustomerOrder(order: Order): CustomerOrder {
  const { adminNote: _adminNote, meta: _meta, pricing: fullPricing, ...rest } = order;
  const { costUsd: _costUsd, profitUsd: _profitUsd, ...pricing } = fullPricing;
  return { ...rest, pricing };
}

// ---------------------------------------------------------------------------
// Creación
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  gameId: string;
  productId: string;
  playerId: string;
  quantity: number;
  couponCode?: string | null;
  customerNote?: string | null;
  ip: string | null;
  userAgent: string | null;
}

export async function createOrder(
  user: AuthUser,
  profile: UserProfile,
  input: CreateOrderInput
): Promise<Order> {
  const config = await getConfig();

  if (config.features.maintenanceMode && !user.isStaff) {
    throw maintenance(config.features.maintenanceMessage);
  }

  usersService.assertNotBanned(profile);

  const [game, product] = await Promise.all([
    catalog.getGame(input.gameId),
    catalog.getProduct(input.productId),
  ]);

  if (product.gameId !== game.id) {
    throw invalidArgument('Ese producto no pertenece al juego seleccionado.');
  }

  catalog.assertPurchasable(product, game);
  catalog.assertValidPlayerId(input.playerId, game);

  if (product.fulfillment === 'manual' && !config.features.manualProductsEnabled) {
    throw failedPrecondition('Los productos manuales están desactivados temporalmente.');
  }

  if (product.stock !== null && product.stock < input.quantity) {
    throw failedPrecondition(`Sólo quedan ${product.stock} unidades de ese producto.`);
  }

  // Evita que un usuario acumule órdenes sin pagar y bloquee el inventario.
  const openOrders = await orders()
    .where('uid', '==', user.uid)
    .where('status', 'in', ['awaiting_payment', 'verifying'])
    .count()
    .get();

  if (openOrders.data().count >= config.checkout.maxOpenOrdersPerUser) {
    throw failedPrecondition(
      `Tienes ${openOrders.data().count} órdenes sin pagar. Complétalas o cancélalas antes de crear otra.`
    );
  }

  // --- Precios ---
  const quantity = Math.max(1, Math.min(10, Math.trunc(input.quantity)));
  const unitUsd = round(product.priceUsd, 2);
  const subtotalUsd = round(unitUsd * quantity, 2);

  let discountUsd = 0;
  let couponCode: string | null = null;

  // Descuento por nivel de fidelidad (siempre aplica, no requiere cupón).
  const tierPercent = usersService.tierDiscountPercent(profile.tier);
  if (tierPercent > 0) {
    discountUsd = round((subtotalUsd * tierPercent) / 100, 2);
  }

  if (input.couponCode && config.features.couponsEnabled) {
    const evaluation = await couponsService.evaluate({
      code: input.couponCode,
      uid: user.uid,
      subtotalUsd,
      gameId: game.id,
      productId: product.id,
    });
    discountUsd = round(discountUsd + evaluation.discountUsd, 2);
    couponCode = evaluation.coupon.code;
  }

  // Nunca por debajo de un céntimo: el monto debe poder pagarse y verificarse.
  discountUsd = Math.min(discountUsd, round(subtotalUsd - 0.01, 2));
  const totalUsd = round(subtotalUsd - discountUsd, 2);
  const rate = config.rate.value;
  const totalBs = usdToBs(totalUsd, rate, config.pricing.roundToBs);
  const costUsd = round(product.costUsd * quantity, 4);

  const orderRef = orders().doc();
  const timestamp = now();

  const order: Omit<Order, 'id'> = {
    code: generateOrderCode(),
    uid: user.uid,
    user: {
      email: user.email,
      displayName: profile.displayName ?? user.displayName,
      photoURL: profile.photoURL ?? user.photoURL,
    },
    gameId: game.id,
    gameName: game.name,
    providerGameId: game.apiGameId,
    productId: product.id,
    productName: product.name,
    productSku: product.sku,
    fulfillment: product.fulfillment,
    playerId: input.playerId,
    pricing: {
      unitUsd,
      quantity,
      subtotalUsd,
      discountUsd,
      totalUsd,
      rate,
      totalBs,
      couponCode,
      costUsd,
      profitUsd: round(totalUsd - costUsd, 4),
    },
    payment: {
      method: 'pagomovil_bdv',
      reference: null,
      verifiedAt: null,
      attempts: 0,
      providerResponse: null,
      bankSnapshot: {
        code: config.bank.code,
        name: config.bank.name,
        idNumber: config.bank.idNumber,
        phone: config.bank.phone,
      },
    },
    dispatch: {
      // El plan se calcula ahora y se guarda en la orden: si el admin edita el
      // producto más tarde, esta orden conserva las llamadas que se cotizaron
      // al comprar. Con cantidad > 1 el plan completo se repite.
      calls:
        product.fulfillment === 'auto'
          ? Array.from({ length: quantity }, () => buildCallPlan(product.calls))
              .flat()
              .map((call, index) => ({ ...call, index }))
          : [],
      startedAt: null,
      completedAt: null,
      lastError: null,
    },
    whatsappUrl: null,
    status: 'awaiting_payment',
    customerNote: input.customerNote?.slice(0, 300) ?? null,
    adminNote: null,
    meta: { ip: input.ip, userAgent: input.userAgent },
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: minutesFromNow(config.checkout.orderExpiryMinutes),
  };

  await orderRef.set(order);

  await Promise.all([
    addEvent({
      orderId: orderRef.id,
      type: 'created',
      message: `Orden creada por ${order.pricing.totalBs.toFixed(2)} Bs.`,
      status: 'awaiting_payment',
      actor: 'customer',
      actorUid: user.uid,
    }),
    usersService.registerCreatedOrder(user.uid),
    stats.trackEvent({ type: 'order_created', order: { id: orderRef.id, ...order } }),
    audit.record({
      action: audit.ACTIONS.ORDER_CREATED,
      actorUid: user.uid,
      actorEmail: user.email,
      targetType: 'order',
      targetId: orderRef.id,
      summary: `Orden ${order.code}: ${order.productName} para ${order.playerId}.`,
      data: { totalUsd, totalBs, rate },
      ip: input.ip,
    }),
  ]);

  log.info('Orden creada', { orderId: orderRef.id, code: order.code, totalBs });
  return { id: orderRef.id, ...order };
}

// ---------------------------------------------------------------------------
// Verificación de pago
// ---------------------------------------------------------------------------

interface ReferenceLock {
  acquired: boolean;
  conflictOrderCode?: string;
}

/**
 * Toma un candado exclusivo sobre la referencia bancaria.
 * Sólo una orden en todo el sistema puede tener una referencia dada.
 */
async function acquireReferenceLock(
  reference: string,
  orderId: string,
  uid: string
): Promise<ReferenceLock> {
  const ref = paymentRefs().doc(reference);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    if (snap.exists) {
      const data = snap.data() as { orderId?: string; orderCode?: string } | undefined;
      if (data?.orderId && data.orderId !== orderId) {
        return { acquired: false, conflictOrderCode: data.orderCode ?? '' };
      }
    }

    tx.set(ref, { orderId, uid, reference, createdAt: now() }, { merge: true });
    return { acquired: true };
  });
}

async function releaseReferenceLock(reference: string): Promise<void> {
  try {
    await paymentRefs().doc(reference).delete();
  } catch (error) {
    log.warn('No se pudo liberar el candado de referencia', {
      reference: `***${reference.slice(-4)}`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface VerifyPaymentResult {
  order: Order;
  verified: boolean;
  message: string;
}

export async function verifyPayment(
  user: AuthUser,
  orderId: string,
  rawReference: string,
  ip: string | null
): Promise<VerifyPaymentResult> {
  const config = await getConfig();
  const order = await getOrderFor(orderId, user);

  if (order.uid !== user.uid) throw forbidden('Esa orden no es tuya.');

  if (order.status === 'completed' || order.status === 'awaiting_manual') {
    return { order, verified: true, message: 'Esta orden ya fue pagada.' };
  }

  if (!['awaiting_payment', 'payment_rejected'].includes(order.status)) {
    throw failedPrecondition('Esta orden ya no admite verificación de pago.');
  }

  if (order.expiresAt.toMillis() < Date.now()) {
    await orders().doc(orderId).set({ status: 'expired', updatedAt: now() }, { merge: true });
    throw failedPrecondition(
      'Esta orden expiró. Crea una nueva para que el monto se calcule con la tasa vigente.'
    );
  }

  if (order.payment.attempts >= config.checkout.maxVerifyAttempts) {
    throw failedPrecondition(
      'Alcanzaste el máximo de intentos de verificación. Escríbenos por WhatsApp y lo revisamos.'
    );
  }

  const reference = normalizeReference(rawReference);
  if (
    reference.length < config.checkout.referenceMinLength ||
    reference.length > config.checkout.referenceMaxLength
  ) {
    throw invalidArgument(
      `La referencia debe tener entre ${config.checkout.referenceMinLength} y ${config.checkout.referenceMaxLength} dígitos.`
    );
  }

  // Marca el intento antes de nada: así un cliente no puede lanzar peticiones
  // ilimitadas contra Pabilo aunque cancele la respuesta a mitad de camino.
  await orders().doc(orderId).set(
    {
      status: 'verifying',
      payment: { reference, attempts: FieldValue.increment(1) },
      updatedAt: now(),
    },
    { merge: true }
  );

  const lock = await acquireReferenceLock(reference, orderId, user.uid);
  if (!lock.acquired) {
    await orders().doc(orderId).set(
      { status: 'payment_rejected', updatedAt: now() },
      { merge: true }
    );
    await addEvent({
      orderId,
      type: 'payment_duplicate',
      message: 'Esa referencia ya está asociada a otra orden.',
      status: 'payment_rejected',
    });
    throw paymentRejected(
      lock.conflictOrderCode
        ? `Esa referencia ya se usó en la orden ${lock.conflictOrderCode}.`
        : 'Esa referencia ya fue utilizada en otra compra.'
    );
  }

  let result: Awaited<ReturnType<typeof pabilo.verifyPayment>>;
  try {
    result = await pabilo.verifyPayment({
      bankReference: reference,
      amountBs: order.pricing.totalBs,
    });
  } catch (error) {
    // El proveedor está caído: se libera el candado y se devuelve la orden a
    // "esperando pago" para que el cliente pueda reintentar sin perder nada.
    await releaseReferenceLock(reference);
    await orders().doc(orderId).set(
      { status: 'awaiting_payment', updatedAt: now() },
      { merge: true }
    );
    await addEvent({
      orderId,
      type: 'payment_provider_error',
      message: 'No se pudo contactar al verificador de pagos. Se puede reintentar.',
      status: 'awaiting_payment',
    });
    throw error;
  }

  // --- Rechazo ---
  const amountOk =
    result.reportedAmountBs === null ||
    amountMatches(
      order.pricing.totalBs,
      result.reportedAmountBs,
      config.checkout.amountTolerancePercent
    );

  if (!result.isNew || !amountOk) {
    await releaseReferenceLock(reference);

    const reason = !result.found
      ? 'No encontramos ese pago. Revisa que la referencia y el monto sean exactos.'
      : !result.isNew
        ? 'Esa referencia ya fue utilizada en otra compra.'
        : `El monto del pago (${result.reportedAmountBs} Bs) no coincide con el de la orden (${order.pricing.totalBs} Bs).`;

    await orders().doc(orderId).set(
      {
        status: 'payment_rejected',
        // Sólo los campos que cambian: `merge: true` fusiona los mapas campo a
        // campo. Volver a escribir `...order.payment` pisaría `attempts` con el
        // valor que tenía ANTES del incremento de más arriba, dejando el
        // contador siempre en cero y anulando el tope de intentos.
        payment: { reference, providerResponse: result.raw },
        updatedAt: now(),
      },
      { merge: true }
    );

    await Promise.all([
      addEvent({
        orderId,
        type: 'payment_rejected',
        message: reason,
        status: 'payment_rejected',
        data: { reportedAmountBs: result.reportedAmountBs },
      }),
      stats.trackEvent({ type: 'payment_rejected', order }),
      audit.record({
        action: audit.ACTIONS.ORDER_PAYMENT_REJECTED,
        actorUid: user.uid,
        actorEmail: user.email,
        targetType: 'order',
        targetId: orderId,
        summary: `Pago rechazado en la orden ${order.code}: ${reason}`,
        ip,
      }),
    ]);

    throw paymentRejected(reason, { canRetry: true });
  }

  // --- Pago confirmado ---
  await orders().doc(orderId).set(
    {
      status: 'paid',
      // Igual que arriba: nada de esparcir el objeto viejo, o `attempts` vuelve
      // a cero.
      payment: {
        reference,
        verifiedAt: now(),
        providerResponse: result.raw,
      },
      updatedAt: now(),
    },
    { merge: true }
  );

  await Promise.all([
    addEvent({
      orderId,
      type: 'payment_verified',
      message: 'Pago verificado correctamente.',
      status: 'paid',
      data: { reportedAmountBs: result.reportedAmountBs },
    }),
    audit.record({
      action: audit.ACTIONS.ORDER_PAYMENT_VERIFIED,
      actorUid: user.uid,
      actorEmail: user.email,
      targetType: 'order',
      targetId: orderId,
      summary: `Pago verificado en la orden ${order.code} (${order.pricing.totalBs} Bs).`,
      ip,
    }),
    catalog.decrementStock(order.productId, order.pricing.quantity),
    order.pricing.couponCode
      ? couponsService.consume(order.pricing.couponCode)
      : Promise.resolve(),
  ]);

  // --- Entrega ---
  if (order.fulfillment === 'auto') {
    await dispatchService.dispatchOrder(orderId);
  } else {
    await dispatchService.prepareManualOrder(orderId);
  }

  const updated = await getOrder(orderId);
  return {
    order: updated,
    verified: true,
    message:
      updated.status === 'completed'
        ? '¡Pago verificado y recarga entregada!'
        : updated.status === 'awaiting_manual'
          ? 'Pago verificado. Continúa por WhatsApp para recibir tu producto.'
          : 'Pago verificado. Estamos procesando tu entrega.',
  };
}

// ---------------------------------------------------------------------------
// Acciones sobre la orden
// ---------------------------------------------------------------------------

export async function cancelOrder(user: AuthUser, orderId: string): Promise<Order> {
  const order = await getOrderFor(orderId, user);

  if (!['awaiting_payment', 'payment_rejected'].includes(order.status)) {
    throw failedPrecondition('Esta orden ya no se puede cancelar.');
  }

  await orders().doc(orderId).set({ status: 'cancelled', updatedAt: now() }, { merge: true });
  await addEvent({
    orderId,
    type: 'cancelled',
    message: 'Orden cancelada por el cliente.',
    status: 'cancelled',
    actor: 'customer',
    actorUid: user.uid,
  });

  return getOrder(orderId);
}

/** Reintento de despacho lanzado desde el panel. */
export async function retryDispatch(actor: AuthUser, orderId: string): Promise<Order> {
  const order = await getOrder(orderId);

  if (order.fulfillment !== 'auto') {
    throw failedPrecondition('Sólo las órdenes automáticas se pueden reintentar.');
  }
  if (!['failed', 'paid', 'dispatching'].includes(order.status)) {
    throw failedPrecondition('Esta orden no está en un estado que permita reintentar.');
  }

  await audit.record({
    action: audit.ACTIONS.ORDER_RETRIED,
    actorUid: actor.uid,
    actorEmail: actor.email,
    targetType: 'order',
    targetId: orderId,
    summary: `Reintento manual del despacho de la orden ${order.code}.`,
  });

  await dispatchService.dispatchOrder(orderId, { actorUid: actor.uid, isRetry: true });
  return getOrder(orderId);
}

/** Cierre manual: el admin entregó el producto por fuera del API. */
export async function markCompleted(
  actor: AuthUser,
  orderId: string,
  note: string | null
): Promise<Order> {
  const order = await getOrder(orderId);

  if (order.status === 'completed') return order;
  if (!['paid', 'dispatching', 'failed', 'awaiting_manual'].includes(order.status)) {
    throw failedPrecondition('Sólo se pueden completar órdenes ya pagadas.');
  }

  await orders().doc(orderId).set(
    {
      status: 'completed',
      adminNote: note ?? order.adminNote,
      dispatch: { ...order.dispatch, completedAt: now() },
      updatedAt: now(),
    },
    { merge: true }
  );

  await Promise.all([
    addEvent({
      orderId,
      type: 'completed_manually',
      message: note ? `Entregado manualmente: ${note}` : 'Entregado manualmente por el equipo.',
      status: 'completed',
      actor: 'admin',
      actorUid: actor.uid,
    }),
    notifications.notify({
      uid: order.uid,
      title: '¡Tu recarga fue entregada! 🎮',
      body: `${order.productName} ya está acreditado en ${order.playerId}.`,
      type: 'order',
      link: `/orden/${orderId}`,
    }),
    usersService.registerCompletedPurchase(order.uid, order.pricing.totalUsd),
    stats.trackEvent({ type: 'order_completed', order: { ...order, status: 'completed' } }),
    audit.record({
      action: audit.ACTIONS.ORDER_COMPLETED_MANUALLY,
      actorUid: actor.uid,
      actorEmail: actor.email,
      targetType: 'order',
      targetId: orderId,
      summary: `Orden ${order.code} completada manualmente.`,
      data: { note },
    }),
  ]);

  return getOrder(orderId);
}

/**
 * Reembolso. Acredita el total al saldo del usuario y libera la referencia para
 * que el equipo pueda reprocesarla si hace falta.
 */
export async function refundOrder(
  actor: AuthUser,
  orderId: string,
  options: { toWallet: boolean; note: string | null }
): Promise<Order> {
  const order = await getOrder(orderId);

  if (!['paid', 'dispatching', 'failed', 'awaiting_manual', 'completed'].includes(order.status)) {
    throw failedPrecondition('Sólo se pueden reembolsar órdenes pagadas.');
  }

  if (options.toWallet) {
    await usersService.adjustWallet(order.uid, order.pricing.totalUsd);
  }

  await orders().doc(orderId).set(
    { status: 'refunded', adminNote: options.note ?? order.adminNote, updatedAt: now() },
    { merge: true }
  );

  await Promise.all([
    addEvent({
      orderId,
      type: 'refunded',
      message: options.toWallet
        ? `Reembolsado $${order.pricing.totalUsd.toFixed(2)} al saldo del usuario.`
        : 'Orden marcada como reembolsada.',
      status: 'refunded',
      actor: 'admin',
      actorUid: actor.uid,
    }),
    notifications.notify({
      uid: order.uid,
      title: 'Orden reembolsada',
      body: options.toWallet
        ? `Acreditamos $${order.pricing.totalUsd.toFixed(2)} a tu saldo.`
        : `Tu orden ${order.code} fue reembolsada.`,
      type: 'order',
      link: `/orden/${orderId}`,
    }),
    stats.trackEvent({ type: 'order_refunded', order }),
    audit.record({
      action: audit.ACTIONS.ORDER_REFUNDED,
      actorUid: actor.uid,
      actorEmail: actor.email,
      targetType: 'order',
      targetId: orderId,
      summary: `Orden ${order.code} reembolsada${options.toWallet ? ' al saldo' : ''}.`,
      data: { amountUsd: order.pricing.totalUsd, note: options.note },
    }),
  ]);

  return getOrder(orderId);
}

export async function setAdminNote(
  actor: AuthUser,
  orderId: string,
  note: string
): Promise<Order> {
  await orders().doc(orderId).set({ adminNote: note, updatedAt: now() }, { merge: true });
  await audit.record({
    action: audit.ACTIONS.ORDER_NOTE_UPDATED,
    actorUid: actor.uid,
    actorEmail: actor.email,
    targetType: 'order',
    targetId: orderId,
    summary: 'Nota interna actualizada.',
  });
  return getOrder(orderId);
}

/**
 * Marca como expiradas las órdenes que nunca se pagaron.
 * La ejecuta la tarea programada cada 15 minutos.
 */
export async function expireStaleOrders(limit = 200): Promise<number> {
  const snap = await orders()
    .where('status', '==', 'awaiting_payment')
    .where('expiresAt', '<', now())
    .limit(limit)
    .get();

  if (snap.empty) return 0;

  const batch = db.batch();
  const timestamp = now();
  snap.docs.forEach((doc) => batch.set(doc.ref, { status: 'expired', updatedAt: timestamp }, { merge: true }));
  await batch.commit();

  log.info('Órdenes expiradas', { count: snap.size });
  return snap.size;
}
