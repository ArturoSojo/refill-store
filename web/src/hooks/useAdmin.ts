/** Consultas y mutaciones del panel de administración. */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import type {
  CommissionEntry,
  Creator,
  TierDefinition,
  UserTier,
  AdminAlert,
  AdminOverview,
  AppConfig,
  AuditLog,
  Coupon,
  Game,
  Order,
  OrderEvent,
  PlayerFieldLabel,
  Product,
  ProvidersStatus,
  Ticket,
  TopProductsResponse,
  UserProfile,
  WalletTransaction,
} from '@/types/models';

// --- Dashboard -------------------------------------------------------------

export function useAdminOverview(days: number) {
  return useQuery({
    queryKey: QUERY_KEYS.adminOverview(days),
    queryFn: () => api.get<AdminOverview>(`/admin/overview?days=${days}`),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function useAdminTopProducts(days: number) {
  return useQuery({
    queryKey: QUERY_KEYS.adminTopProducts(days),
    queryFn: () => api.get<TopProductsResponse>(`/admin/top-products?days=${days}`),
    staleTime: 120_000,
  });
}

export function useProvidersStatus() {
  return useQuery({
    queryKey: QUERY_KEYS.adminProviders,
    queryFn: () => api.get<ProvidersStatus>('/admin/providers/status'),
    // El saldo del proveedor cambia con cada venta: conviene refrescarlo más a
    // menudo que el resto de la configuración.
    staleTime: 60_000,
    refetchInterval: 180_000,
  });
}

// --- Órdenes ---------------------------------------------------------------

export interface AdminOrderFilters {
  status?: string;
  gameId?: string;
  fulfillment?: 'auto' | 'manual';
  playerId?: string;
  uid?: string;
  limit?: number;
}

function toQueryString(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Forma de una respuesta paginada del backend. */
type PagedResponse<K extends string, T> = {
  [P in K]: T[];
} & { nextCursor: string | null; total?: number };

export interface PagedList<T> {
  /** Todas las páginas ya cargadas, en un solo arreglo. */
  items: T[];
  /** Total en el servidor con los filtros aplicados. */
  total: number | null;
  isLoading: boolean;
  error: unknown;
  hasMore: boolean;
  loadMore: () => void;
  isLoadingMore: boolean;
}

/**
 * Lista paginada por cursor.
 *
 * Concentra aquí la mecánica —acumular páginas, saber si queda más, pedir la
 * siguiente— para que cada pantalla del panel sólo tenga que pintar `items` y
 * poner el botón de cargar más.
 *
 * El backend devuelve un cursor opaco; el cliente lo reenvía sin interpretarlo.
 */
function usePagedQuery<K extends string, T>(
  key: readonly unknown[],
  path: string,
  field: K,
  options: { staleTime?: number; refetchInterval?: number; enabled?: boolean } = {}
): PagedList<T> {
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const separator = path.includes('?') ? '&' : '?';
      const url = pageParam ? `${path}${separator}cursor=${encodeURIComponent(pageParam)}` : path;
      return api.get<PagedResponse<K, T>>(url);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: options.staleTime ?? 15_000,
    refetchInterval: options.refetchInterval,
    enabled: options.enabled,
  });

  return {
    items: query.data?.pages.flatMap((page) => page[field] as T[]) ?? [],
    // El total sólo viaja en la primera página: no cambia al avanzar y contar
    // en cada petición sería gasto de más.
    total: query.data?.pages[0]?.total ?? null,
    isLoading: query.isLoading,
    error: query.error,
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => void query.fetchNextPage(),
    isLoadingMore: query.isFetchingNextPage,
  };
}

export function useAdminOrders(filters: AdminOrderFilters) {
  const query = toQueryString({ ...filters });

  return usePagedQuery<'orders', Order>(
    QUERY_KEYS.adminOrders(query),
    `/admin/orders${query}`,
    'orders',
    { refetchInterval: 60_000 }
  );
}

export function useAdminOrderSearch(term: string) {
  return useQuery({
    queryKey: ['admin', 'order-search', term],
    queryFn: () => api.get<{ orders: Order[] }>(`/admin/orders/search?q=${encodeURIComponent(term)}`),
    enabled: term.trim().length >= 3,
  });
}

export function useAdminOrder(orderId: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.adminOrder(orderId ?? ''),
    queryFn: () =>
      api.get<{
        order: Order;
        events: OrderEvent[];
        customer: UserProfile | null;
        playerFieldLabels: PlayerFieldLabel[];
      }>(`/admin/orders/${orderId}`),
    enabled: Boolean(orderId),
    refetchInterval: 30_000,
  });
}

/** Invalida todo lo que depende de una orden tras una acción del panel. */
function useOrderInvalidator() {
  const queryClient = useQueryClient();

  return (orderId: string) => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminOrder(orderId) });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'orders'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
  };
}

export function useRetryDispatch() {
  const invalidate = useOrderInvalidator();

  return useMutation({
    mutationFn: (orderId: string) => api.post<{ order: Order }>(`/admin/orders/${orderId}/retry`),
    onSuccess: (_data, orderId) => invalidate(orderId),
  });
}

export function useCompleteOrder() {
  const invalidate = useOrderInvalidator();

  return useMutation({
    mutationFn: ({ orderId, note }: { orderId: string; note?: string }) =>
      api.post<{ order: Order }>(`/admin/orders/${orderId}/complete`, { note }),
    onSuccess: (_data, variables) => invalidate(variables.orderId),
  });
}

export function useRefundOrder() {
  const invalidate = useOrderInvalidator();

  return useMutation({
    mutationFn: ({
      orderId,
      toWallet,
      note,
    }: {
      orderId: string;
      toWallet: boolean;
      note?: string;
    }) => api.post<{ order: Order }>(`/admin/orders/${orderId}/refund`, { toWallet, note }),
    onSuccess: (_data, variables) => invalidate(variables.orderId),
  });
}

export function useSetOrderNote() {
  const invalidate = useOrderInvalidator();

  return useMutation({
    mutationFn: ({ orderId, note }: { orderId: string; note: string }) =>
      api.post<{ order: Order }>(`/admin/orders/${orderId}/note`, { note }),
    onSuccess: (_data, variables) => invalidate(variables.orderId),
  });
}

// --- Catálogo --------------------------------------------------------------

export function useAdminGames() {
  return useQuery({
    queryKey: QUERY_KEYS.adminGames,
    queryFn: () => api.get<{ games: Game[] }>('/admin/games'),
    staleTime: 60_000,
  });
}

export function useAdminProducts(gameId?: string) {
  return useQuery({
    queryKey: QUERY_KEYS.adminProducts(gameId),
    queryFn: () =>
      api.get<{ products: Product[] }>(`/admin/products${gameId ? `?gameId=${gameId}` : ''}`),
    staleTime: 60_000,
  });
}

function useCatalogInvalidator() {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'products'] });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminGames });
    // El catálogo público también cambia: hay que refrescarlo.
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.catalog });
    void queryClient.invalidateQueries({ queryKey: ['game'] });
  };
}

export function useSaveProduct() {
  const invalidate = useCatalogInvalidator();

  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: Record<string, unknown> }) =>
      id
        ? api.patch<{ product: Product }>(`/admin/products/${id}`, data)
        : api.post<{ product: Product }>('/admin/products', data),
    onSuccess: invalidate,
  });
}

export function useDeleteProduct() {
  const invalidate = useCatalogInvalidator();

  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/admin/products/${id}`),
    onSuccess: invalidate,
  });
}

export function useSaveGame() {
  const invalidate = useCatalogInvalidator();

  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: Record<string, unknown> }) =>
      id
        ? api.patch<{ game: Game }>(`/admin/games/${id}`, data)
        : api.post<{ game: Game }>('/admin/games', data),
    onSuccess: invalidate,
  });
}

export function useDeleteGame() {
  const invalidate = useCatalogInvalidator();

  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/admin/games/${id}`),
    onSuccess: invalidate,
  });
}

export function useReprice() {
  const invalidate = useCatalogInvalidator();

  return useMutation({
    mutationFn: (input: {
      marginPercent: number;
      gameId?: string;
      productIds?: string[];
      dryRun?: boolean;
    }) =>
      api.post<{
        updated?: number;
        dryRun?: boolean;
        changes: Array<{ id: string; name?: string; from: number; to: number }>;
      }>('/admin/products/reprice', input),
    onSuccess: (data) => {
      if (!data.dryRun) invalidate();
    },
  });
}

export function useSeedCatalog() {
  const invalidate = useCatalogInvalidator();

  return useMutation({
    mutationFn: (overwritePrices: boolean) =>
      api.post<{
        gamesCreated: number;
        gamesUpdated: number;
        productsCreated: number;
        productsUpdated: number;
        marginPercent: number;
      }>('/admin/catalog/seed', { overwritePrices }),
    onSuccess: invalidate,
  });
}

// --- Usuarios --------------------------------------------------------------

export function useAdminUsers(filters: {
  role?: string;
  search?: string;
  sort?: 'recent' | 'spent' | 'orders';
  limit?: number;
}) {
  const query = toQueryString(filters);

  return usePagedQuery<'users', UserProfile>(
    QUERY_KEYS.adminUsers(query),
    `/admin/users${query}`,
    'users',
    { staleTime: 30_000 }
  );
}

export function useAdminUser(uid: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.adminUser(uid ?? ''),
    queryFn: () =>
      api.get<{ profile: UserProfile; orders: Order[] }>(`/admin/users/${uid}`),
    enabled: Boolean(uid),
  });
}

function useUserInvalidator() {
  const queryClient = useQueryClient();

  return (uid: string) => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUser(uid) });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  };
}

export function useSetUserRole() {
  const invalidate = useUserInvalidator();

  return useMutation({
    mutationFn: ({ uid, role }: { uid: string; role: 'user' | 'staff' | 'admin' }) =>
      api.post<{ profile: UserProfile }>(`/admin/users/${uid}/role`, { role }),
    onSuccess: (_data, variables) => invalidate(variables.uid),
  });
}

export function useBanUser() {
  const invalidate = useUserInvalidator();

  return useMutation({
    mutationFn: ({ uid, banned, reason }: { uid: string; banned: boolean; reason?: string }) =>
      api.post<{ profile: UserProfile }>(`/admin/users/${uid}/ban`, { banned, reason }),
    onSuccess: (_data, variables) => invalidate(variables.uid),
  });
}

export function useAdjustWallet() {
  const invalidate = useUserInvalidator();

  return useMutation({
    mutationFn: ({ uid, deltaUsd, reason }: { uid: string; deltaUsd: number; reason: string }) =>
      api.post<{ walletBalanceUsd: number }>(`/admin/users/${uid}/wallet`, { deltaUsd, reason }),
    onSuccess: (_data, variables) => invalidate(variables.uid),
  });
}

export function useNotifyUser() {
  return useMutation({
    mutationFn: ({
      uid,
      title,
      body,
      link,
    }: {
      uid: string;
      title: string;
      body: string;
      link?: string;
    }) => api.post<{ sent: boolean }>(`/admin/users/${uid}/notify`, { title, body, link }),
  });
}

// --- Configuración ---------------------------------------------------------

export function useAdminConfig() {
  return useQuery({
    queryKey: QUERY_KEYS.adminConfig,
    queryFn: () => api.get<{ config: AppConfig }>('/admin/config'),
    staleTime: 30_000,
  });
}

function useConfigInvalidator() {
  const queryClient = useQueryClient();

  return () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminConfig });
    // La tienda pública lee su propia copia de la configuración.
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.config });
    void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.catalog });
  };
}

export function useUpdateConfig() {
  const invalidate = useConfigInvalidator();

  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<{ config: AppConfig }>('/admin/config', patch),
    onSuccess: invalidate,
  });
}

export function useSetRate() {
  const invalidate = useConfigInvalidator();

  return useMutation({
    mutationFn: (value: number) =>
      api.post<{ previous: number; current: number }>('/admin/config/rate', { value }),
    onSuccess: invalidate,
  });
}

export function useSetRateAuto() {
  const invalidate = useConfigInvalidator();

  return useMutation({
    mutationFn: (input: { autoRefresh: boolean; markupPercent?: number }) =>
      api.post<{ rate: AppConfig['rate'] }>('/admin/config/rate/auto', input),
    onSuccess: invalidate,
  });
}

export function useRefreshRate() {
  const invalidate = useConfigInvalidator();

  return useMutation({
    mutationFn: () =>
      api.post<{ updated: boolean; previous: number; current: number; reason: string }>(
        '/admin/config/rate/refresh'
      ),
    onSuccess: invalidate,
  });
}

export function useRateHistory() {
  return useQuery({
    queryKey: QUERY_KEYS.adminRateHistory,
    queryFn: () =>
      api.get<{
        history: Array<{
          id: string;
          value: number;
          previous: number;
          source: string;
          createdAt: unknown;
        }>;
      }>('/admin/config/rate/history'),
    staleTime: 60_000,
  });
}

// --- Cupones ---------------------------------------------------------------

export function useAdminCoupons() {
  return useQuery({
    queryKey: QUERY_KEYS.adminCoupons,
    queryFn: () => api.get<{ coupons: Coupon[] }>('/admin/coupons'),
    staleTime: 60_000,
  });
}

export function useSaveCoupon() {
  const queryClient = useQueryClient();

  return useMutation({
    // Crear devuelve `{ code }` y editar devuelve `{ coupon }`: se unifica el
    // tipo para que la mutación tenga una sola firma.
    mutationFn: ({ code, data }: { code?: string; data: Record<string, unknown> }) =>
      code
        ? api.patch<{ coupon?: Coupon; code?: string }>(`/admin/coupons/${code}`, data)
        : api.post<{ coupon?: Coupon; code?: string }>('/admin/coupons', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminCoupons });
    },
  });
}

export function useDeleteCoupon() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (code: string) => api.delete<{ deleted: boolean }>(`/admin/coupons/${code}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminCoupons });
    },
  });
}

// --- Soporte y bitácora ----------------------------------------------------

export function useAdminTickets(status?: string) {
  return usePagedQuery<'tickets', Ticket>(
    QUERY_KEYS.adminTickets(status),
    `/admin/tickets${status ? `?status=${status}` : ''}`,
    'tickets',
    { staleTime: 30_000, refetchInterval: 60_000 }
  );
}

export function useSetTicketStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'open' | 'pending' | 'closed' }) =>
      api.post<{ updated: boolean }>(`/admin/tickets/${id}/status`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tickets'] });
    },
  });
}

export function useAuditLogs(filters: { action?: string; actorUid?: string; limit?: number }) {
  const query = toQueryString(filters);

  return usePagedQuery<'logs', AuditLog>(
    QUERY_KEYS.adminLogs(query),
    `/admin/logs${query}`,
    'logs',
    { staleTime: 30_000 }
  );
}

// --- Avisos al equipo ------------------------------------------------------

export function useAdminAlerts(options: { onlyUnread?: boolean; limit?: number } = {}) {
  const query = toQueryString(options);

  const page = usePagedQuery<'alerts', AdminAlert>(
    QUERY_KEYS.adminAlerts(query),
    `/admin/alerts${query}`,
    'alerts',
    {
      staleTime: 20_000,
      // El objetivo de un aviso es llegar pronto: en el panel abierto se
      // refresca cada minuto, aparte del empuje por Telegram o webhook.
      refetchInterval: 60_000,
    }
  );

  // El contador de no leídos alimenta la insignia del menú, así que se expone
  // aparte de la lista.
  const unread = useQuery({
    queryKey: [...QUERY_KEYS.adminAlerts(query), 'unread'],
    queryFn: () => api.get<{ unread: number }>('/admin/alerts?limit=1'),
    staleTime: 20_000,
    refetchInterval: 60_000,
  });

  return { ...page, unread: unread.data?.unread ?? 0 };
}

function useAlertsInvalidator() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['admin', 'alerts'] });
}

export function useMarkAlertsRead() {
  const invalidate = useAlertsInvalidator();

  return useMutation({
    mutationFn: () => api.post<{ marked: number }>('/admin/alerts/read-all'),
    onSuccess: invalidate,
  });
}

export function useMarkAlertRead() {
  const invalidate = useAlertsInvalidator();

  return useMutation({
    mutationFn: (id: string) => api.post<{ read: boolean }>(`/admin/alerts/${id}/read`),
    onSuccess: invalidate,
  });
}

/** Chats a los que el bot puede escribir; evita buscar el `chat_id` a mano. */
export function useTelegramChats() {
  return useMutation({
    mutationFn: () =>
      api.get<{
        ok: boolean;
        botName: string | null;
        chats: Array<{ id: string; name: string; type: string }>;
        message: string | null;
      }>('/admin/alerts/telegram/chats'),
  });
}

export function useTestAlert() {
  const invalidate = useAlertsInvalidator();

  return useMutation({
    mutationFn: () =>
      api.post<{ sent: boolean; delivery: AdminAlert['delivery'] | null }>('/admin/alerts/test'),
    onSuccess: invalidate,
  });
}

// --- Correo al cliente -----------------------------------------------------

export function useEmailStatus() {
  return useQuery({
    queryKey: QUERY_KEYS.adminEmail,
    queryFn: () =>
      api.get<{
        enabled: boolean;
        configured: boolean;
        fromAddress: string;
        reachable: boolean;
        message: string | null;
      }>('/admin/email/status'),
    staleTime: 120_000,
  });
}

export function useTestEmail() {
  return useMutation({
    mutationFn: (input: {
      kind?: 'payment_verified' | 'delivered' | 'dispatch_failed';
      orderId?: string;
    }) => api.post<{ sent: boolean; to: string; orderCode: string }>('/admin/email/test', input),
  });
}

// --- Cartera de un usuario -------------------------------------------------

export function useAdminUserWallet(uid: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.adminUserWallet(uid ?? ''),
    queryFn: () =>
      api.get<{ balanceUsd: number; transactions: WalletTransaction[] }>(
        `/admin/users/${uid}/wallet`
      ),
    enabled: Boolean(uid),
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Niveles de fidelidad
// ---------------------------------------------------------------------------

export function useAdminTiers() {
  return useQuery({
    queryKey: QUERY_KEYS.adminTiers,
    queryFn: () => api.get<{ tiers: TierDefinition[] }>('/admin/tiers'),
    staleTime: 60_000,
  });
}

export function useSaveTiers() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tiers: TierDefinition[]) =>
      api.put<{ tiers: TierDefinition[] }>('/admin/tiers', { tiers }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminTiers });
      // La tienda lee la escalera de `/config`: sin esto, el cliente seguiría
      // viendo los umbrales viejos hasta que caduque su caché.
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.config });
    },
  });
}

export interface TierRecalculation {
  total: number;
  changed: Array<{
    uid: string;
    email: string | null;
    totalSpentUsd: number;
    from: UserTier | null;
    to: UserTier;
    discountFrom: number;
    discountTo: number;
  }>;
}

/** Recalcula el nivel de todos los perfiles. Con `dryRun` sólo simula. */
export function useRecalculateTiers() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<TierRecalculation>('/admin/tiers/recalculate', { dryRun }),
    onSuccess: (_data, dryRun) => {
      if (!dryRun) void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Creadores de contenido
// ---------------------------------------------------------------------------

export function useAdminCreators() {
  return usePagedQuery<'creators', Creator>(
    QUERY_KEYS.adminCreators,
    '/admin/creators?limit=50',
    'creators',
    { staleTime: 30_000 }
  );
}

export function useAdminCreator(uid: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.adminCreator(uid ?? ''),
    queryFn: () =>
      api.get<{ creator: Creator; commissions: CommissionEntry[]; total?: number }>(
        `/admin/creators/${uid}`
      ),
    enabled: Boolean(uid),
    staleTime: 30_000,
  });
}

/** Alta, edición o baja del creador desde la ficha del usuario. */
export function useSaveCreator(uid: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Record<string, unknown> | null) =>
      data === null
        ? api.delete<{ creator: Creator }>(`/admin/users/${uid}/creator`)
        : api.post<{ creator: Creator }>(`/admin/users/${uid}/creator`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUser(uid) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminCreators });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminCreator(uid) });
    },
  });
}

export function usePayCreator(uid: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ payoutId: string; amountUsd: number; entries: number; hasMore: boolean }>(
        `/admin/creators/${uid}/payout`
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminCreator(uid) });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminCreators });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.adminUser(uid) });
    },
  });
}
