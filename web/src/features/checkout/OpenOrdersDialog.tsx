/**
 * Salida al muro de «tienes 3 órdenes sin pagar».
 *
 * El tope existe para que nadie bloquee inventario acumulando órdenes, pero
 * hasta ahora el cliente recibía el error y se quedaba encerrado: no había
 * botón para cancelar nada. Aquí ve exactamente qué órdenes lo están frenando y
 * las resuelve sin salir de la compra: paga una o cancela las que ya no quiere.
 */
import { Clock, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { useCancelOrder, useMyOrders } from '@/hooks/useOrders';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Skeleton, OrderStatusBadge } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatRelative } from '@/lib/format';
import { errorMessage } from '@/lib/utils';

const OPEN_STATUSES = 'awaiting_payment,payment_rejected,verifying';

interface OpenOrdersDialogProps {
  open: boolean;
  onClose: () => void;
  /** Se llama cuando ya no queda ninguna orden abierta bloqueando la compra. */
  onAllClosed: () => void;
}

export function OpenOrdersDialog({ open, onClose, onAllClosed }: OpenOrdersDialogProps) {
  const navigate = useNavigate();
  const orders = useMyOrders(open ? OPEN_STATUSES : undefined);
  const cancelOrder = useCancelOrder();

  const list = orders.orders;

  const cancel = (orderId: string) => {
    cancelOrder.mutate(orderId, {
      onSuccess: () => {
        toast.success('Orden cancelada.');
        // Si esa era la última, se reintenta la compra automáticamente.
        if (list.length <= 1) onAllClosed();
      },
      onError: (error) => toast.error(errorMessage(error)),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tienes órdenes sin pagar"
      description="Complétalas o cancélalas para poder crear una nueva."
      size="md"
    >
      {orders.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="py-4 text-center">
          <p className="text-sm text-slate-300">Ya no tienes órdenes pendientes.</p>
          <Button className="mt-4" fullWidth onClick={onAllClosed}>
            Continuar con mi compra
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {list.map((order) => (
            <li
              key={order.id}
              className="rounded-2xl border border-base-600 bg-base-900/60 p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {order.productName}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {order.gameName} · <span className="tabular">{order.code}</span>
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
                    <Clock className="h-3 w-3" aria-hidden />
                    {formatRelative(order.createdAt)}
                  </p>
                </div>
                <div className="text-right">
                  <OrderStatusBadge status={order.status} showPulse={false} />
                  <p className="mt-1 text-sm font-bold tabular text-white">
                    {formatBs(order.pricing.totalBs)}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  onClick={() => {
                    onClose();
                    navigate(`${ROUTES.checkout(order.productId)}?orden=${order.id}`);
                  }}
                >
                  Pagar esta
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1 text-red-300"
                  loading={cancelOrder.isPending && cancelOrder.variables === order.id}
                  leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => cancel(order.id)}
                >
                  Cancelar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
