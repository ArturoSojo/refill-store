/**
 * Modelos de dominio (espejo de `functions/src/types/models.ts`).
 *
 * Diferencia importante: aquí las fechas pueden llegar en tres formas distintas
 * según por dónde vengan los datos:
 *   - `{ _seconds, _nanoseconds }`  → JSON serializado por el Admin SDK (la API).
 *   - `Timestamp` del SDK web       → suscripciones en tiempo real a Firestore.
 *   - `number`                      → milisegundos, en algunos campos calculados.
 * Por eso `TimestampLike` es una unión y siempre se lee con `toMillis()` de
 * `lib/format.ts`, nunca accediendo a los campos directamente.
 */

export type TimestampLike =
  | { _seconds: number; _nanoseconds: number }
  | { seconds: number; nanoseconds: number }
  | { toMillis: () => number; toDate: () => Date }
  | number
  | string
  | null;

// ---------------------------------------------------------------------------
// Juegos y productos
// ---------------------------------------------------------------------------

/** Un dato que el juego le pide al comprador (ID, Zone ID, correo, clave…). */
export interface PlayerField {
  key: string;
  label: string;
  /** Regex como cadena. */
  pattern: string;
  help: string;
  placeholder: string;
  type: 'text' | 'number' | 'email' | 'password';
  /** Campo del proveedor al que se copia. `null` = sólo para entrega manual. */
  providerField: 'player_id' | 'player_id2' | null;
  required: boolean;
  /** Contraseñas: no se guardan como acceso rápido ni se muestran en listas. */
  sensitive: boolean;
}

export const DEFAULT_PLAYER_FIELD: PlayerField = {
  key: 'playerId',
  label: 'ID de Jugador',
  pattern: '^\\d{8,12}$',
  help: 'El ID tiene entre 8 y 12 dígitos, sólo números.',
  placeholder: 'Ej: 3363122817',
  type: 'number',
  providerField: 'player_id',
  required: true,
  sensitive: false,
};

export interface Game {
  id: string;
  name: string;
  shortName: string;
  apiGameId: number;
  apiGameType: string;
  currencyLabel: string;
  currencyIcon: string;
  currencyIconUrl: string;
  /** La API siempre lo devuelve resuelto; puede faltar en datos muy antiguos. */
  playerFields: PlayerField[];
  /** `false` = el proveedor acepta cualquier ID y cobra igual. */
  validatesPlayerId: boolean;
  playerIdLabel: string;
  playerIdPattern: string;
  playerIdHelp: string;
  howToFindId: string[];
  logoUrl: string;
  coverUrl: string;
  accentColor: string;
  accentColorSecondary: string;
  active: boolean;
  sortOrder: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

export type PaymentMethod = 'pagomovil_bdv' | 'transfer' | 'wallet';

export type FulfillmentType = 'auto' | 'manual';

/**
 * Qué pasa con una entrega manual después de que el cliente paga.
 *
 * Antes todas empujaban al cliente a WhatsApp, porque no había otra forma de
 * enterarse de que alguien había pagado algo manual. Con los avisos de Telegram
 * ya no hace falta: el cliente se queda tranquilo en la tienda y el equipo se
 * entera igual.
 *
 *  - `notify`   Nada que hacer para el cliente: se le avisa por notificación y
 *               por correo cuando quede lista. Es el comportamiento por defecto.
 *  - `whatsapp` Se le ofrece el botón para abrir el chat, como antes. Para
 *               productos donde hace falta coordinar algo con él.
 *  - `phone`    Se le pide el teléfono al comprar y llega en el aviso al equipo,
 *               para que sea la tienda quien escriba. Mejor que `whatsapp`
 *               cuando el cliente no tiene por qué dar el primer paso.
 */
export type ManualFlow = 'notify' | 'whatsapp' | 'phone';

export type ProductKind = 'package' | 'combo' | 'special';

export interface DispatchCall {
  packageId: number;
  quantity: number;
  /**
   * Juego del proveedor para ESTA llamada. `null` = el del juego.
   *
   * El proveedor vende el mismo diamante desde varias «tiendas» a precios
   * distintos, y no siempre gana la misma: hoy «Free fire» es la más barata en
   * todo menos en el 520, donde gana «Free fire 20%». Sin esto habría que
   * elegir una sola para todo el juego y pagar de más en algún paquete.
   */
  providerGameId?: number | null;
}

export interface Product {
  id: string;
  gameId: string;
  sku: string;
  name: string;
  description: string;
  fulfillment: FulfillmentType;
  manualFlow: ManualFlow;
  kind: ProductKind;
  amount: number;
  bonus: number;
  costUsd: number;
  priceUsd: number;
  compareAtUsd: number | null;
  calls: DispatchCall[];
  imageUrl: string;
  badge: string | null;
  active: boolean;
  featured: boolean;
  sortOrder: number;
  stock: number | null;
  deliveryEtaMinutes: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** Producto tal como lo devuelve el catálogo público (sin costo ni `calls`). */
export interface PublicProduct {
  id: string;
  gameId: string;
  sku: string;
  name: string;
  description: string;
  fulfillment: FulfillmentType;
  manualFlow: ManualFlow;
  kind: ProductKind;
  amount: number;
  bonus: number;
  priceUsd: number;
  priceBs: number;
  compareAtUsd: number | null;
  imageUrl: string;
  badge: string | null;
  active: boolean;
  featured: boolean;
  sortOrder: number;
  stock: number | null;
  deliveryEtaMinutes: number;
}

// ---------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------

export type OrderStatus =
  | 'awaiting_payment'
  | 'verifying'
  | 'payment_rejected'
  | 'paid'
  | 'dispatching'
  | 'awaiting_manual'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'cancelled'
  | 'expired';

/**
 * Estado de una llamada al proveedor.
 *
 * `processing` es el caso que se pasaba por alto: el proveedor responde HTTP
 * 202 «your request has been submited, please check transaction for status» y
 * termina la recarga minutos después. Eso NO es un fallo, y sobre todo NO se
 * puede reintentar: el pedido ya está puesto y repetirlo cobraría dos veces.
 * Se resuelve consultando el estado al proveedor.
 */
export type DispatchCallStatus = 'pending' | 'processing' | 'success' | 'error';

export interface DispatchCallResult {
  packageId: number;
  /** Juego del proveedor con el que se envió. `null` = el del juego. */
  providerGameId?: number | null;
  index: number;
  status: DispatchCallStatus;
  /** Ojo: el proveedor también devuelve `order_id` cuando la recarga falla. */
  providerOrderId: string | null;
  providerStatus: string | null;
  playerName: string | null;
  /** Referencia del proveedor, para reclamar una entrega. */
  providerReference: string | null;
  error: string | null;
  /** Código HTTP y cuerpo crudo de la respuesta, para diagnosticar fallos. */
  httpStatus: number | null;
  providerResponse: Record<string, unknown> | null;
  attempts: number;
  completedAt: TimestampLike;
}

export interface OrderPricing {
  unitUsd: number;
  quantity: number;
  subtotalUsd: number;
  discountUsd: number;
  totalUsd: number;
  /** Saldo a favor descontado del total. */
  walletAppliedUsd: number;
  /** Lo que queda por transferir. `0` = pagada íntegra con saldo. */
  amountDueUsd: number;
  rate: number;
  totalBs: number;
  couponCode: string | null;
  creatorCode: string | null;
  /** Sólo presente para staff. */
  costUsd?: number;
  profitUsd?: number;
}

export interface OrderPayment {
  method: PaymentMethod;
  reference: string | null;
  /** Monto real que reporta el banco; puede diferir del total por la tolerancia. */
  reportedAmountBs: number | null;
  /**
   * Pagos parciales ya acreditados a esta orden, en orden de llegada.
   *
   * Existe porque alguien que transfiere de menos no puede quedarse sin la
   * plata ni sin la orden: en vez de rechazar y obligarle a empezar de cero
   * —perdiendo lo transferido y la tasa a la que compró—, el pago se guarda y
   * la orden pasa a pedir sólo lo que falta. Cuando la suma cubre el total, se
   * despacha una sola vez.
   */
  partials: Array<{
    reference: string;
    amountBs: number;
    verifiedAt: TimestampLike;
  }>;
  /** Suma de `partials`, en bolívares. Denormalizado para no recalcularlo. */
  paidBs: number;

  verifiedAt: TimestampLike;
  attempts: number;
  providerResponse: Record<string, unknown> | null;
  bankSnapshot: {
    code: string;
    name: string;
    idNumber: string;
    phone: string;
    accountNumber?: string;
    accountType?: 'corriente' | 'ahorro';
  };
}

export interface Order {
  id: string;
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
  playerId2: string | null;
  /** Todos los datos que pidió el juego, por clave de campo. */
  playerFields: Record<string, string>;
  pricing: OrderPricing;
  payment: OrderPayment;
  dispatch: {
    calls: DispatchCallResult[];
    startedAt: TimestampLike;
    completedAt: TimestampLike;
    lastError: string | null;
  };
  whatsappUrl: string | null;
  contactPhone: string | null;
  status: OrderStatus;
  customerNote: string | null;
  /** Sólo presente para staff. */
  adminNote?: string | null;
  meta?: { ip: string | null; userAgent: string | null };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  expiresAt: TimestampLike;
}

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
export type UserTier =
  | 'hierro'
  | 'bronce'
  | 'plata'
  | 'oro'
  | 'platino'
  | 'esmeralda'
  | 'rubi'
  | 'diamante';

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  phone: string | null;
  role: UserRole;
  banned: boolean;
  bannedReason: string | null;
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
    lastOrderAt: TimestampLike;
  };
  preferences: {
    notifyEmail: boolean;
    notifyOrderUpdates: boolean;
  };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
  lastLoginAt: TimestampLike;
}

export interface SavedPlayerId {
  id: string;
  gameId: string;
  playerId: string;
  /** Campos extra (Zone ID…). Nunca contiene contraseñas. */
  playerFields?: Record<string, string>;
  label: string;
  isDefault: boolean;
  createdAt: TimestampLike;
}

/** Movimiento del saldo a favor (`users/{uid}/wallet`). */
export interface WalletTransaction {
  id: string;
  type: 'credit' | 'debit';
  amountUsd: number;
  balanceAfterUsd: number;
  reason: string;
  orderId: string | null;
  orderCode: string | null;
  actorUid: string | null;
  createdAt: TimestampLike;
}

/** Aviso interno para el equipo. */
export interface AdminAlert {
  id: string;
  kind:
    | 'dispatch_failed'
    | 'manual_order'
    | 'new_ticket'
    | 'ticket_reply'
    | 'payment_rejected'
    | 'low_balance'
    | 'rate_stale'
    | 'provider_down'
    | 'test';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  link: string | null;
  data: Record<string, unknown> | null;
  read: boolean;
  readAt: TimestampLike;
  delivery: {
    telegram: 'sent' | 'failed' | 'skipped';
    webhook: 'sent' | 'failed' | 'skipped';
  };
  createdAt: TimestampLike;
}

export interface UserNotification {
  id: string;
  title: string;
  body: string;
  type: 'order' | 'promo' | 'system';
  link: string | null;
  read: boolean;
  readAt: TimestampLike;
  createdAt: TimestampLike;
}


// ---------------------------------------------------------------------------
// Modales de la tienda
// ---------------------------------------------------------------------------

export type ModalFrequency = 'once' | 'daily' | 'always';
export type ModalPlacement = 'home' | 'store' | 'manual';

/** Ventana superpuesta que explica algo al cliente (cómo recargar, un aviso). */
export interface StoreModal {
  id: string;
  title: string;
  /** Cuerpo en texto. Cada línea se pinta como un paso. */
  body: string;
  videoUrl: string;
  imageUrl: string;
  ctaLabel: string;
  ctaUrl: string;
  active: boolean;
  frequency: ModalFrequency;
  placement: ModalPlacement;
  sortOrder: number;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

// ---------------------------------------------------------------------------
// Cupones, configuración y soporte
// ---------------------------------------------------------------------------

export interface Coupon {
  code: string;
  description: string;
  type: 'percent' | 'fixed';
  value: number;
  minOrderUsd: number;
  maxDiscountUsd: number | null;
  usageLimit: number | null;
  usageCount: number;
  perUserLimit: number;
  validFrom: TimestampLike;
  validUntil: TimestampLike;
  gameIds: string[];
  productIds: string[];
  active: boolean;
  createdAt: TimestampLike;
  createdBy: string | null;
}

export interface BankInfo {
  code: string;
  name: string;
  idNumber: string;
  phone: string;
  holder: string;
}

export interface PublicConfig {
  storeName: string;
  tagline: string;
  rate: number;
  bank: BankInfo;
  transfer: {
    enabled: boolean;
    code: string;
    name: string;
    idNumber: string;
    holder: string;
    accountNumber: string;
    accountType: 'corriente' | 'ahorro';
  };
  whatsapp: { supportNumber: string };
  checkout: {
    referenceMinLength: number;
    referenceMaxLength: number;
    orderExpiryMinutes: number;
    amountTolerancePercent: number;
    maxVerifyAttempts: number;
    maxOpenOrdersPerUser: number;
    walletEnabled: boolean;
  };
  features: {
    maintenanceMode: boolean;
    maintenanceMessage: string;
    couponsEnabled: boolean;
    referralsEnabled: boolean;
    creatorsEnabled: boolean;
  };
  announcement: {
    enabled: boolean;
    text: string;
    type: 'info' | 'success' | 'warning';
  };
  contact: {
    email: string;
    instagram: string;
    telegram: string;
  };
  supportUrl: string;
  /** Escalera de niveles, servida por el backend (ver `functions/src/lib/tiers.ts`). */
  tiers: TierDefinition[];
}

/** Un escalón de la escalera de fidelidad, tal como lo publica el backend. */
export interface TierDefinition {
  tier: UserTier;
  label: string;
  minSpentUsd: number;
  discountPercent: number;
  profile: string;
}

/** Configuración completa, sólo accesible desde el panel. */
export interface AppConfig extends Omit<PublicConfig, 'rate' | 'whatsapp' | 'supportUrl'> {
  rate: {
    value: number;
    source: 'manual' | 'auto';
    markupPercent: number;
    autoRefresh: boolean;
    updatedAt: TimestampLike;
    updatedBy: string | null;
  };
  whatsapp: { adminNumber: string; supportNumber: string };
  features: PublicConfig['features'] & {
    autoDispatchEnabled: boolean;
    manualProductsEnabled: boolean;
  };
  pricing: {
    defaultMarginPercent: number;
    roundToUsd: number;
    roundToBs: number;
  };
  email: {
    enabled: boolean;
    fromAddress: string;
    fromName: string;
    replyTo: string;
    onPaymentVerified: boolean;
    onDelivered: boolean;
    onDispatchFailed: boolean;
  };
  alerts: {
    enabled: boolean;
    telegramChatId: string;
    webhookUrl: string;
    notifyOnDispatchFailed: boolean;
    notifyOnManualOrder: boolean;
    notifyOnNewTicket: boolean;
    notifyOnPaymentRejected: boolean;
    lowBalanceThresholdUsd: number;
  };
  updatedAt: TimestampLike;
  updatedBy: string | null;
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

// ---------------------------------------------------------------------------
// Respuestas de la API
// ---------------------------------------------------------------------------

export interface CatalogResponse {
  rate: number;
  games: Game[];
  products: PublicProduct[];
}

export interface GameCatalogResponse {
  game: Game;
  rate: number;
  products: PublicProduct[];
}

export interface PaymentInstructions {
  method: PaymentMethod;
  bank: OrderPayment['bankSnapshot'];
  /** Lo que queda por transferir, ya descontados los pagos parciales. */
  amountBs: number;
  totalBs: number;
  paidBs: number;
  partials: OrderPayment['partials'];
  amountUsd: number;
  walletAppliedUsd: number;
  rate: number;
  expiresAt: number;
  referenceMinLength: number;
  referenceMaxLength: number;
}

export interface CreateOrderResponse {
  order: Order;
  payment: PaymentInstructions;
}

/** Etiqueta legible de un campo del juego, para pintar los datos de una orden. */
export interface PlayerFieldLabel {
  key: string;
  label: string;
  sensitive: boolean;
}

export interface VerifyPaymentResponse {
  order: Order;
  verified: boolean;
  message: string;
  whatsappUrl: string | null;
}

export interface PricePreview {
  subtotalUsd: number;
  discountUsd: number;
  totalUsd: number;
  walletEnabled: boolean;
  walletBalanceUsd: number;
  walletAppliedUsd: number;
  amountDueUsd: number;
  totalBs: number;
  rate: number;
  tierPercent: number;
  tier: UserTier;
  couponCode: string | null;
  couponError: string | null;
  creatorCode: string | null;
  creatorError: string | null;
}

export interface MeResponse {
  profile: UserProfile;
  isAdmin: boolean;
  isStaff: boolean;
  unreadNotifications: number;
  recentOrders: Order[];
  tierDiscountPercent: number;
  /** Deriva de tener ficha de creador activa; no es un rol. */
  isCreator: boolean;
}

export interface SeriesPoint {
  date: string;
  orders: number;
  completedOrders: number;
  failedOrders: number;
  revenueUsd: number;
  profitUsd: number;
  newUsers: number;
}

export interface AdminOverview {
  days: number;
  totals: {
    orders: number;
    completedOrders: number;
    failedOrders: number;
    rejectedPayments: number;
    revenueUsd: number;
    revenueBs: number;
    costUsd: number;
    profitUsd: number;
    newUsers: number;
    averageTicketUsd: number;
    conversionRate: number;
    byGame: Record<string, BreakdownEntry>;
    byProduct: Record<string, BreakdownEntry>;
  };
  counters: {
    totalUsers: number;
    pendingOrders: number;
    failedOrders: number;
    awaitingManual: number;
  };
  series: SeriesPoint[];
  trends: { revenue: number; orders: number; profit: number };
  rate: AppConfig['rate'];
  maintenanceMode: boolean;
}

export interface ProvidersStatus {
  pabilo: {
    configured: boolean;
    /** `false` si Pabilo ya no reconoce la cuenta bancaria configurada. */
    accountOk: boolean;
    message: string | null;
  };
  inefable: {
    configured: boolean;
    reachable: boolean;
    balanceUsd: number | null;
    accountName: string | null;
    message: string | null;
  };
}

/** Fila del desglose: lo vendido de un juego o de un producto. */
export interface BreakdownEntry {
  orders: number;
  revenueUsd: number;
  costUsd: number;
  /** Ingreso menos el costo del proveedor: lo que realmente queda. */
  profitUsd: number;
}

export interface TopProductsResponse {
  products: Array<
    BreakdownEntry & {
      productId: string;
      name: string;
      gameId: string | null;
    }
  >;
  byGame: Record<string, BreakdownEntry>;
}

// ---------------------------------------------------------------------------
// Creadores de contenido
// ---------------------------------------------------------------------------

export interface Creator {
  uid: string;
  code: string;
  active: boolean;
  commissionPercent: number;
  discountPercent: number;
  displayName: string | null;
  email: string | null;
  notes: string | null;
  stats: {
    orders: number;
    salesUsd: number;
    pendingUsd: number;
    paidUsd: number;
    revertedUsd: number;
  };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

export type CommissionStatus = 'pending' | 'paid' | 'reverted';

export interface CommissionEntry {
  orderId: string;
  orderCode: string;
  status: CommissionStatus;
  saleUsd: number;
  percent: number;
  amountUsd: number;
  gameId: string;
  gameName: string;
  productName: string;
  payoutId: string | null;
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** Lo que ve el propio creador de su programa. */
export interface CreatorSummary {
  code: string;
  active: boolean;
  commissionPercent: number;
  discountPercent: number;
  stats: Creator['stats'];
}

