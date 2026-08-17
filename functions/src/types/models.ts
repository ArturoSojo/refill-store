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

/**
 * Un dato que el juego le pide al comprador.
 *
 * No todos los juegos se recargan con un solo número. Mobile Legends exige ID
 * **y** Zone ID (sin el segundo, el proveedor responde «Please insert Zone ID
 * into input2»), y los juegos que se gestionan a mano piden correo y contraseña
 * de la cuenta. Por eso el juego declara su lista de campos en lugar de tener
 * un único ID incrustado en el modelo.
 */
export interface PlayerField {
  /** Clave estable dentro de la orden. El primer campo siempre es `playerId`. */
  key: string;
  label: string;
  /** Regex (como string) que valida el valor. */
  pattern: string;
  /** Mensaje que se muestra cuando el valor no cumple el patrón. */
  help: string;
  placeholder: string;
  /** Cómo se pinta el campo y qué teclado abre en el móvil. */
  type: 'text' | 'number' | 'email' | 'password';
  /**
   * Campo del cuerpo de despacho al que se copia este valor.
   *
   * `player_id` es obligatorio para el proveedor y `player_id2` es el segundo
   * identificador (Zone ID). `null` = el dato sólo sirve para la gestión manual
   * y nunca viaja al API.
   */
  providerField: 'player_id' | 'player_id2' | null;
  required: boolean;
  /**
   * Dato sensible (contraseñas). No se escribe en la bitácora ni en el mensaje
   * de WhatsApp; sólo se guarda en la orden para que el equipo pueda entregarla.
   */
  sensitive: boolean;
}

/** Campo único por defecto: el ID numérico de toda la vida. */
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
  /** Imagen de la moneda. Si está vacía se cae al emoji de `currencyIcon`. */
  currencyIconUrl: string;
  /**
   * Campos que se le piden al comprador, en orden.
   *
   * Vacío = juego antiguo; se reconstruye un único campo a partir de
   * `playerIdLabel`/`playerIdPattern`/`playerIdHelp`.
   */
  playerFields: PlayerField[];
  /**
   * `true` si el proveedor rechaza un ID inexistente.
   *
   * Sólo Free Fire lo hace (responde «Error de ID del jugador»). Los juegos
   * `dynamic` aceptan cualquier número y devuelven «completada»: el dinero se
   * gasta igual. Cuando esto es `false` la tienda exige confirmar el ID antes
   * de cobrar, porque un dígito mal escrito no se puede recuperar.
   */
  validatesPlayerId: boolean;
  /** Etiqueta del campo de ID: "ID de Jugador". Legado; ver `playerFields`. */
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
  /**
   * Saldo a favor descontado del total, en USD.
   *
   * Se debita de la cartera al crear la orden (así no se puede gastar dos veces
   * en compras simultáneas) y se devuelve si la orden se cancela o caduca.
   */
  walletAppliedUsd: number;
  /** Lo que queda por transferir tras aplicar el saldo. `0` = pagada con saldo. */
  amountDueUsd: number;
  /** Tasa Bs/USD congelada al crear la orden. */
  rate: number;
  /** Monto exacto a pagar en bolívares (lo que se compara contra Pabilo). */
  totalBs: number;
  couponCode: string | null;
  /** Código de creador usado, si hubo. */
  creatorCode: string | null;
  /** Costo del proveedor, para calcular utilidad. Sólo lo ve el staff. */
  costUsd: number;
  profitUsd: number;
}

export interface OrderPayment {
  /** `wallet` cuando el saldo a favor cubrió el total y no hubo transferencia. */
  method: 'pagomovil_bdv' | 'wallet';
  reference: string | null;
  /**
   * Monto que el banco reporta para esa referencia.
   *
   * Puede no coincidir con `pricing.totalBs`: la tolerancia admite pequeñas
   * diferencias, y sin guardar el importe real no habría forma de saber cuánto
   * entró de verdad ni de cuadrar la caja.
   */
  reportedAmountBs: number | null;
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
  /**
   * `game_id` del proveedor, congelado al crear la orden.
   *
   * Viaja en el campo `product_id` del despacho. Se guarda en la orden —y no se
   * lee del catálogo al despachar— para que un cambio posterior en el juego no
   * altere cómo se entrega una orden que ya se cotizó.
   */
  providerGameId: number | null;
  productId: string;
  productName: string;
  productSku: string;
  /**
   * Cuánto entrega UNA unidad, congelado al comprar.
   *
   * Permite decirle al cliente el total cuando lleva varias («2× 100 + 10
   * Diamantes (200 + 20 en total)»). Va en la orden y no se lee del catálogo
   * porque el producto puede cambiar de cantidad más adelante, y esta compra
   * tiene que seguir describiéndose como se vendió.
   */
  productAmount: number | null;
  productBonus: number | null;
  fulfillment: FulfillmentType;
  /** Valor del campo principal; viaja como `player_id`. */
  playerId: string;
  /** Segundo identificador (Zone ID). `null` si el juego no lo pide. */
  playerId2: string | null;
  /**
   * Todos los datos que se le pidieron al comprador, por clave de campo.
   *
   * Se congelan aquí porque el juego puede cambiar de campos más adelante y
   * esta orden tiene que seguir siendo legible tal como se compró.
   */
  playerFields: Record<string, string>;
  pricing: OrderPricing;
  /**
   * Creador al que se atribuye la venta, congelado al comprar.
   *
   * Va aparte de `pricing.creatorCode` porque lleva el porcentaje vigente en
   * ese momento: cambiar la comisión después no puede recalcular lo ya vendido.
   * Nunca se envía al cliente (`toCustomerOrder` lo quita).
   */
  creator: OrderCreatorRef | null;
  payment: OrderPayment;
  dispatch: {
    calls: DispatchCallResult[];
    startedAt: TimestampLike | null;
    completedAt: TimestampLike | null;
    lastError: string | null;
  };
  /** Enlace precargado de WhatsApp para productos manuales. */
  whatsappUrl: string | null;
  /**
   * Correos ya enviados al cliente por esta orden.
   *
   * Evita que un reintento del panel le mande la factura por segunda vez: un
   * comprobante duplicado confunde y parece un cobro repetido.
   */
  emailsSent: string[];
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
/** Un escalón de la escalera de fidelidad. Los umbrales viven en `config/app.tiers`. */
export interface TierDefinition {
  tier: UserTier;
  label: string;
  /** Gasto acumulado (en USD) a partir del cual se entra al nivel. */
  minSpentUsd: number;
  /** Descuento permanente, en porcentaje. */
  discountPercent: number;
  /** Cómo se describe al cliente en ese escalón. */
  profile: string;
}

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
  /** Resto de campos del juego (Zone ID…). Nunca guarda contraseñas. */
  playerFields: Record<string, string>;
  label: string;
  isDefault: boolean;
  createdAt: TimestampLike;
}

/**
 * Movimiento de la cartera (`users/{uid}/wallet/{id}`).
 *
 * El saldo vive en `UserProfile.walletBalanceUsd`, pero sin un libro de
 * movimientos un reembolso es indistinguible de un error: esta subcolección es
 * la que permite responder «¿de dónde salió este saldo?».
 */
export interface WalletTransaction {
  id: string;
  type: 'credit' | 'debit';
  /** Siempre positivo; el signo lo da `type`. */
  amountUsd: number;
  balanceAfterUsd: number;
  reason: string;
  orderId: string | null;
  orderCode: string | null;
  /** Quién lo hizo: `null` cuando lo genera el propio sistema. */
  actorUid: string | null;
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
// Creadores de contenido
// ---------------------------------------------------------------------------

/**
 * Perfil de creador. El id del documento es el uid del usuario.
 *
 * Ser creador NO es un `UserRole`: el rol viaja en los claims del token y
 * `ensureProfile` lo sobrescribe con lo que diga el claim, así que un rol
 * guardado sólo en Firestore se revertiría solo. Además los roles son
 * excluyentes entre sí (un creador no podría ser staff) y cambiarlos cierra la
 * sesión del usuario, cosa que ajustar una comisión no debería hacer.
 */
export interface Creator {
  uid: string;
  /** Código que comparte con su audiencia, en mayúsculas y único. */
  code: string;
  active: boolean;
  /** Comisión sobre cada compra hecha con su código, en porcentaje. */
  commissionPercent: number;
  /** Descuento que recibe el comprador por usar el código, en porcentaje. */
  discountPercent: number;
  /** Denormalizados para poder listar creadores sin leer cada perfil. */
  displayName: string | null;
  email: string | null;
  notes: string | null;
  stats: {
    orders: number;
    salesUsd: number;
    /** Comisión devengada y todavía no pagada. */
    pendingUsd: number;
    paidUsd: number;
    /** Comisión anulada por reembolsos. */
    revertedUsd: number;
  };
  createdAt: TimestampLike;
  updatedAt: TimestampLike;
}

/** Estado de un asiento del libro de comisiones. */
export type CommissionStatus = 'pending' | 'paid' | 'reverted';

/**
 * Una comisión devengada, en `creators/{uid}/commissions/{orderId}`.
 *
 * El id del documento es el de la orden a propósito: escribirlo con `create()`
 * hace que un segundo devengo de la misma orden falle en vez de pagar dos veces.
 *
 * No guarda quién compró: el creador puede leer su propio libro y no tiene por
 * qué conocer la identidad de sus compradores.
 */
export interface CommissionEntry {
  orderId: string;
  orderCode: string;
  status: CommissionStatus;
  /** Base de cálculo: el total de la orden tras descuentos. */
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

/** Referencia al creador congelada en la orden, en el momento de comprar. */
export interface OrderCreatorRef {
  uid: string;
  code: string;
  /** Porcentaje vigente al comprar: cambiarlo después no altera lo ya vendido. */
  commissionPercent: number;
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
    /** Permite pagar con el saldo a favor acumulado. */
    walletEnabled: boolean;
  };
  /**
   * Correos al cliente.
   *
   * Se envían por el SMTP de la propia cuenta de Gmail de la tienda. Es la
   * opción con mejor entrega mientras no haya dominio propio: el correo sale de
   * verdad desde Google, con su firma DKIM, en lugar de que un tercero escriba
   * «en nombre de» una dirección `@gmail.com` —que es lo que acaba en Spam—.
   *
   * Tope de Gmail: 500 correos al día en cuentas normales.
   */
  email: {
    enabled: boolean;
    /** Cuenta de Gmail que envía. Su contraseña va en `GMAIL_APP_PASSWORD`. */
    fromAddress: string;
    /** Nombre que ve el cliente como remitente. */
    fromName: string;
    /** Dirección a la que responde el cliente si contesta el correo. */
    replyTo: string;
    onPaymentVerified: boolean;
    onDelivered: boolean;
    onDispatchFailed: boolean;
  };
  /**
   * Avisos al equipo cuando algo necesita una persona.
   *
   * Telegram es el canal de empuje real (gratis y sin depender del móvil del
   * dueño); el webhook existe para enrutar el mismo aviso a correo, WhatsApp o
   * lo que sea desde Make/Zapier/n8n sin tocar este código.
   */
  alerts: {
    enabled: boolean;
    /** Chat o canal de Telegram donde escribe el bot. */
    telegramChatId: string;
    /** URL que recibe el aviso como JSON (`POST`). */
    webhookUrl: string;
    notifyOnDispatchFailed: boolean;
    notifyOnManualOrder: boolean;
    notifyOnNewTicket: boolean;
    notifyOnPaymentRejected: boolean;
    /** Avisa cuando el saldo del proveedor baja de este monto. */
    lowBalanceThresholdUsd: number;
  };
  features: {
    maintenanceMode: boolean;
    maintenanceMessage: string;
    autoDispatchEnabled: boolean;
    manualProductsEnabled: boolean;
    couponsEnabled: boolean;
    referralsEnabled: boolean;
    creatorsEnabled: boolean;
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
  /** Escalera de fidelidad, editable desde el panel. Ver `lib/tiers.ts`. */
  tiers: TierDefinition[];
  updatedAt: TimestampLike | null;
  updatedBy: string | null;
}

/**
 * Aviso para el equipo (`adminAlerts/{id}`).
 *
 * Se guarda siempre, aunque Telegram o el webhook fallen: la bandeja del panel
 * es el canal que no depende de nada externo.
 */
export interface AdminAlert {
  id: string;
  kind:
    | 'dispatch_failed'
    | 'manual_order'
    | 'new_ticket'
    | 'ticket_reply'
    | 'payment_rejected'
    | 'low_balance'
    | 'provider_down'
    | 'test';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  /** Ruta interna del panel a la que lleva el aviso. */
  link: string | null;
  data: Record<string, unknown> | null;
  read: boolean;
  readAt: TimestampLike | null;
  /** Resultado del envío por cada canal externo, para poder depurarlo. */
  delivery: {
    telegram: 'sent' | 'failed' | 'skipped';
    webhook: 'sent' | 'failed' | 'skipped';
  };
  createdAt: TimestampLike;
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
    | 'maintenanceMode'
    | 'maintenanceMessage'
    | 'couponsEnabled'
    | 'referralsEnabled'
    | 'creatorsEnabled'
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

/** Una fila del desglose: lo vendido de un juego o de un producto. */
export interface BreakdownEntry {
  orders: number;
  revenueUsd: number;
  /** Lo que costó al proveedor. */
  costUsd: number;
  /** Ingreso menos costo: lo que realmente queda. */
  profitUsd: number;
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
  /**
   * Desglose por juego y por producto.
   *
   * Lleva el costo del proveedor además del ingreso: sin él, el panel sólo
   * podía mostrar cuánto entró, que no es lo mismo que cuánto se ganó. Un
   * paquete grande factura mucho y deja poco; uno pequeño al revés.
   */
  byGame: Record<string, BreakdownEntry>;
  byProduct: Record<string, BreakdownEntry>;
  updatedAt: TimestampLike;
}
