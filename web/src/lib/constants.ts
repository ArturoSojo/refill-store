/** Constantes compartidas por la interfaz. */

export const APP_NAME = 'Refill Store';

/** Rutas de la tienda, centralizadas para no repetir cadenas por todo el árbol. */
export const ROUTES = {
  home: '/',
  game: (slug: string) => `/juego/${slug}`,
  checkout: (productId: string) => `/comprar/${productId}`,
  order: (orderId: string) => `/orden/${orderId}`,
  orders: '/mis-ordenes',
  account: '/cuenta',
  playerIds: '/cuenta/ids',
  wallet: '/cuenta/saldo',
  referrals: '/cuenta/referidos',
  notifications: '/cuenta/notificaciones',
  support: '/soporte',
  ticket: (id: string) => `/soporte/${id}`,
  faq: '/ayuda',
  login: '/entrar',
  admin: '/admin',
  adminOrders: '/admin/ordenes',
  adminOrder: (id: string) => `/admin/ordenes/${id}`,
  adminProducts: '/admin/productos',
  adminGames: '/admin/juegos',
  adminUsers: '/admin/usuarios',
  adminUser: (id: string) => `/admin/usuarios/${id}`,
  adminCoupons: '/admin/cupones',
  adminTickets: '/admin/soporte',
  adminTicket: (id: string) => `/admin/soporte/${id}`,
  adminAlerts: '/admin/avisos',
  adminSettings: '/admin/configuracion',
  adminLogs: '/admin/bitacora',
} as const;

/** Claves de React Query, agrupadas para poder invalidar por familia. */
export const QUERY_KEYS = {
  config: ['config'] as const,
  catalog: ['catalog'] as const,
  game: (slug: string) => ['game', slug] as const,
  me: ['me'] as const,
  orders: (filters?: string) => ['orders', filters ?? 'all'] as const,
  order: (id: string) => ['order', id] as const,
  playerIds: ['player-ids'] as const,
  wallet: ['wallet'] as const,
  notifications: ['notifications'] as const,
  tickets: ['tickets'] as const,
  ticket: (id: string) => ['ticket', id] as const,
  adminOverview: (days: number) => ['admin', 'overview', days] as const,
  adminTopProducts: (days: number) => ['admin', 'top-products', days] as const,
  adminOrders: (filters: string) => ['admin', 'orders', filters] as const,
  adminOrder: (id: string) => ['admin', 'order', id] as const,
  adminProducts: (gameId?: string) => ['admin', 'products', gameId ?? 'all'] as const,
  adminGames: ['admin', 'games'] as const,
  adminUsers: (filters: string) => ['admin', 'users', filters] as const,
  adminUser: (id: string) => ['admin', 'user', id] as const,
  adminCoupons: ['admin', 'coupons'] as const,
  adminConfig: ['admin', 'config'] as const,
  adminLogs: (filters: string) => ['admin', 'logs', filters] as const,
  adminTickets: (status?: string) => ['admin', 'tickets', status ?? 'all'] as const,
  adminRateHistory: ['admin', 'rate-history'] as const,
  adminProviders: ['admin', 'providers'] as const,
  adminAlerts: (filters: string) => ['admin', 'alerts', filters] as const,
  adminEmail: ['admin', 'email'] as const,
  adminUserWallet: (id: string) => ['admin', 'user-wallet', id] as const,
} as const;

/** Estados en los que conviene escuchar la orden en tiempo real. */
export const LIVE_ORDER_STATUSES = ['verifying', 'paid', 'dispatching', 'failed'];

export const ORDER_STATUS_OPTIONS = [
  { value: 'awaiting_payment', label: 'Esperando pago' },
  { value: 'verifying', label: 'Verificando' },
  { value: 'payment_rejected', label: 'Pago rechazado' },
  { value: 'paid', label: 'Pagado' },
  { value: 'dispatching', label: 'Despachando' },
  { value: 'awaiting_manual', label: 'Manual pendiente' },
  { value: 'completed', label: 'Completado' },
  { value: 'failed', label: 'En revisión' },
  { value: 'refunded', label: 'Reembolsado' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'expired', label: 'Expirado' },
] as const;

/** Colores de acento por juego, con respaldo si el juego no define el suyo. */
export const FALLBACK_ACCENT = '#F03030';
export const FALLBACK_ACCENT_SECONDARY = '#3018F0';

export const PASOS_CHECKOUT = [
  { id: 'player', label: 'Tu ID' },
  { id: 'review', label: 'Resumen' },
  { id: 'payment', label: 'Pago' },
  { id: 'result', label: 'Listo' },
] as const;
