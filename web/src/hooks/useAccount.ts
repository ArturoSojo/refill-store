/** Consultas del área de cuenta: IDs guardados, notificaciones, soporte. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import { useAuth } from '@/providers/AuthProvider';
import type {
  SavedPlayerId,
  Ticket,
  TicketMessage,
  UserNotification,
  UserProfile,
  WalletTransaction,
} from '@/types/models';

/** Saldo a favor y sus movimientos. */
export function useWallet() {
  const { user } = useAuth();

  return useQuery({
    queryKey: QUERY_KEYS.wallet,
    queryFn: () =>
      api.get<{ balanceUsd: number; enabled: boolean; transactions: WalletTransaction[] }>(
        '/me/wallet'
      ),
    enabled: Boolean(user),
    staleTime: 20_000,
  });
}

export function useSavedPlayerIds() {
  const { user } = useAuth();

  return useQuery({
    queryKey: QUERY_KEYS.playerIds,
    queryFn: () => api.get<{ playerIds: SavedPlayerId[] }>('/me/player-ids'),
    enabled: Boolean(user),
    staleTime: 60_000,
  });
}

export function useSavePlayerId() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      gameId: string;
      playerId: string;
      /** Campos extra del juego (Zone ID…). El servidor descarta contraseñas. */
      playerFields?: Record<string, string>;
      label: string;
      isDefault?: boolean;
    }) => api.post<{ id: string; updated: boolean }>('/me/player-ids', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.playerIds });
    },
  });
}

export function useDeletePlayerId() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete<{ deleted: boolean }>(`/me/player-ids/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.playerIds });
    },
  });
}

export function useNotifications() {
  const { user } = useAuth();

  return useQuery({
    queryKey: QUERY_KEYS.notifications,
    queryFn: () => api.get<{ notifications: UserNotification[] }>('/me/notifications'),
    enabled: Boolean(user),
    staleTime: 30_000,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ marked: number }>('/me/notifications/read-all'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notifications });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      displayName?: string;
      phone?: string | null;
      preferences?: { notifyEmail?: boolean; notifyOrderUpdates?: boolean };
    }) => api.patch<{ profile: UserProfile }>('/me', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
    },
  });
}

export function useApplyReferral() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (code: string) =>
      api.post<{ applied: boolean; profile: UserProfile }>('/me/referral', { code }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
    },
  });
}

export function useTickets() {
  const { user } = useAuth();

  return useQuery({
    queryKey: QUERY_KEYS.tickets,
    queryFn: () => api.get<{ tickets: Ticket[] }>('/me/tickets'),
    enabled: Boolean(user),
    staleTime: 30_000,
  });
}

export function useTicket(ticketId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: QUERY_KEYS.ticket(ticketId ?? ''),
    queryFn: () =>
      api.get<{ ticket: Ticket; messages: TicketMessage[] }>(`/me/tickets/${ticketId}`),
    enabled: Boolean(ticketId && user),
    // El soporte es una conversación: conviene refrescar mientras esté abierta.
    refetchInterval: 20_000,
  });
}

export function useCreateTicket() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { subject: string; message: string; orderId?: string | null }) =>
      api.post<{ id: string }>('/me/tickets', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tickets });
    },
  });
}

export function useSendTicketMessage(ticketId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: string) =>
      api.post<{ sent: boolean }>(`/me/tickets/${ticketId}/messages`, { body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ticket(ticketId ?? '') });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.tickets });
    },
  });
}
