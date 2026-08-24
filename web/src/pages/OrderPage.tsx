import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronLeft,
  Circle,
  Clock,
  LifeBuoy,
  MessageCircle,
  Wallet,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useOrder, useLiveOrder, useCancelOrder } from '@/hooks/useOrders';
import { useDocumentTitle, useCountdown } from '@/hooks/useMisc';
import { useConfig } from '@/providers/ConfigProvider';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { OrderStatusBadge, FullPageLoader, ErrorState } from '@/components/ui/Feedback';
import { CopyField } from '@/components/common/CopyField';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatDateTime, formatUsd, statusMeta } from '@/lib/format';
import { describeOrder } from '@/lib/orderItem';
import { cn, errorMessage, openWhatsapp } from '@/lib/utils';
import type { OrderEvent } from '@/types/models';

function Timeline({ events }: { events: OrderEvent[] }) {
  if (events.length === 0) return null;

  const iconFor = (event: OrderEvent) => {
    if (event.type.includes('error') || event.type.includes('rejected') || event.type.includes('failed')) {
      return <XCircle className="h-4 w-4 text-red-400" aria-hidden />;
    }
    if (
      event.type.includes('ok') ||
      event.type === 'completed' ||
      event.type === 'payment_verified' ||
      event.type === 'manual_ready'
    ) {
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />;
    }
    return <Circle className="h-4 w-4 text-slate-500" aria-hidden />;
  };

  return (
    <ol className="space-y-4">
      {events.map((event, index) => (
        <li key={event.id} className="relative flex gap-3 pl-1">
          {index < events.length - 1 && (
            <span className="absolute left-[11px] top-6 h-full w-px bg-base-600" aria-hidden />
          )}
          <span className="relative z-10 mt-0.5 shrink-0">{iconFor(event)}</span>
          <div className="min-w-0 pb-1">
            <p className="text-sm text-slate-200">{event.message}</p>
            <p className="mt-0.5 text-xs text-slate-500">{formatDateTime(event.createdAt)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function OrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useOrder(orderId);
  const { config } = useConfig();
  const cancelOrder = useCancelOrder();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const order = useLiveOrder(orderId, data?.order);

  // La cuenta atrás del pago corre aquí igual que en el checkout: si el cliente
  // vuelve a la orden, ve el tiempo que le queda de verdad.
  const { display: timeLeft, expired } = useCountdown(order?.expiresAt ?? 0);

  useDocumentTitle(order ? `Orden ${order.code}` : 'Orden');

  if (isLoading) return <FullPageLoader label="Cargando tu orden…" />;

  if (error || !order) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <ErrorState
          title="Orden no encontrada"
          message="No pudimos encontrar esta orden en tu cuenta."
          action={
            <ButtonLink to={ROUTES.orders} variant="secondary">
              Ver mis órdenes
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const meta = statusMeta(order.status);
  const canPay = ['awaiting_payment', 'payment_rejected'].includes(order.status);
  const showWhatsapp = order.status === 'awaiting_manual' && order.whatsappUrl;
  const labels = data?.playerFieldLabels ?? [];
  const walletApplied = order.pricing.walletAppliedUsd ?? 0;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <Link
        to={ROUTES.orders}
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Mis órdenes
      </Link>

      <div className="card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Orden <span className="tabular text-slate-300">{order.code}</span>
            </p>
            <h1 className="mt-1 text-xl font-bold text-white">{describeOrder(order)}</h1>
            <p className="mt-0.5 text-sm text-slate-400">{order.gameName}</p>
          </div>
          <OrderStatusBadge status={order.status} />
        </div>

        <p
          className={cn(
            'mt-4 rounded-xl px-4 py-3 text-sm',
            order.status === 'completed'
              ? 'bg-emerald-500/10 text-emerald-200'
              : order.status === 'failed' || order.status === 'payment_rejected'
                ? 'bg-amber-500/10 text-amber-200'
                : 'bg-base-900 text-slate-300'
          )}
        >
          {meta.description}
        </p>

        {showWhatsapp && (
          <Button
            className="mt-4"
            variant="whatsapp"
            size="lg"
            fullWidth
            leftIcon={<MessageCircle className="h-5 w-5" aria-hidden />}
            onClick={() => openWhatsapp(order.whatsappUrl!)}
          >
            Continuar por WhatsApp
          </Button>
        )}

        {canPay && (
          <>
            {!expired && timeLeft && (
              <p className="mt-4 flex items-center justify-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1.5 text-sm font-semibold text-amber-300">
                <Clock className="h-3.5 w-3.5" aria-hidden />
                Tiempo para pagar: <span className="tabular">{timeLeft}</span>
              </p>
            )}

            <ButtonLink
              className="mt-4"
              // Retoma ESTA orden: mantiene el monto, la tasa, los datos del
              // jugador y el reloj. Antes abría un checkout nuevo desde cero.
              to={`${ROUTES.checkout(order.productId)}?orden=${order.id}`}
              fullWidth
              size="lg"
            >
              {expired ? 'Ver el estado del pago' : 'Completar el pago'}
            </ButtonLink>

            <Button
              className="mt-2"
              variant="ghost"
              fullWidth
              onClick={() => setConfirmCancel(true)}
            >
              Cancelar esta orden
            </Button>
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-white">Detalle de la compra</h2>
          <dl className="space-y-2 text-sm">
            {/* Se listan todos los campos que pidió el juego, con su etiqueta
                real: para Mobile Legends son dos, y con uno solo no se
                entendería qué número es cuál. */}
            {(labels.length > 0
              ? labels
              : [{ key: 'playerId', label: 'ID de jugador', sensitive: false }]
            ).map((field) => {
              const value = order.playerFields?.[field.key] ?? (field.key === 'playerId' ? order.playerId : '');
              if (!value) return null;

              return (
                <div key={field.key} className="flex justify-between gap-3">
                  <dt className="text-slate-400">{field.label}</dt>
                  <dd className="tabular text-white">
                    {field.sensitive ? '••••••' : value}
                  </dd>
                </div>
              );
            })}
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Cantidad</dt>
              <dd className="text-white">{order.pricing.quantity}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Subtotal</dt>
              <dd className="tabular text-white">{formatUsd(order.pricing.subtotalUsd)}</dd>
            </div>
            {order.pricing.discountUsd > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">
                  Descuento
                  {order.pricing.couponCode && (
                    <span className="ml-1 text-xs text-neon-crimson">
                      ({order.pricing.couponCode})
                    </span>
                  )}
                </dt>
                <dd className="tabular text-emerald-400">
                  −{formatUsd(order.pricing.discountUsd)}
                </dd>
              </div>
            )}
            {walletApplied > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-slate-400">
                  <Wallet className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                  Saldo a favor
                </dt>
                <dd className="tabular text-emerald-400">−{formatUsd(walletApplied)}</dd>
              </div>
            )}
            <div className="flex justify-between gap-3 border-t border-base-600 pt-2">
              <dt className="font-semibold text-white">
                {order.pricing.totalBs > 0 ? 'Total transferido' : 'Total'}
              </dt>
              <dd className="text-right">
                <span className="block font-bold tabular text-white">
                  {order.pricing.totalBs > 0
                    ? formatBs(order.pricing.totalBs)
                    : 'Pagado con saldo'}
                </span>
                <span className="block text-xs tabular text-slate-500">
                  {formatUsd(order.pricing.totalUsd)} · tasa {order.pricing.rate}
                </span>
              </dd>
            </div>
          </dl>
        </div>

        <div className="card">
          <h2 className="mb-3 text-sm font-semibold text-white">Pago</h2>
          {order.payment.reference ? (
            <div className="space-y-2">
              <CopyField label="Referencia" value={order.payment.reference} />
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <Clock className="h-3 w-3" aria-hidden />
                Verificado el {formatDateTime(order.payment.verifiedAt)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              Aún no has enviado la referencia de este pago.
            </p>
          )}

          <dl className="mt-4 space-y-1.5 border-t border-base-600 pt-3 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Banco</dt>
              <dd className="text-slate-300">
                {order.payment.bankSnapshot.code} · {order.payment.bankSnapshot.name}
              </dd>
            </div>
            {/* Saber por dónde pagó ahorra la mitad de las consultas cuando el
                cliente reclama que «sí transfirió». */}
            {order.payment.method !== 'wallet' && (
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Método</dt>
                <dd className="text-slate-300">
                  {order.payment.method === 'transfer' ? 'Transferencia' : 'Pago Móvil'}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500">Creada</dt>
              <dd className="text-slate-300">{formatDateTime(order.createdAt)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {order.fulfillment === 'auto' && order.dispatch.calls.length > 0 && (
        <div className="card mt-4">
          <h2 className="mb-3 text-sm font-semibold text-white">
            Entrega
            {order.dispatch.calls.length > 1 && (
              <span className="ml-2 text-xs font-normal text-slate-400">
                Este combo se acredita en {order.dispatch.calls.length} recargas
              </span>
            )}
          </h2>
          <ul className="space-y-2">
            {order.dispatch.calls.map((call) => (
              <li
                key={call.index}
                className="flex items-center justify-between gap-3 rounded-xl bg-base-900/60 px-3 py-2.5 text-sm"
              >
                <span className="flex items-center gap-2 text-slate-300">
                  {call.status === 'success' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />
                  ) : call.status === 'error' ? (
                    <XCircle className="h-4 w-4 text-red-400" aria-hidden />
                  ) : (
                    <Circle className="h-4 w-4 text-slate-500" aria-hidden />
                  )}
                  Recarga {call.index + 1}
                </span>
                <span
                  className={cn(
                    'text-xs font-medium',
                    call.status === 'success'
                      ? 'text-emerald-400'
                      : call.status === 'error'
                        ? 'text-red-400'
                        : 'text-slate-500'
                  )}
                >
                  {call.status === 'success'
                    ? 'Entregada'
                    : call.status === 'error'
                      ? 'Con error'
                      : 'Pendiente'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.events && data.events.length > 0 && (
        <div className="card mt-4">
          <h2 className="mb-4 text-sm font-semibold text-white">Historial</h2>
          <Timeline events={data.events} />
        </div>
      )}

      {config?.supportUrl && (
        <ButtonLink
          className="mt-4"
          to={`${config.supportUrl}%0AOrden%3A%20${order.code}`}
          external
          variant="secondary"
          fullWidth
          leftIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}
        >
          Necesito ayuda con esta orden
        </ButtonLink>
      )}

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={() =>
          cancelOrder.mutate(order.id, {
            onSuccess: () => {
              toast.success(
                walletApplied > 0
                  ? `Orden cancelada. Te devolvimos ${formatUsd(walletApplied)} a tu saldo.`
                  : 'Orden cancelada.'
              );
              setConfirmCancel(false);
              navigate(ROUTES.orders);
            },
            onError: (mutationError) => toast.error(errorMessage(mutationError)),
          })
        }
        title="Cancelar la orden"
        message={
          walletApplied > 0
            ? `Se anulará la orden ${order.code} y te devolveremos ${formatUsd(walletApplied)} a tu saldo a favor. Si ya transferiste, no la canceles: escríbenos.`
            : `Se anulará la orden ${order.code}. Si ya transferiste el dinero, no la canceles: escríbenos por soporte.`
        }
        confirmLabel="Sí, cancelar"
        cancelLabel="Volver"
        destructive
        loading={cancelOrder.isPending}
      />
    </div>
  );
}
