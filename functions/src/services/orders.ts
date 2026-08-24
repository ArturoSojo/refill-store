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
import { db, orders, paymentRefs, now, minutesFromNow } from '../config/firebase';
import {
  failedPrecondition,
  forbidden,
  invalidArgument,
  maintenance,
  notFound,
  paymentRejected,
} from '../lib/errors';
import { generateOrderCode, normalizeReference } from '../lib/ids';
import { paginate, type Page } from '../lib/pagination';
import { describeOrder } from '../lib/orderItem';
import { checkAmount, round, usdToBs } from '../lib/money';
import { log } from '../lib/logger';
import * as catalog from './catalog';
import * as couponsService from './coupons';
import * as creatorsService from './creators';
import * as pabilo from './pabilo';
import * as dispatchService from './dispatch';
import * as audit from './audit';
import * as notifications from './notifications';
import * as adminAlerts from './adminAlerts';
import { sendOrderEmail } from './orderEmails';
import * as stats from './stats';
import * as usersService from './users';
import { addEvent } from './orderEvents';
import { getConfig } from './settings';
import { buildCallPlan } from './dispatch';
import type { AuthUser } from '../middleware/auth';
import type {
  Order,
  OrderCreatorRef,
  OrderPricing,
  OrderStatus,
  PaymentMethod,
  UserProfile,
} from '../types/models';

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
  /** Cursor opaco devuelto por la página anterior. */
  cursor?: string;
}

/** Aplica los filtros comunes, sin ordenar ni limitar. */
function ordersQuery(options: Omit<ListOrdersOptions, 'limit' | 'cursor'>): Query {
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

  return query;
}

/** Una página de órdenes, con el cursor para pedir la siguiente. */
export async function listOrdersPage(
  options: ListOrdersOptions & { withTotal?: boolean }
): Promise<Page<Order>> {
  return paginate(
    ordersQuery(options),
    {
      orderBy: 'createdAt',
      limit: options.limit,
      cursor: options.cursor,
      withTotal: options.withTotal,
    },
    (id, data) => ({ id, ...data }) as Order
  );
}

/** Lista simple, para usos internos que no pintan una tabla (CSV, fichas). */
export async function listOrders(options: ListOrdersOptions): Promise<Order[]> {
  const snap = await ordersQuery(options)
    .orderBy('createdAt', 'desc')
    .limit(options.limit)
    .get();

  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Order);
}

/**
 * Vista de la orden para el cliente: sin la nota interna, sin los metadatos
 * anti-fraude y, sobre todo, sin el costo ni la utilidad del negocio.
 */
export type CustomerOrder = Omit<Order, 'adminNote' | 'meta' | 'creator' | 'pricing'> & {
  pricing: Omit<OrderPricing, 'costUsd' | 'profitUsd'>;
};

export function toCustomerOrder(order: Order): CustomerOrder {
  // `creator` lleva el porcentaje de comisión pactado: es un acuerdo entre la
  // tienda y el creador, no algo que el comprador tenga que ver. El código sí
  // se queda en `pricing.creatorCode`, porque el cliente lo escribió.
  const {
    adminNote: _adminNote,
    meta: _meta,
    creator: _creator,
    pricing: fullPricing,
    ...rest
  } = order;
  const { costUsd: _costUsd, profitUsd: _profitUsd, ...pricing } = fullPricing;
  return { ...rest, pricing };
}

export interface PaymentInstructions {
  /** Con qué método se creó la orden: decide qué datos pinta la tienda. */
  method: Order['payment']['method'];
  bank: Order['payment']['bankSnapshot'];
  amountBs: number;
  amountUsd: number;
  walletAppliedUsd: number;
  rate: number;
  expiresAt: number;
  referenceMinLength: number;
  referenceMaxLength: number;
}

/**
 * Instrucciones de pago de una orden.
 *
 * Se extrajo de la ruta de creación porque el cliente también las necesita al
 * RETOMAR una orden pendiente: antes, «Completar el pago» arrancaba un checkout
 * nuevo desde cero y volvía a pedir el ID.
 */
export function toPaymentInstructions(
  order: Order,
  config: { checkout: { referenceMinLength: number; referenceMaxLength: number } }
): PaymentInstructions {
  return {
    method: order.payment.method,
    bank: order.payment.bankSnapshot,
    amountBs: order.pricing.totalBs,
    amountUsd: order.pricing.amountDueUsd ?? order.pricing.totalUsd,
    walletAppliedUsd: order.pricing.walletAppliedUsd ?? 0,
    rate: order.pricing.rate,
    expiresAt: order.expiresAt.toMillis(),
    referenceMinLength: config.checkout.referenceMinLength,
    referenceMaxLength: config.checkout.referenceMaxLength,
  };
}

// ---------------------------------------------------------------------------
// Creación
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  gameId: string;
  productId: string;
  /**
   * Datos del comprador por clave de campo (`{ playerId, zoneId }`).
   * Se acepta también una cadena suelta por compatibilidad con clientes viejos.
   */
  playerFields: Record<string, string> | string;
  quantity: number;
  couponCode?: string | null;
  /** Código del creador de contenido que trajo la venta. */
  creatorCode?: string | null;
  /** Cómo va a pagar. Por defecto, Pago Móvil. */
  paymentMethod?: PaymentMethod;
  /** Teléfono de contacto, cuando el producto manual lo pide. */
  contactPhone?: string | null;
  /** Descontar del saldo a favor lo que alcance. */
  useWallet?: boolean;
  customerNote?: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Caduca las órdenes impagas ya vencidas de un usuario.
 *
 * Se llama justo antes del tope de órdenes abiertas: sin esto, una orden que
 * venció hace horas seguía contando y el cliente quedaba bloqueado hasta que
 * pasara la tarea programada. Devuelve cuántas cerró.
 */
async function expireOwnStaleOrders(uid: string): Promise<number> {
  const snap = await orders()
    .where('uid', '==', uid)
    .where('status', 'in', ['awaiting_payment', 'payment_rejected'])
    .limit(20)
    .get();

  const stale = snap.docs.filter((doc) => {
    const expiresAt = (doc.data() as Order).expiresAt;
    return expiresAt && expiresAt.toMillis() < Date.now();
  });

  await Promise.all(stale.map((doc) => expireOrder({ id: doc.id, ...doc.data() } as Order)));
  return stale.length;
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
  const playerData = catalog.resolvePlayerData(input.playerFields, game);

  if (product.fulfillment === 'manual' && !config.features.manualProductsEnabled) {
    throw failedPrecondition('Los productos manuales están desactivados temporalmente.');
  }

  if (product.stock !== null && product.stock < input.quantity) {
    throw failedPrecondition(`Sólo quedan ${product.stock} unidades de ese producto.`);
  }

  // Evita que un usuario acumule órdenes sin pagar y bloquee el inventario.
  // Antes de contar se cierran las que ya vencieron: si no, una orden muerta
  // hace horas seguiría ocupando cupo hasta el siguiente barrido programado.
  await expireOwnStaleOrders(user.uid);

  const openOrders = await orders()
    .where('uid', '==', user.uid)
    .where('status', 'in', ['awaiting_payment', 'verifying', 'payment_rejected'])
    .count()
    .get();

  if (openOrders.data().count >= config.checkout.maxOpenOrdersPerUser) {
    throw failedPrecondition(
      `Tienes ${openOrders.data().count} órdenes sin pagar. Complétalas o cancélalas antes de crear otra.`,
      { code: 'too_many_open_orders', openOrders: openOrders.data().count }
    );
  }

  // --- Precios ---
  const quantity = Math.max(1, Math.min(10, Math.trunc(input.quantity)));
  const unitUsd = round(product.priceUsd, 2);
  const subtotalUsd = round(unitUsd * quantity, 2);

  let discountUsd = 0;
  let couponCode: string | null = null;

  // Descuento por nivel de fidelidad (siempre aplica, no requiere cupón).
  const tierPercent = await usersService.tierDiscountPercent(profile.tier);
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
      playerId: playerData.playerId,
    });
    discountUsd = round(discountUsd + evaluation.discountUsd, 2);
    couponCode = evaluation.coupon.code;
  }

  // El método sólo importa para saber qué datos mostrarle al cliente: ambos
  // entran a la misma cuenta y Pabilo los verifica con la misma consulta.
  const wantsTransfer = input.paymentMethod === 'transfer' && config.transfer.enabled;
  if (input.paymentMethod === 'transfer' && !config.transfer.enabled) {
    throw failedPrecondition('La transferencia bancaria no está disponible ahora mismo.');
  }

  // Sólo se guarda si el producto lo pide: un teléfono suelto en órdenes que
  // no lo necesitan es un dato personal de más.
  const contactPhone =
    product.fulfillment === 'manual' && product.manualFlow === 'phone'
      ? (input.contactPhone?.trim() || null)
      : null;

  if (product.fulfillment === 'manual' && product.manualFlow === 'phone' && !contactPhone) {
    throw invalidArgument('Necesitamos tu número de teléfono para entregarte este producto.');
  }

  // El código de creador va en su propio carril, no en el del cupón: así el
  // cliente puede usar una promo y el código de su creador a la vez.
  let creatorRef: OrderCreatorRef | null = null;
  if (input.creatorCode && config.features.creatorsEnabled) {
    const resolved = await creatorsService.resolveForPurchase(input.creatorCode, user.uid);
    creatorRef = resolved.ref;
    if (resolved.creator.discountPercent > 0) {
      discountUsd = round(discountUsd + (subtotalUsd * resolved.creator.discountPercent) / 100, 2);
    }
  }

  // Nunca por debajo de un céntimo: el monto debe poder pagarse y verificarse.
  discountUsd = Math.min(discountUsd, round(subtotalUsd - 0.01, 2));
  const totalUsd = round(subtotalUsd - discountUsd, 2);
  const rate = config.rate.value;
  const costUsd = round(product.costUsd * quantity, 4);

  // --- Saldo a favor ---
  // El débito ocurre AHORA, en una transacción sobre el perfil: si se dejara
  // para el momento del pago, dos compras simultáneas gastarían el mismo saldo.
  // Si la orden se cancela o caduca, se devuelve.
  const walletRequested =
    input.useWallet && config.checkout.walletEnabled !== false
      ? Math.min(round(profile.walletBalanceUsd, 2), totalUsd)
      : 0;

  let walletAppliedUsd = Math.max(0, round(walletRequested, 2));
  // Un resto de céntimos no se puede transferir ni verificar contra el banco:
  // si el saldo casi cubre el total, se cubre entero.
  let amountDueUsd = round(totalUsd - walletAppliedUsd, 2);
  if (amountDueUsd > 0 && amountDueUsd < 0.01) {
    walletAppliedUsd = totalUsd;
    amountDueUsd = 0;
  }

  const paidWithWallet = walletAppliedUsd > 0 && amountDueUsd === 0;

  const paymentMethod: PaymentMethod = paidWithWallet
    ? 'wallet'
    : wantsTransfer
      ? 'transfer'
      : 'pagomovil_bdv';

  /** Congela los datos que se le muestran al cliente para este método. */
  const bankSnapshot = () =>
    paymentMethod === 'transfer'
      ? {
          code: config.transfer.code,
          name: config.transfer.name,
          idNumber: config.transfer.idNumber,
          // El Pago Móvil no aplica aquí, pero el campo existe en el modelo.
          phone: '',
          accountNumber: config.transfer.accountNumber,
          accountType: config.transfer.accountType,
        }
      : {
          code: config.bank.code,
          name: config.bank.name,
          idNumber: config.bank.idNumber,
          phone: config.bank.phone,
        };

  const totalBs = usdToBs(amountDueUsd, rate, config.pricing.roundToBs);

  const orderRef = orders().doc();
  const timestamp = now();

  if (walletAppliedUsd > 0) {
    // Lanza si el saldo ya no alcanza (otra compra lo consumió mientras tanto).
    await usersService.moveWallet({
      uid: user.uid,
      deltaUsd: -walletAppliedUsd,
      reason: `Pago de la orden ${product.name}`,
      orderId: orderRef.id,
    });
  }

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
    productAmount: product.amount,
    productBonus: product.bonus,
    fulfillment: product.fulfillment,
    playerId: playerData.playerId,
    playerId2: playerData.playerId2,
    playerFields: playerData.values,
    pricing: {
      unitUsd,
      quantity,
      subtotalUsd,
      discountUsd,
      totalUsd,
      walletAppliedUsd,
      amountDueUsd,
      rate,
      totalBs,
      couponCode,
      creatorCode: creatorRef?.code ?? null,
      costUsd,
      profitUsd: round(totalUsd - costUsd, 4),
    },
    creator: creatorRef,
    contactPhone,
    emailsSent: [],
    payment: {
      method: paymentMethod,
      reference: null,
      reportedAmountBs: null,
      verifiedAt: paidWithWallet ? timestamp : null,
      attempts: 0,
      providerResponse: null,
      bankSnapshot: bankSnapshot(),
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
    // Pagada con saldo: no hay transferencia que verificar, así que entra
    // directamente en la cola de entrega.
    status: paidWithWallet ? 'paid' : 'awaiting_payment',
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
      message: paidWithWallet
        ? `Orden creada y pagada con tu saldo a favor ($${walletAppliedUsd.toFixed(2)}).`
        : walletAppliedUsd > 0
          ? `Orden creada por ${order.pricing.totalBs.toFixed(2)} Bs (se aplicaron $${walletAppliedUsd.toFixed(2)} de saldo).`
          : `Orden creada por ${order.pricing.totalBs.toFixed(2)} Bs.`,
      status: order.status,
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
      summary: `Orden ${order.code}: ${describeOrder({ ...order, id: orderRef.id })} para ${order.playerId}.`,
      data: { totalUsd, totalBs, rate, walletAppliedUsd },
      ip: input.ip,
    }),
  ]);

  log.info('Orden creada', { orderId: orderRef.id, code: order.code, totalBs, walletAppliedUsd });

  if (paidWithWallet) {
    await Promise.all([
      catalog.decrementStock(product.id, quantity),
      couponCode ? couponsService.consume(couponCode) : Promise.resolve(),
    ]);

    if (product.fulfillment === 'auto') {
      await dispatchService.dispatchOrder(orderRef.id);
    } else {
      await dispatchService.prepareManualOrder(orderRef.id);
    }

    return getOrder(orderRef.id);
  }

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

/**
 * Estados en los que el dinero del cliente ya entró.
 *
 * Volver a verificar en cualquiera de ellos es inofensivo y debe responder
 * bien: el pago está hecho y lo único que falta —si falta algo— es la entrega.
 */
const PAID_STATES: OrderStatus[] = [
  'verifying',
  'paid',
  'dispatching',
  'awaiting_manual',
  'completed',
  'failed',
];

export async function verifyPayment(
  user: AuthUser,
  orderId: string,
  rawReference: string,
  ip: string | null
): Promise<VerifyPaymentResult> {
  const config = await getConfig();
  const order = await getOrderFor(orderId, user);

  if (order.uid !== user.uid) throw forbidden('Esa orden no es tuya.');

  // Reintentar la verificación cuando el pago YA entró no es un error del
  // cliente: es lo que hace cualquiera cuando la petición anterior se le cortó
  // a medias. La entrega puede tardar más que el tope del proxy (26 s), así que
  // el navegador se queda sin respuesta mientras el servidor sigue trabajando;
  // el cliente vuelve a pulsar y, si esto lanzara, leería «esta orden ya no
  // admite verificación» justo cuando todo va bien.
  //
  // Se responde con el estado real y `verified: true`, para que la pantalla
  // siga esperando la entrega en vez de pintar un fallo.
  if (PAID_STATES.includes(order.status)) {
    return {
      order,
      verified: true,
      message:
        order.status === 'completed'
          ? 'Tu pago ya estaba verificado y la recarga fue entregada.'
          : order.status === 'failed'
            ? 'Tu pago está confirmado. La entrega falló y el equipo ya la está revisando.'
            : order.status === 'awaiting_manual'
              ? 'Tu pago ya estaba verificado. El equipo está preparando tu recarga.'
              : 'Tu pago ya estaba verificado. Estamos entregando tu recarga.',
    };
  }

  if (!['awaiting_payment', 'payment_rejected'].includes(order.status)) {
    throw failedPrecondition('Esta orden ya no admite verificación de pago.');
  }

  if (order.expiresAt.toMillis() < Date.now()) {
    await expireOrder(order);
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
  //
  // Quién comprueba el monto depende de cómo respondió Pabilo:
  //
  //  - `amountVerifiedByProvider`: la búsqueda filtrada por monto encontró el
  //    movimiento, así que el importe coincide exacto.
  //  - Si no, el movimiento se localizó SIN filtrar por monto y la comprobación
  //    la hace `checkAmount`: sólo pasa si lo transferido cubre el total. En ese
  //    caso el monto real es imprescindible; sin él no hay nada que comparar y
  //    se rechaza, porque aceptar a ciegas dejaría pasar cualquier importe.
  const amountCheck =
    result.reportedAmountBs === null
      ? null
      : checkAmount(
          order.pricing.totalBs,
          result.reportedAmountBs,
          config.checkout.amountTolerancePercent
        );

  const amountOk = result.amountVerifiedByProvider
    ? true
    : amountCheck !== null && amountCheck.ok;

  if (!result.isNew || !amountOk) {
    await releaseReferenceLock(reference);

    const reason = !result.found
      ? 'No encontramos ningún pago con esa referencia. Revisa que la hayas copiado completa.'
      : !result.isNew
        ? 'Esa referencia ya fue utilizada en otra compra.'
        : amountCheck === null
          ? 'No pudimos leer el monto de ese pago. Escríbenos por WhatsApp y lo revisamos.'
          : `Ese pago es de ${result.reportedAmountBs!.toFixed(2)} Bs y la orden es de ` +
            `${order.pricing.totalBs.toFixed(2)} Bs: faltan ` +
            `${amountCheck.shortfallBs.toFixed(2)} Bs. Transfiere el monto exacto y ` +
            'verifica con esa nueva referencia.';

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
      adminAlerts.alert({
        kind: 'payment_rejected',
        severity: 'info',
        title: `Pago rechazado · ${order.code}`,
        body: `${order.user.email ?? 'Un cliente'} intentó pagar ${describeOrder(order)}. ${reason}`,
        link: `/admin/ordenes/${orderId}`,
        data: { code: order.code, reference: `***${reference.slice(-4)}` },
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
        reportedAmountBs: result.reportedAmountBs,
        verifiedAt: now(),
        providerResponse: result.raw,
      },
      updatedAt: now(),
    },
    { merge: true }
  );

  // Pagó de más: la orden se acepta igual (está cubierta), pero el excedente no
  // se queda callado. Es dinero del cliente y el equipo decide si se lo abona al
  // saldo o se lo devuelve.
  const surplusBs = amountCheck?.surplusBs ?? 0;
  const surplusIsRelevant = surplusBs > (amountCheck?.alertAboveBs ?? 0);

  await Promise.all([
    addEvent({
      orderId,
      type: 'payment_verified',
      message: surplusIsRelevant
        ? `Pago verificado. Transferiste ${surplusBs.toFixed(2)} Bs de más; ya lo estamos revisando.`
        : 'Pago verificado correctamente.',
      status: 'paid',
      data: { reportedAmountBs: result.reportedAmountBs, surplusBs },
    }),
    audit.record({
      action: audit.ACTIONS.ORDER_PAYMENT_VERIFIED,
      actorUid: user.uid,
      actorEmail: user.email,
      targetType: 'order',
      targetId: orderId,
      summary: `Pago verificado en la orden ${order.code} (${order.pricing.totalBs} Bs).`,
      data: { reportedAmountBs: result.reportedAmountBs, surplusBs },
      ip,
    }),
    catalog.decrementStock(order.productId, order.pricing.quantity),
    order.pricing.couponCode
      ? couponsService.consume(order.pricing.couponCode)
      : Promise.resolve(),
    surplusIsRelevant
      ? adminAlerts.alert({
          kind: 'payment_rejected',
          severity: 'info',
          title: `Pagaron de más · ${order.code}`,
          body: [
            `${order.user.email ?? 'Un cliente'} transfirió ${result.reportedAmountBs?.toFixed(2)} Bs`,
            `para una orden de ${order.pricing.totalBs.toFixed(2)} Bs.`,
            `Sobran ${surplusBs.toFixed(2)} Bs: puedes abonárselos al saldo desde su ficha.`,
          ].join(' '),
          link: `/admin/ordenes/${orderId}`,
          data: { code: order.code, surplusBs, reportedAmountBs: result.reportedAmountBs },
        })
      : Promise.resolve(),
  ]);

  // Sin `await`: el comprobante no debe retrasar la respuesta al cliente, que
  // está esperando ver si su recarga salió.
  void sendOrderEmail('payment_verified', orderId);

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

/**
 * Devuelve a la cartera el saldo que se descontó al crear la orden.
 *
 * Se llama al cancelar y al caducar. Es idempotente por bandera: se marca
 * `pricing.walletRefunded` para que un segundo cierre de la misma orden no
 * regale el saldo dos veces.
 */
async function refundWalletIfApplied(order: Order, reason: string): Promise<number> {
  const applied = order.pricing?.walletAppliedUsd ?? 0;
  const alreadyRefunded = (order.pricing as { walletRefunded?: boolean })?.walletRefunded === true;
  if (applied <= 0 || alreadyRefunded) return 0;

  await usersService.moveWallet({
    uid: order.uid,
    deltaUsd: applied,
    reason,
    orderId: order.id,
    orderCode: order.code,
  });

  await orders()
    .doc(order.id)
    .set({ pricing: { walletRefunded: true }, updatedAt: now() }, { merge: true });

  return applied;
}

/** Cierra una orden impaga y devuelve el saldo que hubiera consumido. */
async function expireOrder(order: Order): Promise<void> {
  const refunded = await refundWalletIfApplied(order, `Orden ${order.code} caducada`);

  await orders()
    .doc(order.id)
    .set({ status: 'expired', updatedAt: now() }, { merge: true });

  await addEvent({
    orderId: order.id,
    type: 'expired',
    message: refunded > 0
      ? `Orden caducada por falta de pago. Se devolvieron $${refunded.toFixed(2)} a tu saldo.`
      : 'Orden caducada: no se recibió el pago dentro del tiempo límite.',
    status: 'expired',
  });
}

export async function cancelOrder(user: AuthUser, orderId: string): Promise<Order> {
  const order = await getOrderFor(orderId, user);

  if (!['awaiting_payment', 'payment_rejected'].includes(order.status)) {
    throw failedPrecondition('Esta orden ya no se puede cancelar.');
  }

  const refunded = await refundWalletIfApplied(order, `Orden ${order.code} cancelada`);

  await orders().doc(orderId).set({ status: 'cancelled', updatedAt: now() }, { merge: true });
  await addEvent({
    orderId,
    type: 'cancelled',
    message: refunded > 0
      ? `Orden cancelada. Se devolvieron $${refunded.toFixed(2)} a tu saldo.`
      : 'Orden cancelada por el cliente.',
    status: 'cancelled',
    actor: order.uid === user.uid ? 'customer' : 'admin',
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

  // El cliente recibe el mismo comprobante de entrega tanto si la despachó el
  // proveedor como si la completó el equipo a mano.
  void sendOrderEmail('delivered', orderId);

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
      body: `${describeOrder(order)} ya está acreditado en ${order.playerId}.`,
      type: 'order',
      link: `/orden/${orderId}`,
    }),
    usersService.registerCompletedPurchase(order.uid, order.pricing.totalUsd),
    // Idempotente: si el despacho automático ya la devengó, ésta no hace nada.
    creatorsService.accrueCommission(order),
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
    await usersService.adjustWallet(order.uid, order.pricing.totalUsd, {
      reason: `Reembolso de la orden ${order.code}`,
      orderId: order.id,
      orderCode: order.code,
      actorUid: actor.uid,
    });
  }

  // La venta deja de existir: la comisión del creador también.
  await creatorsService.revertCommission(order);

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
 *
 * La ejecuta la tarea programada. Incluye `payment_rejected` a propósito: una
 * orden con la referencia rechazada seguía viva para siempre y ocupaba cupo del
 * tope de órdenes abiertas, que es justo lo que dejaba al cliente bloqueado.
 *
 * No se hace en lote porque cada orden puede tener saldo que devolver, y eso
 * exige una transacción por usuario.
 */
export async function expireStaleOrders(limit = 200): Promise<number> {
  const snap = await orders()
    .where('status', 'in', ['awaiting_payment', 'payment_rejected'])
    .where('expiresAt', '<', now())
    .limit(limit)
    .get();

  if (snap.empty) return 0;

  for (const doc of snap.docs) {
    try {
      await expireOrder({ id: doc.id, ...doc.data() } as Order);
    } catch (error) {
      log.warn('No se pudo caducar una orden', {
        orderId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info('Órdenes expiradas', { count: snap.size });
  return snap.size;
}
