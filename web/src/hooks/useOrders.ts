/** Consultas y mutaciones de órdenes del cliente. */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { api } from '@/lib/api';
import { QUERY_KEYS, LIVE_ORDER_STATUSES } from '@/lib/constants';
import { useAuth } from '@/providers/AuthProvider';
import type {
  CreateOrderResponse,
  Order,
  OrderEvent,
  PaymentInstructions,
  PlayerFieldLabel,
  PricePreview,
  VerifyPaymentResponse,
} from '@/types/models';

/** Respuesta de `GET /orders/:id`: la orden más todo lo necesario para pagarla. */
export interface OrderDetailResponse {
  order: Order;
  events: OrderEvent[];
  payment: PaymentInstructions;
  playerFieldLabels: PlayerFieldLabel[];
}

export function useMyOrders(status?: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: QUERY_KEYS.orders(status),
    queryFn: () =>
      api.get<{ orders: Order[]; nextCursor: number | null }>(
        `/orders${status ? `?status=${status}` : ''}`
      ),
    enabled: Boolean(user),
    staleTime: 20_000,
  });
}

export function useOrder(orderId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: QUERY_KEYS.order(orderId ?? ''),
    queryFn: () => api.get<OrderDetailResponse>(`/orders/${orderId}`),
    enabled: Boolean(orderId && user),
    staleTime: 5_000,
  });
}

/**
 * Escucha la orden en tiempo real mientras su estado siga cambiando solo.
 *
 * El despacho puede tardar unos segundos (sobre todo en combos, que encadenan
 * varias llamadas al proveedor). En vez de hacer polling, se lee directamente
 * el documento: las reglas permiten al dueño leer su propia orden.
 */
export function useLiveOrder(orderId: string | undefined, initial?: Order) {
  const { user } = useAuth();
  const [order, setOrder] = useState<Order | undefined>(initial);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (initial) setOrder(initial);
  }, [initial]);

  const shouldListen = Boolean(
    orderId && user && order && LIVE_ORDER_STATUSES.includes(order.status)
  );

  useEffect(() => {
    if (!shouldListen || !orderId) return undefined;

    const unsubscribe = onSnapshot(
      doc(db, 'orders', orderId),
      (snapshot) => {
        if (!snapshot.exists()) return;
        const next = { id: snapshot.id, ...snapshot.data() } as Order;
        setOrder(next);

        // Al llegar a un estado estable se refresca la caché para que las
        // listas y el historial de eventos también queden al día.
        if (!LIVE_ORDER_STATUSES.includes(next.status)) {
          void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.order(orderId) });
          void queryClient.invalidateQueries({ queryKey: ['orders'] });
        }
      },
      () => {
        // Sin permisos o sin red: se sigue mostrando el último estado conocido.
      }
    );

    return unsubscribe;
  }, [shouldListen, orderId, queryClient]);

  return order;
}

export function useCreateOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      gameId: string;
      productId: string;
      /** Datos del jugador por clave de campo: `{ playerId, zoneId }`. */
      playerFields: Record<string, string>;
      quantity?: number;
      couponCode?: string | null;
      useWallet?: boolean;
    }) => api.post<CreateOrderResponse>('/orders', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
    },
  });
}

export function useVerifyPayment(orderId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reference: string) =>
      api.post<VerifyPaymentResponse>(`/orders/${orderId}/verify`, { reference }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.order(orderId ?? '') });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
    },
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (orderId: string) => api.post<{ order: Order }>(`/orders/${orderId}/cancel`),
    onSuccess: (_data, orderId) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEYS.order(orderId) });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

/** Previsualiza el total con cupón y descuento por nivel antes de crear la orden. */
export function usePricePreview() {
  return useMutation({
    mutationFn: (input: {
      productId: string;
      quantity?: number;
      couponCode?: string | null;
      useWallet?: boolean;
      /** Permite validar ya el límite del cupón por ID de jugador. */
      playerId?: string | null;
    }) => api.post<PricePreview>('/orders/preview', input),
  });
}
