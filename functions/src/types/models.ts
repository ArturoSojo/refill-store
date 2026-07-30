/**
 * Modelos de dominio de Refill Store.
 *
 * Este archivo se mantiene ESPEJO en `web/src/types/models.ts`. Si cambias algo
 * aquí, replícalo allá (no se comparte un paquete porque el bundle de Cloud
 * Functions sólo sube el directorio `functions/`).
 *
 * Las fechas se tipan como `TimestampLike` porque tanto el `Timestamp` del
 * Admin SDK como el del SDK web cumplen esa forma estructural.
 */

export interface TimestampLike {
  toMillis(): number;
  toDate(): Date;
}

// ---------------------------------------------------------------------------
// Juegos
// ---------------------------------------------------------------------------

export interface Game {
  /** Slug legible usado como ID de documento: `free-fire`, `blood-strike`. */
  id: string;
  name: string;
  shortName: string;
  /** `game_id` que espera el proveedor Inefable (Free Fire = -1, Blood Strike = 15). */
  apiGameId: number;
  /** `game_type` del proveedor: `freefire_id`, `dynamic`. */
  apiGameType: string;
  /** Cómo se llama la moneda del juego en la interfaz: Diamantes, Gold… */
  currencyLabel: string;
  currencyIcon: string;
  /** Etiqueta del campo de ID: "ID de Jugador". */
  playerIdLabel: string;
  /** Regex (como string) que valida el ID. Por defecto `^\\d{8,12}$`. */
  playerIdPattern: string;
  playerIdHelp: string;
  /** Pasos para que el jugador encuentre su ID dentro del juego. */
  howToFindId: string[];
  logoUrl: string;
  coverUrl: string;
  /** Color de acento en HEX, usado para los degradados de la tarjeta. */
  accentColor: string;
  accentColorSecondary: string;
  active: boolean;
  sortOrder: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

/** Modalidad de entrega: `auto` despacha por API, `manual` va por WhatsApp. */
export type FulfillmentType = 'auto' | 'manual';

/** Naturaleza comercial del producto (afecta cómo se pinta la tarjeta). */
export type ProductKind = 'package' | 'combo' | 'special';

/**
 * Una llamada al API de despacho. Los combos se expresan como varias llamadas
 * en secuencia: 830+83 💎 = [{packageId: 3}, {packageId: 2}].
 */
export interface DispatchCall {
  packageId: number;
  quantity: number;
}

export interface Product {
  id: string;
  gameId: string;
  /** Código interno legible, p. ej. `FF-D-310`. */
  sku: string;
  name: string;
  description: string;
  fulfillment: FulfillmentType;
  kind: ProductKind;
  /** Cantidad base de moneda del juego (sin bono). */
  amount: number;
  /** Bono incluido. */
  bonus: number;
  /** Costo real que nos cobra el proveedor, en USD. Nunca se expone al cliente. */
  costUsd: number;
  /** Precio de venta al público, en USD. */
  priceUsd: number;
  /** Precio tachado para mostrar descuento. `null` si no aplica. */
  compareAtUsd: number | null;
  /** Secuencia de llamadas al proveedor. Vacío en productos manuales. */
  calls: DispatchCall[];
  imageUrl: string;
  badge: string | null;
  active: boolean;
  featured: boolean;
  sortOrder: number;
  /** `null` = stock ilimitado. */
  stock: number | null;
  deliveryEtaMinutes: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** Producto tal como lo ve el cliente: sin costo ni configuración de llamadas. */
export type PublicProduct = Omit<Product, 'costUsd' | 'calls' | 'createdAt' | 'updatedAt'> & {
  priceBs: number;
};

// ---------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------

export type OrderStatus =
  /** Creada; esperando que el cliente pague y envíe la referencia. */
  | 'awaiting_payment'
  /** Referencia recibida; consultando a Pabilo. */
  | 'verifying'
  /** Pabilo rechazó la referencia (no existe, monto distinto o ya usada). */
  | 'payment_rejected'
  /** Pago confirmado; aún no se despacha. */
  | 'paid'
  /** Ejecutando las llamadas al proveedor. */
  | 'dispatching'
  /** Producto manual pagado; pendiente de gestión humana por WhatsApp. */
  | 'awaiting_manual'
  /** Entregado al jugador. */
  | 'completed'
  /** Pago cobrado pero el despacho falló: requiere intervención del admin. */
  | 'failed'
  | 'refunded'
  | 'cancelled'
  /** Nunca se pagó dentro del tiempo límite. */
  | 'expired';

/** Estados en los que el dinero ya entró. */
export const PAID_STATUSES: OrderStatus[] = [
  'paid',
  'dispatching',
  'awaiting_manual',
  'completed',
  'failed',
];

/** Estados terminales: la orden ya no cambia sola. */
export const TERMINAL_STATUSES: OrderStatus[] = [
  'completed',
  'refunded',
  'cancelled',
  'expired',
  'payment_rejected',
];

export type DispatchCallStatus = 'pending' | 'success' | 'error';

export interface DispatchCallResult {
  packageId: number;
  index: number;
  status: DispatchCallStatus;
  /** ID de orden devuelto por el proveedor. Ojo: también viene en los fallos. */
  providerOrderId: string | null;
  providerStatus: string | null;
  /** Nick del jugador, cuando el proveedor lo resuelve. */
  playerName: string | null;
  /** Referencia del proveedor: es lo que se cita al reclamar una entrega. */
  providerReference: string | null;
  error: string | null;
  /**
   * Código HTTP y cuerpo crudo de la última respuesta del proveedor.
   *
   * Se guardan porque sin ellos un fallo de despacho es indepurable: la orden
   * sólo mostraba un mensaje genérico y no había forma de distinguir una ruta
   * equivocada de un saldo insuficiente o de una caída del proveedor.
   */
  httpStatus: number | null;
  providerResponse: Record<string, unknown> | null;
  attempts: number;
  completedAt: TimestampLike | null;
}

export interface OrderPricing {
  /** Precio unitario de lista en USD. */
  unitUsd: number;
  quantity: number;
  subtotalUsd: number;
  discountUsd: number;
  totalUsd: number;
  /** Tasa Bs/USD congelada al crear la orden. */
  rate: number;
  /** Monto exacto a pagar en bolívares (lo que se compara contra Pabilo). */
  totalBs: number;
  couponCode: string | null;
  /** Costo del proveedor, para calcular utilidad. Sólo lo ve el staff. */
  costUsd: number;
  profitUsd: number;
}

export interface OrderPayment {
  method: 'pagomovil_bdv';
  reference: string | null;
  verifiedAt: TimestampLike | null;
  attempts: number;
  /** Eco de la respuesta relevante de Pabilo, para auditoría. */
  providerResponse: Record<string, unknown> | null;
  /** Datos bancarios mostrados al cliente, congelados en la orden. */
  bankSnapshot: {
    code: string;
    name: string;
    idNumber: string;
    phone: string;
  };
}

export interface Order {
  id: string;
  /** Código corto y legible que ve el cliente: `RF-8K3M2Q`. */
  code: string;
  uid: string;
  user: {
    email: string | null;
    displayName: string | null;
    photoURL: string | null;
  };
  gameId: string;
  gameName: string;
  productId: string;
  productName: string;
  productSku: string;
  fulfillment: FulfillmentType;
  playerId: string;
  pricing: OrderPricing;
  payment: OrderPayment;
  dispatch: {
    calls: DispatchCallResult[];
    startedAt: TimestampLike | null;
    completedAt: TimestampLike | null;
    lastError: string | null;
  };
  /** Enlace precargado de WhatsApp para productos manuales. */
  whatsappUrl: string | null;
  status: OrderStatus;
  customerNote: string | null;
  adminNote: string | null;
  /** Metadatos anti-fraude. */
  meta: {
    ip: string | null;
    userAgent: string | null;
  };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  /** Momento en que la orden caduca si no se paga. */
  expiresAt: TimestampLike;
}

/** Evento del historial de una orden (subcolección `orders/{id}/events`). */
export interface OrderEvent {
  id: string;
  type: string;
  message: string;
  status: OrderStatus | null;
  actor: 'system' | 'customer' | 'admin';
  actorUid: string | null;
  data: Record<string, unknown> | null;
  createdAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------

export type UserRole = 'user' | 'staff' | 'admin';
export type UserTier = 'bronce' | 'plata' | 'oro' | 'diamante';

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  phone: string | null;
  role: UserRole;
  banned: boolean;
  bannedReason: string | null;
  /** Saldo a favor en USD (reembolsos, promociones). */
  walletBalanceUsd: number;
  points: number;
  tier: UserTier;
  referralCode: string;
  referredBy: string | null;
  referralCount: number;
  stats: {
    totalOrders: number;
    completedOrders: number;
    totalSpentUsd: number;
    lastOrderAt: TimestampLike | null;
  };
  preferences: {
    notifyEmail: boolean;
    notifyOrderUpdates: boolean;
  };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  lastLoginAt: TimestampLike | null;
}

/** ID de jugador guardado por el usuario (`users/{uid}/playerIds/{id}`). */
export interface SavedPlayerId {
  id: string;
  gameId: string;
  playerId: string;
  label: string;
  isDefault: boolean;
  createdAt: TimestampLike;
}

export interface UserNotification {
  id: string;
  title: string;
  body: string;
  type: 'order' | 'promo' | 'system';
  link: string | null;
  read: boolean;
  readAt: TimestampLike | null;
  createdAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// Cupones
// ---------------------------------------------------------------------------

export interface Coupon {
  /** El código en mayúsculas es también el ID del documento. */
  code: string;
  description: string;
  type: 'percent' | 'fixed';
  /** Porcentaje (0-100) o monto fijo en USD según `type`. */
  value: number;
  minOrderUsd: number;
  maxDiscountUsd: number | null;
  usageLimit: number | null;
  usageCount: number;
  perUserLimit: number;
  validFrom: TimestampLike | null;
  validUntil: TimestampLike | null;
  /** Restricciones opcionales; vacío = aplica a todo. */
  gameIds: string[];
  productIds: string[];
  active: boolean;
  createdAt: TimestampLike;
  createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Configuración de la tienda (`config/app`)
// ---------------------------------------------------------------------------

export interface AppConfig {
  storeName: string;
  tagline: string;
  rate: {
    /** Bolívares por dólar. */
    value: number;
    source: 'manual' | 'auto';
    /** Porcentaje sumado a la tasa de referencia cuando `source = auto`. */
    markupPercent: number;
    autoRefresh: boolean;
    updatedAt: TimestampLike | null;
    updatedBy: string | null;
  };
  bank: {
    code: string;
    name: string;
    idNumber: string;
    phone: string;
    holder: string;
  };
  whatsapp: {
    adminNumber: string;
    supportNumber: string;
  };
  checkout: {
    referenceMinLength: number;
    referenceMaxLength: number;
    orderExpiryMinutes: number;
    /** Tolerancia (%) permitida entre lo pagado y lo esperado. */
    amountTolerancePercent: number;
    maxVerifyAttempts: number;
    maxOpenOrdersPerUser: number;
  };
  features: {
    maintenanceMode: boolean;
    maintenanceMessage: string;
    autoDispatchEnabled: boolean;
    manualProductsEnabled: boolean;
    couponsEnabled: boolean;
    referralsEnabled: boolean;
  };
  announcement: {
    enabled: boolean;
    text: string;
    type: 'info' | 'success' | 'warning';
  };
  pricing: {
    /** Margen por defecto al sembrar o recalcular precios. */
    defaultMarginPercent: number;
    /** Redondeo del precio final en USD (0.05 = múltiplos de 5 centavos). */
    roundToUsd: number;
    /** Redondeo del monto en bolívares (0.01 = céntimos). */
    roundToBs: number;
  };
  contact: {
    email: string;
    instagram: string;
    telegram: string;
  };
  updatedAt: TimestampLike | null;
  updatedBy: string | null;
}

/** Subconjunto de la configuración que se expone públicamente. */
export interface PublicConfig {
  storeName: string;
  tagline: string;
  rate: number;
  bank: AppConfig['bank'];
  whatsapp: { supportNumber: string };
  checkout: AppConfig['checkout'];
  features: Pick<
    AppConfig['features'],
    'maintenanceMode' | 'maintenanceMessage' | 'couponsEnabled' | 'referralsEnabled'
  >;
  announcement: AppConfig['announcement'];
  contact: AppConfig['contact'];
}

// ---------------------------------------------------------------------------
// Auditoría, soporte y estadísticas
// ---------------------------------------------------------------------------

export interface AuditLog {
  id: string;
  action: string;
  actorUid: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  data: Record<string, unknown> | null;
  ip: string | null;
  createdAt: TimestampLike;
}

export type TicketStatus = 'open' | 'pending' | 'closed';

export interface Ticket {
  id: string;
  uid: string;
  userEmail: string | null;
  userName: string | null;
  subject: string;
  orderId: string | null;
  status: TicketStatus;
  lastMessagePreview: string;
  unreadForStaff: boolean;
  unreadForUser: boolean;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

export interface TicketMessage {
  id: string;
  body: string;
  authorUid: string;
  authorName: string | null;
  fromStaff: boolean;
  createdAt: TimestampLike;
}

/** Agregado diario (`stats/daily/days/{yyyy-MM-dd}`). */
export interface DailyStats {
  date: string;
  orders: number;
  completedOrders: number;
  failedOrders: number;
  rejectedPayments: number;
  revenueUsd: number;
  revenueBs: number;
  costUsd: number;
  profitUsd: number;
  newUsers: number;
  byGame: Record<string, { orders: number; revenueUsd: number }>;
  byProduct: Record<string, { orders: number; revenueUsd: number }>;
  updatedAt: TimestampLike;
}
