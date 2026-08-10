import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Receipt, ShoppingBag, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useCancelOrder, useMyOrders } from '@/hooks/useOrders';
import { useDocumentTitle } from '@/hooks/useMisc';
import { EmptyState, ErrorState, OrderStatusBadge, Skeleton } from '@/components/ui/Feedback';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { LoadMore } from '@/components/common/LoadMore';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatRelative } from '@/lib/format';
import { shortOrderItem } from '@/lib/orderItem';
import { cn, errorMessage } from '@/lib/utils';
import type { Order } from '@/types/models';

/** Estados en los que el cliente todavía puede pagar o desistir. */
const CANCELLABLE = ['awaiting_payment', 'payment_rejected'];

const FILTERS = [
  { id: 'all', label: 'Todas', value: undefined },
  { id: 'active', label: 'En curso', value: 'awaiting_payment,verifying,paid,dispatching,awaiting_manual,failed' },
  { id: 'done', label: 'Completadas', value: 'completed' },
] as const;

export function OrdersPage() {
  useDocumentTitle('Mis órdenes');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');

  const [toCancel, setToCancel] = useState<Order | null>(null);

  const selected = FILTERS.find((item) => item.id === filter);
  const myOrders = useMyOrders(selected?.value);
  const cancelOrder = useCancelOrder();

  const { orders, isLoading, error } = myOrders;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
          <Receipt className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold">Mis órdenes</h1>
          <p className="text-sm text-slate-400">Historial completo de tus recargas</p>
        </div>
      </div>

      <div className="mb-5 flex gap-2 overflow-x-auto no-scrollbar">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            className={cn(
              'shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition',
              filter === item.id
                ? 'border-neon-red bg-neon-red/15 text-white'
                : 'border-base-600 bg-base-800 text-slate-400 hover:text-white'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorState message="No pudimos cargar tus órdenes." />
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<ShoppingBag className="h-7 w-7" aria-hidden />}
          title="Todavía no tienes órdenes"
          description="Cuando compres una recarga aparecerá aquí con su estado en tiempo real."
          action={<ButtonLink to={ROUTES.home}>Ver catálogo</ButtonLink>}
        />
      ) : (
        <ul className="space-y-3">
          {orders.map((order) => (
            <li key={order.id} className="card p-0">
              <Link
                to={ROUTES.order(order.id)}
                className="card-hover flex items-center gap-4 rounded-2xl p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-white">
                      {shortOrderItem(order)}
                    </h2>
                    <OrderStatusBadge status={order.status} />
                  </div>

                  <p className="mt-1 truncate text-xs text-slate-400">
                    {order.gameName} · ID {order.playerId}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="tabular">{order.code}</span> ·{' '}
                    {formatRelative(order.createdAt)}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold tabular text-white">
                    {formatBs(order.pricing.totalBs)}
                  </p>
                  <p className="text-xs tabular text-slate-500">
                    ${order.pricing.totalUsd.toFixed(2)}
                  </p>
                </div>
              </Link>

              {/* Una orden sin pagar ocupa cupo del tope de órdenes abiertas:
                  poder cerrarla desde aquí es lo que evita quedarse atascado. */}
              {CANCELLABLE.includes(order.status) && (
                <div className="flex gap-2 border-t border-base-600 px-4 py-2.5">
                  <ButtonLink
                    to={`${ROUTES.checkout(order.productId)}?orden=${order.id}`}
                    size="sm"
                    className="flex-1"
                  >
                    Completar el pago
                  </ButtonLink>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-300"
                    leftIcon={<X className="h-3.5 w-3.5" aria-hidden />}
                    onClick={() => setToCancel(order)}
                  >
                    Cancelar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <LoadMore
        loaded={orders.length}
        total={null}
        hasMore={myOrders.hasMore}
        loading={myOrders.isLoadingMore}
        onLoadMore={myOrders.loadMore}
        label="órdenes"
      />

      <ConfirmDialog
        open={Boolean(toCancel)}
        onClose={() => setToCancel(null)}
        onConfirm={() => {
          if (!toCancel) return;
          cancelOrder.mutate(toCancel.id, {
            onSuccess: () => {
              toast.success('Orden cancelada.');
              setToCancel(null);
            },
            onError: (error_) => toast.error(errorMessage(error_)),
          });
        }}
        title="Cancelar la orden"
        message={`Se anulará la orden ${toCancel?.code ?? ''}. Si ya transferiste el dinero, no la canceles: escríbenos por soporte.`}
        confirmLabel="Sí, cancelar"
        cancelLabel="Volver"
        destructive
        loading={cancelOrder.isPending}
      />
    </div>
  );
}
