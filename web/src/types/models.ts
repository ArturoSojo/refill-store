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

export interface Game {
  id: string;
  name: string;
  shortName: string;
  apiGameId: number;
  apiGameType: string;
  currencyLabel: string;
  currencyIcon: string;
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

export type FulfillmentType = 'auto' | 'manual';
export type ProductKind = 'package' | 'combo' | 'special';

export interface DispatchCall {
  packageId: number;
  quantity: number;
}

export interface Product {
  id: string;
  gameId: string;
  sku: string;
  name: string;
  description: string;
  fulfillment: FulfillmentType;
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

export type DispatchCallStatus = 'pending' | 'success' | 'error';

export interface DispatchCallResult {
  packageId: number;
  index: number;
  status: DispatchCallStatus;
  /** Ojo: el proveedor también devuelve `order_id` cuando la recarga falla. */
  providerOrderId: string | null;
  providerStatus: string | null;
  playerName: string | null;
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
  rate: number;
  totalBs: number;
  couponCode: string | null;
  /** Sólo presente para staff. */
  costUsd?: number;
  profitUsd?: number;
}

export interface OrderPayment {
  method: 'pagomovil_bdv';
  reference: string | null;
  verifiedAt: TimestampLike;
  attempts: number;
  providerResponse: Record<string, unknown> | null;
  bankSnapshot: {
    code: string;
    name: string;
    idNumber: string;
    phone: string;
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
  pricing: OrderPricing;
  payment: OrderPayment;
  dispatch: {
    calls: DispatchCallResult[];
    startedAt: TimestampLike;
    completedAt: TimestampLike;
    lastError: string | null;
  };
  whatsappUrl: string | null;
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
  readAt: TimestampLike;
  createdAt: TimestampLike;
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
  whatsapp: { supportNumber: string };
  checkout: {
    referenceMinLength: number;
    referenceMaxLength: number;
    orderExpiryMinutes: number;
    amountTolerancePercent: number;
    maxVerifyAttempts: number;
    maxOpenOrdersPerUser: number;
  };
  features: {
    maintenanceMode: boolean;
    maintenanceMessage: string;
    couponsEnabled: boolean;
    referralsEnabled: boolean;
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

export interface CreateOrderResponse {
  order: Order;
  payment: {
    bank: OrderPayment['bankSnapshot'];
    amountBs: number;
    amountUsd: number;
    rate: number;
    expiresAt: number;
    referenceMinLength: number;
    referenceMaxLength: number;
  };
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
  totalBs: number;
  rate: number;
  tierPercent: number;
  tier: UserTier;
  couponCode: string | null;
  couponError: string | null;
}

export interface MeResponse {
  profile: UserProfile;
  isAdmin: boolean;
  isStaff: boolean;
  unreadNotifications: number;
  recentOrders: Order[];
  tierDiscountPercent: number;
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
    byGame: Record<string, { orders: number; revenueUsd: number }>;
    byProduct: Record<string, { orders: number; revenueUsd: number }>;
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
  pabilo: { configured: boolean };
  inefable: {
    configured: boolean;
    reachable: boolean;
    balanceUsd: number | null;
    accountName: string | null;
    message: string | null;
  };
}

export interface TopProductsResponse {
  products: Array<{
    productId: string;
    name: string;
    gameId: string | null;
    orders: number;
    revenueUsd: number;
  }>;
  byGame: Record<string, { orders: number; revenueUsd: number }>;
}
