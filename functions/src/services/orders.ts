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
import { resolveWebUserForWhatsappOrder } from './whatsappSync';
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
export type CustomerOrder = Omit<
  Order,
  'adminNote' | 'meta' | 'creator' | 'pricing' | 'costoProveedorUsd' | 'gananciaNetaUsd'
> & {
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
    costoProveedorUsd: _costoProveedorUsd,
    gananciaNetaUsd: _gananciaNetaUsd,
    pricing: fullPricing,
    ...rest
  } = order;
  const { costUsd: _costUsd, profitUsd: _profitUsd, ...pricing } = fullPricing;
  return {
    ...rest,
    deliveredCodes: order.status === 'completed' ? order.deliveredCodes ?? [] : [],
    pricing,
  };
}

export interface PaymentInstructions {
  /** Con qué método se creó la orden: decide qué datos pinta la tienda. */
  method: Order['payment']['method'];
  bank: Order['payment']['bankSnapshot'];
  /** Lo que queda por transferir. Si hubo pagos parciales, ya va descontado. */
  amountBs: number;
  /** Total de la orden, para poder decir «van X de Y». */
  totalBs: number;
  /** Suma de los pagos parciales ya acreditados. */
  paidBs: number;
  partials: Order['payment']['partials'];
  amountUsd: number;
  /** Total pendiente tras aplicar saldo, en USD (Binance lo cobra en USDT). */
  totalUsd: number;
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
  const paidBs = round(order.payment.paidBs ?? 0, 2);
  const totalUsd = order.pricing.amountDueUsd ?? order.pricing.totalUsd;
  const paidUsd = order.pricing.rate > 0 ? round(paidBs / order.pricing.rate, 2) : 0;

  return {
    method: order.payment.method,
    bank: order.payment.bankSnapshot,
    // Lo pendiente, no el total: si ya abonó algo, pedirle el total otra vez
    // es justo lo que hacía que perdiera el dinero anterior.
    amountBs: round(order.pricing.totalBs - paidBs, 2),
    totalBs: order.pricing.totalBs,
    paidBs,
    partials: order.payment.partials ?? [],
    amountUsd: round(Math.max(0, totalUsd - paidUsd), 2),
    totalUsd,
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
  clientPlatform?: 'web' | 'app';
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
      clientPlatform: input.clientPlatform ?? 'web',
    });
    discountUsd = round(discountUsd + evaluation.discountUsd, 2);
    couponCode = evaluation.coupon.code;
  }

  // Cada método muestra y verifica su propia cuenta receptora.
  const wantsTransfer = input.paymentMethod === 'transfer' && config.transfer.enabled;
  const wantsBinancePay = input.paymentMethod === 'binance_pay' && config.binancePay.enabled;
  if (input.paymentMethod === 'transfer' && !config.transfer.enabled) {
    throw failedPrecondition('La transferencia bancaria no está disponible ahora mismo.');
  }
  if (input.paymentMethod === 'binance_pay' && !config.binancePay.enabled) {
    throw failedPrecondition('Binance Pay no está disponible ahora mismo.');
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
      : wantsBinancePay
        ? 'binance_pay'
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
      : paymentMethod === 'binance_pay'
        ? { code: '', name: 'Binance Pay', idNumber: '', phone: '', binancePayId: config.binancePay.payId }
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

  const plannedCalls =
    product.fulfillment === 'auto'
      ? Array.from({ length: quantity }, () => buildCallPlan(product.calls))
          .flat()
          .map((call, index) => ({ ...call, index }))
      : [];
  const productIds = product.calls.flatMap((c) =>
    Array.from({ length: Math.max(1, c.quantity * quantity) }, () => c.packageId)
  );

  const order: Omit<Order, 'id'> = {
    code: generateOrderCode(),
    uid: user.uid,
    userId: user.uid,
    canal: 'WEB',
    origen: 'WEB',
    clienteContacto: contactPhone ?? user.email ?? '',
    juego: game.name,
    paqueteNombre: product.name,
    productIds,
    montoBs: totalBs,
    tasaBcv: rate,
    montoUsd: totalUsd,
    costoProveedorUsd: costUsd,
    gananciaNetaUsd: round(totalUsd - costUsd, 4),
    tipoDespacho: product.fulfillment === 'auto' ? 'AUTOMATICO' : 'MANUAL',
    ...(paidWithWallet
      ? { estado: product.fulfillment === 'auto' ? 'PAGO_VALIDADO' : 'REVISION_MANUAL' }
      : {}),
    subOrdenes: [],
    user: {
      email: user.email,
      displayName: profile.displayName ?? user.displayName,
      photoURL: profile.photoURL ?? user.photoURL,
    },
    gameId: game.id,
    gameName: game.name,
    providerGameId: game.apiGameId,
    // Queda congelado: cambiar de proveedor mañana no altera una compra ya pagada.
    provider: game.provider ?? 'inefable',
    providerFamily: game.providerFamily ?? 'topup',
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
      partials: [],
      paidBs: 0,
      verifiedAt: paidWithWallet ? timestamp : null,
      attempts: 0,
      providerResponse: null,
      bankSnapshot: bankSnapshot(),
    },
    dispatch: {
      // El plan se calcula ahora y se guarda en la orden: si el admin edita el
      // producto más tarde, esta orden conserva las llamadas que se cotizaron
      // al comprar. Con cantidad > 1 el plan completo se repite.
      calls: plannedCalls,
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

export async function createWalletTopupOrder(
  user: AuthUser,
  profile: UserProfile,
  input: {
    amountUsd: number;
    paymentMethod: PaymentMethod;
    ip: string | null;
    userAgent: string | null;
  }
): Promise<Order> {
  usersService.assertNotBanned(profile);
  const config = await getConfig();

  await expireOwnStaleOrders(user.uid);

  const openOrders = await orders()
    .where('uid', '==', user.uid)
    .where('status', 'in', ['awaiting_payment', 'verifying', 'payment_rejected'])
    .count()
    .get();

  if (openOrders.data().count >= config.checkout.maxOpenOrdersPerUser) {
    throw failedPrecondition(
      `Tienes ${openOrders.data().count} órdenes sin pagar. Complétalas o cancélalas antes de recargar saldo.`,
      { code: 'too_many_open_orders', openOrders: openOrders.data().count }
    );
  }

  const wantsTransfer = input.paymentMethod === 'transfer' && config.transfer.enabled;
  const wantsBinancePay = input.paymentMethod === 'binance_pay' && config.binancePay.enabled;
  if (input.paymentMethod === 'transfer' && !config.transfer.enabled) {
    throw failedPrecondition('La transferencia bancaria no está disponible ahora mismo.');
  }
  if (input.paymentMethod === 'binance_pay' && !config.binancePay.enabled) {
    throw failedPrecondition('Binance Pay no está disponible ahora mismo.');
  }

  const paymentMethod: PaymentMethod = wantsTransfer
    ? 'transfer'
    : wantsBinancePay
      ? 'binance_pay'
      : 'pagomovil_bdv';

  const bankSnapshot =
    paymentMethod === 'transfer'
      ? {
          code: config.transfer.code,
          name: config.transfer.name,
          idNumber: config.transfer.idNumber,
          phone: '',
          accountNumber: config.transfer.accountNumber,
          accountType: config.transfer.accountType,
        }
      : paymentMethod === 'binance_pay'
        ? { code: '', name: 'Binance Pay', idNumber: '', phone: '', binancePayId: config.binancePay.payId }
        : {
            code: config.bank.code,
            name: config.bank.name,
            idNumber: config.bank.idNumber,
            phone: config.bank.phone,
          };

  const rate = config.rate.value;
  const totalBs = usdToBs(input.amountUsd, rate, config.pricing.roundToBs);

  const orderRef = orders().doc();
  const timestamp = now();
  const code = generateOrderCode();

  const order: Omit<Order, 'id'> = {
    code,
    uid: user.uid,
    user: {
      email: user.email ?? null,
      displayName: user.displayName ?? null,
      photoURL: profile.photoURL ?? null,
    },
    gameId: 'wallet',
    gameName: 'Cartera Refill',
    providerGameId: null,
    productId: 'topup',
    productName: `Recarga de saldo ($${input.amountUsd.toFixed(2)})`,
    productSku: 'topup',
    productAmount: input.amountUsd,
    productBonus: 0,
    fulfillment: 'manual', // Prevent auto dispatch
    playerId: user.uid,
    playerId2: null,
    playerFields: { uid: user.uid },
    pricing: {
      unitUsd: input.amountUsd,
      quantity: 1,
      subtotalUsd: input.amountUsd,
      discountUsd: 0,
      totalUsd: input.amountUsd,
      walletAppliedUsd: 0,
      amountDueUsd: input.amountUsd,
      rate,
      totalBs,
      couponCode: null,
      creatorCode: null,
      costUsd: 0,
      profitUsd: 0,
    },
    creator: null,
    contactPhone: profile.phone ?? null,
    emailsSent: [],
    payment: {
      method: paymentMethod,
      reference: null,
      reportedAmountBs: null,
      partials: [],
      paidBs: 0,
      verifiedAt: null,
      attempts: 0,
      providerResponse: null,
      bankSnapshot,
    },
    dispatch: {
      calls: [],
      startedAt: null,
      completedAt: null,
      lastError: null,
    },
    whatsappUrl: null,
    status: 'awaiting_payment',
    customerNote: null,
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
      message: `Orden de recarga de saldo creada por ${totalBs.toFixed(2)} Bs.`,
      status: order.status,
      actor: 'customer',
      actorUid: user.uid,
    }),
    usersService.registerCreatedOrder(user.uid),
    stats.trackEvent({ type: 'order_created', order: { id: orderRef.id, ...order } }),
  ]);

  log.info('Orden de recarga creada', { orderId: orderRef.id, code: order.code, totalBs });

  return { id: orderRef.id, ...order };
}

// ---------------------------------------------------------------------------
// Verificación de pago
// ---------------------------------------------------------------------------

type VerificationClaim =
  | { kind: 'claimed' }
  | { kind: 'in_progress' | 'already_paid'; order: Order }
  | { kind: 'conflict'; conflictOrderCode: string; sameOrder: boolean };

/**
 * Reserva la orden y la referencia en una sola transacción. Dos peticiones de
 * la misma orden nunca deben consultar a Pabilo a la vez: la segunda recibiría
 * is_new=false aunque la primera acabara de verificar el pago correctamente.
 */
async function claimPaymentVerification(
  reference: string,
  order: Order,
  expiresAt: Order['expiresAt'],
  maxAttempts: number
): Promise<VerificationClaim> {
  const orderRef = orders().doc(order.id);
  const referenceRef = paymentRefs().doc(reference);

  return db.runTransaction(async (tx) => {
    const [orderSnap, referenceSnap] = await Promise.all([
      tx.get(orderRef),
      tx.get(referenceRef),
    ]);
    if (!orderSnap.exists) throw notFound('Orden no encontrada.');
    const current = { id: orderSnap.id, ...orderSnap.data() } as Order;
    if (current.uid !== order.uid) throw forbidden('Esa orden no es tuya.');

    if (PAID_STATES.includes(current.status)) return { kind: 'already_paid', order: current };
    if (current.status === 'verifying') return { kind: 'in_progress', order: current };
    if (!['awaiting_payment', 'payment_rejected'].includes(current.status)) {
      throw failedPrecondition('Esta orden ya no admite verificación de pago.');
    }
    if (current.expiresAt.toMillis() < Date.now()) {
      throw failedPrecondition('Esta orden expiró. Crea una nueva con la tasa vigente.');
    }
    if ((current.payment.attempts ?? 0) >= maxAttempts) {
      throw failedPrecondition('Alcanzaste el máximo de intentos de verificación. Contacta al soporte.');
    }

    if (referenceSnap.exists) {
      const data = referenceSnap.data() as { orderId?: string; orderCode?: string } | undefined;
      return {
        kind: 'conflict',
        conflictOrderCode: data?.orderCode ?? '',
        sameOrder: data?.orderId === order.id,
      };
    }

    tx.create(referenceRef, {
      orderId: order.id,
      orderCode: order.code,
      uid: order.uid,
      reference,
      createdAt: now(),
    });
    tx.update(orderRef, {
      status: 'verifying',
      'payment.reference': reference,
      'payment.attempts': FieldValue.increment(1),
      expiresAt: expiresAt.toMillis() > current.expiresAt.toMillis() ? expiresAt : current.expiresAt,
      updatedAt: now(),
    });
    return { kind: 'claimed' };
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

/**
 * Busca si alguna OTRA orden de la tienda ya se encuentra en un estado pagado/despachado
 * con la misma referencia bancaria.
 */
async function findPaidOrderWithReference(
  reference: string,
  excludeOrderId: string
): Promise<{ id: string; code: string } | null> {
  try {
    const [byReferencia, byPaymentRef] = await Promise.all([
      orders().where('referencia', '==', reference).limit(3).get(),
      orders().where('payment.reference', '==', reference).limit(3).get(),
    ]);

    const allDocs = [...byReferencia.docs, ...byPaymentRef.docs];
    for (const doc of allDocs) {
      if (doc.id === excludeOrderId) continue;
      const data = doc.data() as Partial<Order>;
      if (data.status && PAID_STATES.includes(data.status as OrderStatus)) {
        return { id: doc.id, code: data.code ?? doc.id };
      }
    }
  } catch (error) {
    log.warn('Error al buscar órdenes en conflicto por referencia', {
      reference: `***${reference.slice(-4)}`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

/**
 * Comprueba si la orden registra un fallo previo con el verificador (timeout o caída de red).
 */
async function hadProviderErrorEvent(orderId: string, reference?: string): Promise<boolean> {
  try {
    const snap = await orders()
      .doc(orderId)
      .collection('events')
      .where('type', '==', 'payment_provider_error')
      .limit(5)
      .get();
    if (snap.empty) return false;
    if (!reference) return true;
    return snap.docs.some((d) => {
      const data = d.data() as { data?: { reference?: string } };
      return !data.data?.reference || data.data.reference === reference;
    });
  } catch {
    return false;
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
  'paid',
  'dispatching',
  'awaiting_manual',
  'in_review',
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

  if (order.status === 'verifying') {
    return {
      order,
      verified: false,
      message: 'Estamos consultando el banco. La orden se actualizará en unos segundos.',
    };
  }

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
          : order.status === 'in_review' || order.status === 'failed'
            ? 'Estamos procesando tu orden manualmente. Si no se completa en 1 hora, se te devuelve el saldo automáticamente.'
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

  const reference = normalizeReference(rawReference, order.payment.method === 'binance_pay');
  if (
    reference.length < config.checkout.referenceMinLength ||
    reference.length > config.checkout.referenceMaxLength
  ) {
    throw invalidArgument(
      `El código de pago debe tener entre ${config.checkout.referenceMinLength} y ${config.checkout.referenceMaxLength} caracteres.`
    );
  }

  /**
   * Cada referencia nueva reinicia el reloj.
   *
   * Alguien que pagó de menos tiene que volver al banco, transferir la
   * diferencia y traer otra referencia: con el contador corriendo desde la
   * compra, se le acababa el tiempo a mitad del trámite y perdía la orden
   * (y con ella la tasa a la que compró). El tope sigue siendo el número de
   * intentos, así que esto no lo deja abierto para siempre.
   *
   * Sólo se empuja hacia adelante: si la orden ya tenía un margen mayor —una
   * creada cuando el plazo configurado era más largo—, se respeta.
   */
  const yaPagadoBs = round(order.payment.paidBs ?? 0, 2);
  const pendienteBs = round(order.pricing.totalBs - yaPagadoBs, 2);
  const esBinancePay = order.payment.method === 'binance_pay';
  // Pabilo reports Binance collections in USDT, while internal order
  // accounting stays in Bs. Compare in the payment currency and convert any
  // partial or surplus back to Bs at the order's frozen rate.
  const pendienteMoneda = esBinancePay
    ? round(Math.max(0, order.pricing.amountDueUsd - yaPagadoBs / order.pricing.rate), 2)
    : pendienteBs;

  const propuesto = minutesFromNow(config.checkout.orderExpiryMinutes);
  const nuevoVencimiento =
    propuesto.toMillis() > order.expiresAt.toMillis() ? propuesto : order.expiresAt;

  const claim = await claimPaymentVerification(
    reference,
    order,
    nuevoVencimiento,
    config.checkout.maxVerifyAttempts
  );
  if (claim.kind === 'in_progress') {
    return {
      order: claim.order,
      verified: false,
      message: 'Estamos consultando el banco. La orden se actualizará en unos segundos.',
    };
  }
  if (claim.kind === 'already_paid') {
    return {
      order: claim.order,
      verified: true,
      message: 'Tu pago ya estaba verificado. Estamos procesando la entrega.',
    };
  }
  if (claim.kind === 'conflict') {
    await orders().doc(orderId).set(
      { status: 'payment_rejected', payment: { reference }, updatedAt: now() },
      { merge: true }
    );
    const reason = claim.sameOrder
      ? 'Esta referencia ya se registró en tu orden. Si pagaste la diferencia, usa la referencia nueva.'
      : claim.conflictOrderCode
        ? `Esa referencia ya se usó en la orden ${claim.conflictOrderCode}.`
        : 'Esa referencia ya está asociada a otra orden.';
    await addEvent({
      orderId,
      type: 'payment_duplicate',
      message: reason,
      status: 'payment_rejected',
    });
    throw paymentRejected(reason, { canRetry: true, expiresAt: nuevoVencimiento.toMillis() });
  }

  let result: Awaited<ReturnType<typeof pabilo.verifyPayment>>;
  try {
    result = await pabilo.verifyPayment({
      bankReference: reference,
      account: order.payment.method === 'binance_pay' ? 'binance' : 'bdv',
      // Lo que falta, no el total: si ya hay parciales acreditados, el pago
      // bueno es el de la diferencia.
      amount: pendienteMoneda,
    });
  } catch (error) {
    // El proveedor está caído o tardó más de 45 s: se libera el candado local
    // y se devuelve la orden a "esperando pago" para que el cliente pueda
    // reintentar. Se guarda la referencia intentada para poder conciliar
    // automáticamente si Pabilo sí la procesó en segundo plano.
    await releaseReferenceLock(reference);
    await orders().doc(orderId).set(
      {
        status: 'awaiting_payment',
        payment: { lastAttemptedReference: reference },
        updatedAt: now(),
      },
      { merge: true }
    );
    await addEvent({
      orderId,
      type: 'payment_provider_error',
      message: 'No se pudo contactar al verificador de pagos. Se puede reintentar.',
      status: 'awaiting_payment',
      data: { reference },
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
    result.reportedAmount === null
      ? null
      : checkAmount(
          pendienteMoneda,
          result.reportedAmount,
          config.checkout.amountTolerancePercent
        );

  const reportedAmountBs = result.reportedAmount === null
    ? null
    : esBinancePay
      ? round(result.reportedAmount * order.pricing.rate, 2)
      : result.reportedAmount;
  const shortfallBs = amountCheck
    ? round(amountCheck.shortfallBs * (esBinancePay ? order.pricing.rate : 1), 2)
    : null;

  const amountOk = result.amountVerifiedByProvider
    ? true
    : amountCheck !== null && amountCheck.ok;

  /**
   * Pago real, nuevo y con importe legible, pero que no cubre lo pendiente.
   *
   * Se acredita en vez de rechazarse: el cliente ya transfirió ese dinero y
   * obligarle a crear otra orden lo dejaría sin la plata y sin la tasa a la
   * que compró. La orden se queda esperando sólo la diferencia.
   */
  const esParcial =
    result.found &&
    result.isNew &&
    !amountOk &&
    amountCheck !== null &&
    amountCheck.shortfallBs > 0 &&
    (result.reportedAmount ?? 0) > 0;

  if (esParcial) {
    // El candado NO se libera: esa referencia queda consumida por esta orden.
    const abonado = reportedAmountBs!;
    const totalPagado = round(yaPagadoBs + abonado, 2);
    const faltanBs = round(order.pricing.totalBs - totalPagado, 2);

    await orders().doc(orderId).set(
      {
        status: 'awaiting_payment',
        payment: {
          reference,
          reportedAmountBs,
          providerResponse: result.raw,
          paidBs: totalPagado,
          partials: FieldValue.arrayUnion({
            reference,
            amountBs: abonado,
            verifiedAt: now(),
          }),
        },
        updatedAt: now(),
      },
      { merge: true }
    );

    const mensaje =
      `Recibimos ${esBinancePay ? `${result.reportedAmount!.toFixed(2)} USDT` : `${abonado.toFixed(2)} Bs`} de esa referencia. La orden es de ` +
      `${order.pricing.totalBs.toFixed(2)} Bs, así que faltan ${faltanBs.toFixed(2)} Bs. ` +
      'Paga esa diferencia y verifica con la nueva referencia: no crees otra orden.';

    await Promise.all([
      addEvent({
        orderId,
        type: 'payment_partial',
        message: mensaje,
        status: 'awaiting_payment',
        data: { reference, abonadoBs: abonado, pagadoBs: totalPagado, faltanBs },
      }),
      notifications.notify({
        uid: order.uid,
        title: 'Pago parcial recibido',
        body: `Van ${totalPagado.toFixed(2)} de ${order.pricing.totalBs.toFixed(2)} Bs. Faltan ${faltanBs.toFixed(2)} Bs.`,
        type: 'order',
        link: `/orden/${orderId}`,
      }),
    ]);

    throw paymentRejected(mensaje, {
      canRetry: true,
      partial: true,
      paidBs: totalPagado,
      pendingBs: faltanBs,
      expiresAt: nuevoVencimiento.toMillis(),
    });
  }

  // --- Conciliación de reintentos legítimos (`is_new: false`) ---
  //
  // Si Pabilo encontró el pago (`result.found === true`) y el monto cubre la orden
  // (`amountOk === true`), pero Pabilo devuelve `is_new === false` ("Pago móvil duplicado"):
  //
  // Esto ocurre cuando la petición anterior de ESTA MISMA ORDEN sufrió un corte
  // de red o timeout local después de que Pabilo ya hubiera registrado el pago
  // en su base de datos (habitual en horas pico con el BDV). Al reintentar,
  // Pabilo ya tiene el movimiento guardado y devuelve `is_new: false`.
  //
  // Comprobamos si es seguro conciliarlo automáticamente:
  //  1. Ninguna OTRA orden en la tienda ha usado esa referencia.
  //  2. Esta orden es la misma que intentó pagarlo (reintento legítimo).
  let reconciledDuplicate = false;
  let conflictPaidOrder: { id: string; code: string } | null = null;

  if (result.found && amountOk && !result.isNew) {
    conflictPaidOrder = await findPaidOrderWithReference(reference, orderId);

    if (!conflictPaidOrder) {
      const isSelfRetry =
        order.payment?.reference === reference ||
        order.payment?.lastAttemptedReference === reference ||
        (order.payment?.attempts ?? 0) > 1 ||
        (await hadProviderErrorEvent(orderId, reference));

      if (isSelfRetry) {
        log.info('Pago conciliado automáticamente tras reintento con Pabilo', {
          orderId,
          orderCode: order.code,
          reference: `***${reference.slice(-4)}`,
          reportedAmount: result.reportedAmount,
        });
        reconciledDuplicate = true;
      }
    }
  }

  const paymentApproved = (result.isNew || reconciledDuplicate) && amountOk;

  if (!paymentApproved) {
    await releaseReferenceLock(reference);

    const reason = !result.found
      ? 'No encontramos ningún pago con esa referencia. Revisa que la hayas copiado completa.'
      : conflictPaidOrder
        ? `Esa referencia ya fue utilizada en la orden ${conflictPaidOrder.code}.`
        : !result.isNew
          ? 'Pabilo encontró el pago, pero indica que esa referencia ya había sido verificada en otra operación. Si pagaste recientemente, contacta al soporte.'
          : amountCheck === null
            ? 'No pudimos leer el monto de ese pago. Escríbenos por WhatsApp y lo revisamos.'
            : `Ese pago es de ${esBinancePay ? `${result.reportedAmount!.toFixed(2)} USDT` : `${result.reportedAmount!.toFixed(2)} Bs`} y la orden es de ` +
              `${esBinancePay ? `${order.pricing.amountDueUsd.toFixed(2)} USDT` : `${order.pricing.totalBs.toFixed(2)} Bs`}: faltan ` +
              `${esBinancePay ? `${amountCheck.shortfallBs.toFixed(2)} USDT` : `${shortfallBs!.toFixed(2)} Bs`}. Paga el monto exacto y ` +
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
        data: { reportedAmountBs },
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
        kind: result.found && !result.isNew ? 'payment_review' : 'payment_rejected',
        severity: result.found && !result.isNew ? 'warning' : 'info',
        title: result.found && !result.isNew
          ? `Revisar pago registrado en Pabilo · ${order.code}`
          : `Pago rechazado · ${order.code}`,
        body: `${order.user.email ?? 'Un cliente'} intentó pagar ${describeOrder(order)}. ${reason}`,
        link: `/admin/ordenes/${orderId}`,
        data: { code: order.code, reference: `***${reference.slice(-4)}` },
      }),
    ]);

    throw paymentRejected(reason, {
      canRetry: true,
      expiresAt: nuevoVencimiento.toMillis(),
    });
  }

    // --- Cálculo del excedente de pago (Sobran bolívares / USDT) ---
    const surplusBs = round((amountCheck?.surplusBs ?? 0) * (esBinancePay ? order.pricing.rate : 1), 2);
    const surplusThresholdBs = (amountCheck?.alertAboveBs ?? 0) * (esBinancePay ? order.pricing.rate : 1);
    const surplusIsRelevant = surplusBs > surplusThresholdBs;

    // Regla de seguridad financiera: truncado hacia abajo a 2 decimales (Math.floor)
    // para nunca acreditar fracciones de centavo por encima del dinero real recibido.
    const rawSurplusUsd = esBinancePay
      ? (amountCheck?.surplusBs ?? 0)
      : (order.pricing.rate > 0 ? surplusBs / order.pricing.rate : 0);
    const surplusUsd = Math.floor(Math.max(0, rawSurplusUsd) * 100) / 100;

    let surplusCredited = false;
    let surplusTargetUid: string | null = null;

    if (surplusUsd >= 0.01) {
      let targetUid: string | null = null;

      if (!order.uid.startsWith('whatsapp:')) {
        targetUid = order.uid;
      } else {
        // Resolución de compradores de WhatsApp que ya tengan cuenta Web vinculada:
        try {
          const matched = await resolveWebUserForWhatsappOrder({
            explicitUserId: null,
            phoneRaw: order.contactPhone ?? order.uid.replace(/^whatsapp:/, ''),
            playerId: order.playerId,
          });
          if (matched?.uid) {
            targetUid = matched.uid;
          }
        } catch (err) {
          log.warn('No se pudo resolver usuario web para orden WhatsApp con excedente', {
            orderId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (targetUid) {
        try {
          const walletResult = await usersService.moveWallet({
            uid: targetUid,
            deltaUsd: surplusUsd,
            reason: `Excedente de pago en orden ${order.code} (${surplusBs.toFixed(2)} Bs)`,
            orderId,
            orderCode: order.code,
            movementId: `surplus_${orderId}`,
          });

          surplusCredited = true;
          surplusTargetUid = targetUid;

          log.info('Excedente acreditado automáticamente a RefillCoins', {
            orderId,
            code: order.code,
            surplusBs,
            surplusUsd,
            targetUid,
            newBalance: walletResult.balanceUsd,
          });

          void notifications.notify({
            uid: targetUid,
            title: '¡RefillCoins acreditadas por pago excedente! 🪙',
            body: `Transferiste ${surplusBs.toFixed(2)} Bs de más en la orden ${order.code}. Acreditamos $${surplusUsd.toFixed(2)} RefillCoins a tu cuenta.`,
            type: 'order',
            link: `/orden/${orderId}`,
          }).catch(() => undefined);
        } catch (err) {
          log.error('Error al acreditar excedente a RefillCoins', {
            orderId,
            code: order.code,
            targetUid,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // --- Pago confirmado (Tarea B: registro unificado de venta y finanzas) ---
    await orders().doc(orderId).set(
      {
        status: 'paid',
        referencia: reference,
        canal: order.canal ?? 'WEB',
        origen: order.origen ?? 'WEB',
        clienteContacto: order.contactPhone ?? order.user.email ?? order.uid,
        juego: order.gameName,
        paqueteNombre: order.productName,
        productIds: (order.dispatch?.calls ?? []).map((c) => c.packageId),
        montoBs: reportedAmountBs ?? order.pricing.totalBs,
        tasaBcv: order.pricing.rate,
        montoUsd: order.pricing.totalUsd,
        costoProveedorUsd: order.pricing.costUsd,
        gananciaNetaUsd: order.pricing.profitUsd,
        tipoDespacho: order.fulfillment === 'auto' ? 'AUTOMATICO' : 'MANUAL',
        estado: order.fulfillment === 'auto' ? 'PAGO_VALIDADO' : 'REVISION_MANUAL',
        subOrdenes: order.subOrdenes ?? [],
        payment: {
          reference,
          reportedAmountBs,
          verifiedAt: now(),
          providerResponse: result.raw,
          ...(surplusBs > 0
            ? {
                surplusBs,
                surplusUsd,
                surplusCredited,
                surplusCreditedToUid: surplusTargetUid,
              }
            : {}),
        },
        updatedAt: now(),
      },
      { merge: true }
    );

    const paymentVerifiedMessage = reconciledDuplicate
      ? 'Pago verificado exitosamente mediante conciliación automática de reintento.'
      : surplusCredited
        ? `Pago verificado. Transferiste ${surplusBs.toFixed(2)} Bs de más; acreditamos automáticamente $${surplusUsd.toFixed(2)} RefillCoins a tu saldo.`
        : surplusIsRelevant
          ? `Pago verificado. Transferiste ${surplusBs.toFixed(2)} Bs de más; ya lo estamos revisando.`
          : 'Pago verificado correctamente.';

    await Promise.all([
      addEvent({
        orderId,
        type: 'payment_verified',
        message: paymentVerifiedMessage,
        status: 'paid',
        data: {
          reportedAmountBs,
          surplusBs,
          surplusUsd: surplusCredited ? surplusUsd : undefined,
          surplusCredited: surplusCredited || undefined,
          reconciledDuplicate: reconciledDuplicate || undefined,
        },
      }),
      audit.record({
        action: audit.ACTIONS.ORDER_PAYMENT_VERIFIED,
        actorUid: user.uid,
        actorEmail: user.email,
        targetType: 'order',
        targetId: orderId,
        summary: `Pago verificado en la orden ${order.code} (${order.pricing.totalBs} Bs).`,
        data: { reportedAmountBs, surplusBs, surplusUsd, surplusCredited },
        ip,
      }),
      order.gameId !== 'wallet'
        ? catalog.decrementStock(order.productId, order.pricing.quantity)
        : Promise.resolve(),
      order.pricing.couponCode
        ? couponsService.consume(order.pricing.couponCode)
        : Promise.resolve(),
      surplusIsRelevant
        ? adminAlerts.alert({
            kind: 'payment_review',
            severity: 'info',
            title: surplusCredited
              ? `Sobrepago acreditado automáticamente · ${order.code}`
              : `Pagaron de más · ${order.code}`,
            body: surplusCredited
              ? `${order.user.email ?? 'Cliente'} pagó ${reportedAmountBs?.toFixed(2)} ${esBinancePay ? 'USDT' : 'Bs'} (sobraron ${surplusBs.toFixed(2)} Bs). Se le acreditaron automáticamente $${surplusUsd.toFixed(2)} RefillCoins a su cuenta.`
              : [
                  `${order.user.email ?? 'Un cliente'} pagó ${reportedAmountBs?.toFixed(2)} ${esBinancePay ? 'USDT' : 'Bs'}`,
                  `para una orden de ${order.pricing.totalBs.toFixed(2)} Bs.`,
                  `Sobran ${surplusBs.toFixed(2)} Bs: ${order.uid.startsWith('whatsapp:') ? 'cliente de WhatsApp sin cuenta web vinculada.' : 'puedes abonárselos al saldo desde su ficha.'}`,
                ].join(' '),
            link: `/admin/ordenes/${orderId}`,
            data: { code: order.code, surplusBs, surplusUsd, surplusCredited, reportedAmountBs },
          })
        : Promise.resolve(),
    ]);


  // Sin `await`: el comprobante no debe retrasar la respuesta al cliente, que
  // está esperando ver si su recarga salió.
  void sendOrderEmail('payment_verified', orderId);

  // --- Entrega ---
  if (order.gameId === 'wallet') {
    await usersService.moveWallet({
      uid: order.uid,
      deltaUsd: order.pricing.totalUsd,
      reason: `Recarga de saldo (Orden ${order.code})`,
      orderId: orderId,
      orderCode: order.code,
    });
    await orders().doc(orderId).update({
      status: 'completed',
      completedAt: FieldValue.serverTimestamp(),
    });

    void sendOrderEmail('delivered', orderId);

    await addEvent({
      orderId,
      type: 'completed',
      message: '¡Recarga de saldo acreditada en tu billetera!',
      status: 'completed',
    });
  } else if (order.fulfillment === 'auto') {
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
        : updated.status === 'in_review'
          ? 'Estamos procesando tu orden manualmente. Si no se completa en 1 hora, se te devuelve el saldo automáticamente.'
          : updated.status === 'awaiting_manual'
            ? 'Pago verificado. Continúa por WhatsApp para recibir tu producto.'
            : 'Pago verificado. Estamos procesando tu entrega.',
  };
}

// ---------------------------------------------------------------------------
// Acciones sobre la orden
// ---------------------------------------------------------------------------

interface TransactionalRefundOptions {
  orderId: string;
  allowedStatuses: OrderStatus[];
  targetStatus?: OrderStatus;
  motivo?: string | null;
  actorUid?: string | null;
  toWallet?: boolean;
  amountMode: 'full_order' | 'applied_and_partial';
}

interface TransactionalRefundOutcome {
  order: Order;
  refundedAmountUsd: number;
  statusChanged: boolean;
  alreadyRefunded: boolean;
}

/**
 * Único helper transaccional de reembolso.
 *
 * Todos los caminos que devuelven saldo (`refundOrder` del admin, el barrido
 * programado de 1 h y `refundWalletIfApplied` por expiración o cancelación)
 * pasan por aquí:
 *  - Todas las lecturas (`order` y `users/{uid}/wallet/refund_${orderId}`) se
 *    hacen antes de las escrituras en la misma transacción de Firestore.
 *  - Idempotente por tres vías: `order.refundedAt`, flag legacy
 *    `order.pricing.walletRefunded === true` y documento determinístico
 *    `refund_${orderId}`.
 *  - Descripción fija: `"Reembolso de la orden RF-XXXXXX"`.
 */
async function executeOrderRefundTx(
  options: TransactionalRefundOptions
): Promise<TransactionalRefundOutcome> {
  const orderRef = orders().doc(options.orderId);
  const movementId = `refund_${options.orderId}`;

  return db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw notFound('Orden no encontrada.');

    const current = { id: orderSnap.id, ...orderSnap.data() } as Order;
    const isWhatsappGuest = current.uid.startsWith('whatsapp:');
    const walletState = isWhatsappGuest
      ? null
      : await usersService.readWalletInTx(tx, current.uid, movementId);

    const alreadyRefunded = Boolean(
      current.refundedAt != null ||
        current.pricing?.walletRefunded === true ||
        walletState?.movementSnap?.exists
    );

    if (
      current.status === 'completed' ||
      current.status === 'cancelled' ||
      current.status === 'refunded' ||
      !options.allowedStatuses.includes(current.status)
    ) {
      return {
        order: current,
        refundedAmountUsd: 0,
        statusChanged: false,
        alreadyRefunded,
      };
    }

    let amountToCredit = 0;
    if (
      !alreadyRefunded &&
      options.toWallet !== false &&
      !isWhatsappGuest &&
      Boolean(walletState?.userSnap.exists)
    ) {
      if (options.amountMode === 'full_order') {
        amountToCredit = round(current.pricing?.totalUsd ?? 0, 2);
      } else {
        const applied = current.pricing?.walletAppliedUsd ?? 0;
        const partialUsd =
          (current.pricing?.rate ?? 0) > 0
            ? round((current.payment?.paidBs ?? 0) / current.pricing.rate, 2)
            : 0;
        amountToCredit = round(applied + partialUsd, 2);
      }
    }

    const timestamp = now();
    const fixedReason = `Reembolso de la orden ${current.code}`;

    if (amountToCredit > 0 && walletState) {
      usersService.writeWalletInTx(tx, walletState, {
        uid: current.uid,
        deltaUsd: amountToCredit,
        reason: fixedReason,
        orderId: current.id,
        orderCode: current.code,
        actorUid: options.actorUid ?? null,
        movementId,
      });
    }

    const statusChanged = Boolean(options.targetStatus && options.targetStatus !== current.status);
    if (amountToCredit > 0 || statusChanged) {
      const updateData: Record<string, unknown> = {
        updatedAt: timestamp,
      };

      if (amountToCredit > 0 || options.targetStatus === 'cancelled') {
        updateData.refundedAt = current.refundedAt ?? timestamp;
        updateData.pricing = { walletRefunded: true };
      }

      if (options.targetStatus) {
        updateData.status = options.targetStatus;
        updateData.reviewDeadline = null;
        if (options.motivo !== undefined) {
          updateData.refundReason = options.motivo ?? current.refundReason ?? null;
          if (options.targetStatus === 'cancelled' && options.amountMode === 'full_order') {
            updateData.adminNote = options.motivo ?? current.adminNote ?? null;
          }
        }
      }

      tx.set(orderRef, updateData, { merge: true });
    }

    const updatedOrder: Order = {
      ...current,
      status: options.targetStatus ?? current.status,
      refundedAt:
        amountToCredit > 0 || options.targetStatus === 'cancelled'
          ? (current.refundedAt ?? timestamp)
          : current.refundedAt,
      refundReason:
        options.motivo !== undefined ? (options.motivo ?? current.refundReason ?? null) : current.refundReason,
      reviewDeadline: options.targetStatus ? null : current.reviewDeadline,
      pricing: {
        ...current.pricing,
        walletRefunded:
          amountToCredit > 0 || options.targetStatus === 'cancelled'
            ? true
            : current.pricing?.walletRefunded,
      },
      updatedAt: timestamp,
    };

    return {
      order: updatedOrder,
      refundedAmountUsd: amountToCredit,
      statusChanged,
      alreadyRefunded,
    };
  });
}

/**
 * Devuelve a la cartera el saldo que se descontó al crear la orden (y pagos
 * parciales si los hubo).
 *
 * Se llama al cancelar y al caducar órdenes impagas. Delega en el helper
 * transaccional único con ID determinístico `refund_${orderId}`.
 */
export async function refundWalletIfApplied(order: Order, reason?: string): Promise<number> {
  const outcome = await executeOrderRefundTx({
    orderId: order.id,
    allowedStatuses: ['awaiting_payment', 'payment_rejected'],
    motivo: reason ?? null,
    toWallet: true,
    amountMode: 'applied_and_partial',
  });
  return outcome.refundedAmountUsd;
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

/**
 * Cambia el método de pago de una orden que todavía no se ha pagado.
 *
 * Los datos bancarios se congelan al crear la orden, pero mientras nadie haya
 * transferido nada cambiarlos es inofensivo: el monto es el mismo por los dos
 * caminos y la verificación no distingue. Existe porque el cliente elige cómo
 * pagar en la misma pantalla donde ve los datos, que es donde lo busca; sin
 * esto tendría que cancelar y volver a empezar sólo para cambiar de idea.
 */
export async function setPaymentMethod(
  user: AuthUser,
  orderId: string,
  method: 'pagomovil_bdv' | 'transfer' | 'binance_pay'
): Promise<Order> {
  const order = await getOrderFor(orderId, user);
  const config = await getConfig();

  if (!['awaiting_payment', 'payment_rejected'].includes(order.status)) {
    throw failedPrecondition('Esta orden ya no admite cambiar el método de pago.');
  }
  if (order.payment.method === 'wallet') {
    throw failedPrecondition('Esta orden se pagó con saldo.');
  }
  if ((order.payment.paidBs ?? 0) > 0 && method !== order.payment.method) {
    throw failedPrecondition(
      'Esta orden ya tiene un pago parcial. Continúa con el mismo método para no separar los movimientos entre cuentas.'
    );
  }
  if (method === 'transfer' && !config.transfer.enabled) {
    throw failedPrecondition('La transferencia bancaria no está disponible ahora mismo.');
  }
  if (method === 'binance_pay' && !config.binancePay.enabled) {
    throw failedPrecondition('Binance Pay no está disponible ahora mismo.');
  }

  const bankSnapshot =
    method === 'transfer'
      ? {
          code: config.transfer.code,
          name: config.transfer.name,
          idNumber: config.transfer.idNumber,
          phone: '',
          accountNumber: config.transfer.accountNumber,
          accountType: config.transfer.accountType,
        }
      : method === 'binance_pay'
        ? { code: '', name: 'Binance Pay', idNumber: '', phone: '', binancePayId: config.binancePay.payId }
        : {
          code: config.bank.code,
          name: config.bank.name,
          idNumber: config.bank.idNumber,
          phone: config.bank.phone,
        };

  // `update` con ruta con puntos REEMPLAZA el mapa entero; `set` con `merge` lo
  // fusionaría y dejaría el `accountNumber` de la transferencia pegado al
  // volver a Pago Móvil. Es la misma trampa que ya mordió en las estadísticas.
  await orders().doc(orderId).update({
    'payment.method': method,
    'payment.bankSnapshot': bankSnapshot,
    updatedAt: now(),
  });

  return getOrder(orderId);
}

/**
 * Paga una orden pendiente con el saldo interno (RefillCoins).
 *
 * Se descuenta con `moveWallet`, que corre en transacción y lanza si el saldo
 * ya no alcanza: así dos pagos simultáneos no gastan el mismo dinero. Una vez
 * debitado, la orden sigue el mismo camino que un pago verificado: entra en
 * `paid` y se entrega por el proveedor (o queda lista para WhatsApp si es
 * manual), sin pedir referencia ni consultar al banco.
 */
export async function payWithWallet(user: AuthUser, orderId: string): Promise<Order> {
  const order = await getOrderFor(orderId, user);
  const config = await getConfig();

  if (!['awaiting_payment', 'payment_rejected'].includes(order.status)) {
    throw failedPrecondition('Esta orden ya no admite pago.');
  }
  if (order.gameId === 'wallet') {
    throw failedPrecondition('Una recarga de saldo no se puede pagar con el propio saldo.');
  }
  if (config.checkout.walletEnabled === false) {
    throw failedPrecondition('El pago con RefillCoins no está disponible ahora mismo.');
  }
  if ((order.payment.paidBs ?? 0) > 0) {
    throw failedPrecondition(
      'Esta orden ya tiene un pago parcial. Completa la diferencia con el mismo método.'
    );
  }
  if (order.expiresAt.toMillis() < Date.now()) {
    throw failedPrecondition('La orden expiró. Crea una nueva.');
  }

  const dueUsd = round(order.pricing.amountDueUsd ?? order.pricing.totalUsd, 2);
  if (dueUsd <= 0) {
    throw failedPrecondition('Esta orden no tiene nada pendiente de pago.');
  }

  const profile = await usersService.ensureProfile(user);
  if (round(profile.walletBalanceUsd ?? 0, 2) < dueUsd) {
    throw failedPrecondition(
      `Saldo insuficiente: necesitas $${dueUsd.toFixed(2)} RefillCoins y tienes $${round(profile.walletBalanceUsd ?? 0, 2).toFixed(2)}.`,
      { code: 'insufficient_wallet' }
    );
  }

  // Lanza si el saldo no alcanza en el instante del débito.
  await usersService.moveWallet({
    uid: order.uid,
    deltaUsd: -dueUsd,
    reason: `Pago de la orden ${order.productName}`,
    orderId,
    orderCode: order.code,
  });

  const timestamp = now();
  await orders().doc(orderId).update({
    status: 'paid',
    estado: order.fulfillment === 'auto' ? 'PAGO_VALIDADO' : 'REVISION_MANUAL',
    'payment.method': 'wallet',
    'payment.verifiedAt': timestamp,
    'pricing.walletAppliedUsd': round((order.pricing.walletAppliedUsd ?? 0) + dueUsd, 2),
    'pricing.amountDueUsd': 0,
    updatedAt: timestamp,
  });

  await Promise.all([
    addEvent({
      orderId,
      type: 'payment_verified',
      message: `Pagada con RefillCoins ($${dueUsd.toFixed(2)}).`,
      status: 'paid',
      actor: 'customer',
      actorUid: user.uid,
    }),
    audit.record({
      action: audit.ACTIONS.ORDER_PAYMENT_VERIFIED,
      actorUid: user.uid,
      actorEmail: user.email,
      targetType: 'order',
      targetId: orderId,
      summary: `Orden ${order.code} pagada con RefillCoins ($${dueUsd.toFixed(2)}).`,
      data: { dueUsd },
    }),
    catalog.decrementStock(order.productId, order.pricing.quantity),
    order.pricing.couponCode ? couponsService.consume(order.pricing.couponCode) : Promise.resolve(),
  ]);

  if (order.fulfillment === 'auto') {
    await dispatchService.dispatchOrder(orderId);
  } else {
    await dispatchService.prepareManualOrder(orderId);
  }

  return getOrder(orderId);
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
  if (!['in_review', 'failed', 'paid', 'dispatching'].includes(order.status)) {
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
  const orderRef = orders().doc(orderId);

  const txResult = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw notFound('Orden no encontrada.');

    const current = { id: snap.id, ...snap.data() } as Order;
    if (current.status === 'completed') {
      return { order: current, changed: false, alreadyAccounted: true };
    }
    if (!['in_review', 'awaiting_manual', 'failed', 'dispatching'].includes(current.status)) {
      throw failedPrecondition(
        'Sólo se pueden completar manualmente órdenes en revisión o pendientes de entrega manual.'
      );
    }

    const alreadyAccounted = current.metricsAccounted === true;
    const timestamp = now();
    tx.set(
      orderRef,
      {
        status: 'completed',
        estado: 'COMPLETADO',
        metricsAccounted: true,
        reviewDeadline: null,
        providerError: null,
        adminNote: note ?? current.adminNote,
        dispatch: { ...current.dispatch, completedAt: timestamp, lastError: null },
        updatedAt: timestamp,
      },
      { merge: true }
    );

    return {
      order: {
        ...current,
        status: 'completed' as OrderStatus,
        estado: 'COMPLETADO' as const,
        metricsAccounted: true,
        reviewDeadline: null,
        providerError: null,
        adminNote: note ?? current.adminNote,
        dispatch: { ...current.dispatch, completedAt: timestamp, lastError: null },
        updatedAt: timestamp,
      },
      changed: true,
      alreadyAccounted,
    };
  });

  if (!txResult.changed) {
    return txResult.order;
  }

  const order = txResult.order;
  const isWhatsappGuest = order.uid.startsWith('whatsapp:');

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
    !isWhatsappGuest
      ? notifications.notify({
          uid: order.uid,
          title: '¡Tu recarga fue entregada! 🎮',
          body: `${describeOrder(order)} ya está acreditado en ${order.playerId}.`,
          type: 'order',
          link: `/orden/${orderId}`,
        })
      : Promise.resolve(),
    !txResult.alreadyAccounted
      ? usersService.registerCompletedPurchase(order.uid, order.pricing.totalUsd)
      : Promise.resolve(),
    // Idempotente: si el despacho automático ya la devengó, ésta no hace nada.
    creatorsService.accrueCommission(order),
    !txResult.alreadyAccounted
      ? stats.trackEvent({ type: 'order_completed', order: { ...order, status: 'completed' } })
      : Promise.resolve(),
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

export interface RefundOrderOptions {
  actor?: AuthUser | null;
  toWallet?: boolean;
  note?: string | null;
}

/**
 * Única función para cancelar y reembolsar una orden pagada (usada por el
 * admin y por la tarea programada de 1 hora).
 *
 * - Corre en una transacción de Firestore leyendo el estado actual.
 * - Idempotente por `refund_${orderId}`, `order.refundedAt` y flag legacy
 *   `pricing.walletRefunded === true`.
 * - Sólo reembolsa si el estado está en `in_review` (o pagada sin entregar:
 *   `paid`, `dispatching`, `awaiting_manual`, `failed`). Si ya está
 *   `completed` o `cancelled`, no hace nada.
 * - Descripción fija en el movimiento: `"Reembolso de la orden RF-XXXXXX"`.
 */
export async function refundOrder(
  orderIdOrActor: string | AuthUser,
  motivoOrOrderId?: string | null,
  optionsArg?: RefundOrderOptions
): Promise<Order> {
  let orderId: string;
  let motivo: string | null;
  let actor: AuthUser | null = null;
  let toWallet = true;

  if (typeof orderIdOrActor === 'object' && orderIdOrActor !== null && 'uid' in orderIdOrActor) {
    actor = orderIdOrActor;
    orderId = String(motivoOrOrderId ?? '');
    motivo = optionsArg?.note ?? null;
    toWallet = optionsArg?.toWallet ?? true;
  } else {
    orderId = orderIdOrActor;
    motivo = motivoOrOrderId ?? optionsArg?.note ?? null;
    actor = optionsArg?.actor ?? null;
    toWallet = optionsArg?.toWallet ?? true;
  }

  const outcome = await executeOrderRefundTx({
    orderId,
    allowedStatuses: ['in_review', 'paid', 'dispatching', 'awaiting_manual', 'failed'],
    targetStatus: 'cancelled',
    motivo,
    actorUid: actor?.uid ?? null,
    toWallet,
    amountMode: 'full_order',
  });

  if (!outcome.statusChanged && outcome.refundedAmountUsd === 0) {
    return outcome.order;
  }

  const order = outcome.order;
  const creditedUsd = outcome.refundedAmountUsd;

  // La venta deja de existir: la comisión del creador también.
  await creatorsService.revertCommission(order);

  await Promise.all([
    addEvent({
      orderId,
      type: 'refunded',
      message:
        creditedUsd > 0
          ? `Orden cancelada. Reembolsado $${creditedUsd.toFixed(2)} al saldo del usuario${
              motivo ? ` (${motivo})` : ''
            }.`
          : `Orden cancelada${motivo ? `: ${motivo}` : '.'}`,
      status: 'cancelled',
      actor: actor ? 'admin' : 'system',
      actorUid: actor?.uid ?? null,
    }),
    !order.uid.startsWith('whatsapp:')
      ? notifications.notify({
          uid: order.uid,
          title: 'Orden cancelada y reembolsada',
          body:
            creditedUsd > 0
              ? `Acreditamos $${creditedUsd.toFixed(2)} a tu saldo por la orden ${order.code}.`
              : `Tu orden ${order.code} fue cancelada.`,
          type: 'order',
          link: `/orden/${orderId}`,
        })
      : Promise.resolve(),
    stats.trackEvent({ type: 'order_refunded', order }),
    audit.record({
      action: audit.ACTIONS.ORDER_REFUNDED,
      actorUid: actor?.uid ?? null,
      actorEmail: actor?.email ?? null,
      targetType: 'order',
      targetId: orderId,
      summary: `Orden ${order.code} cancelada${
        creditedUsd > 0 ? ` y reembolsada ($${creditedUsd.toFixed(2)})` : ''
      }.`,
      data: { amountUsd: creditedUsd, note: motivo },
    }),
  ]);

  return getOrder(orderId);
}

/**
 * Cancela y reembolsa automáticamente las órdenes `in_review` cuyo plazo de
 * revisión (`reviewDeadline`) ya venció (1 hora).
 *
 * Procesa por lotes con `try/catch` individual para que un fallo puntual no
 * frene el resto del lote.
 */
export async function refundStaleReviewOrders(limit = 50): Promise<number> {
  const snap = await orders()
    .where('status', '==', 'in_review')
    .where('reviewDeadline', '<=', now())
    .limit(limit)
    .get();

  if (snap.empty) return 0;

  let processed = 0;
  for (const doc of snap.docs) {
    try {
      const order = { id: doc.id, ...doc.data() } as Order;

      // Si es una orden automática con llamadas al proveedor, consultamos en vivo con el proveedor
      // antes de tomar cualquier decisión de reembolso.
      if (order.fulfillment === 'auto' && (order.dispatch?.calls?.length ?? 0) > 0) {
        const checkResult = await dispatchService.checkOrderProviderStatus(doc.id, 'system');

        // a) Si el proveedor reporta que ya se completó:
        if (checkResult.orderStatus === 'completed' || checkResult.calls.every((c) => c.status === 'completed')) {
          log.info('Orden en revisión vencida completada por proveedor en vivo (no reembolsada)', {
            orderId: doc.id,
            code: order.code,
          });
          continue;
        }

        // b) Si el proveedor reporta que SIGUE procesando (en cola activa):
        const isStillProcessing = checkResult.calls.some((c) => c.status === 'processing');
        if (isStillProcessing) {
          log.warn('Orden en revisión vencida SIGUE en proceso en proveedor: NO se auto-reembolsa', {
            orderId: doc.id,
            code: order.code,
          });
          await orders().doc(doc.id).update({
            status: 'dispatching',
            estado: 'DESPACHANDO_INEFABLE',
            reviewDeadline: minutesFromNow(60),
            updatedAt: now(),
          });
          await addEvent({
            orderId: doc.id,
            type: 'in_review',
            message: 'Tiempo de 1h alcanzado pero la recarga sigue en cola en el proveedor. Permanece en seguimiento.',
            status: 'dispatching',
            actor: 'system',
          });
          continue;
        }

        // c) SOLO si todas las llamadas están confirmadas como fallida o not_found:
        const allFailedOrNotFound = checkResult.calls.every(
          (c) => c.status === 'failed' || c.status === 'not_found'
        );

        if (!allFailedOrNotFound) {
          log.warn('Orden en revisión con estado ambiguo en proveedor; manteniendo en revisión manual sin reembolsar', {
            orderId: doc.id,
            code: order.code,
          });
          await orders().doc(doc.id).update({
            reviewDeadline: minutesFromNow(30),
            updatedAt: now(),
          });
          continue;
        }
      }

      await refundOrder(doc.id, 'Tiempo de revisión manual agotado (1 hora)');
      processed += 1;
    } catch (error) {
      log.warn('No se pudo reembolsar una orden en revisión vencida', {
        orderId: doc.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info('Órdenes en revisión vencidas procesadas', { count: processed });
  return processed;
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
