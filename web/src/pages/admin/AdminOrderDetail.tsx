import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CheckCircle2,
  ChevronLeft,
  Circle,
  Copy,
  Eye,
  EyeOff,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Save,
  Undo2,
  User,
  XCircle, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useAdminOrder,
  useCompleteOrder,
  useRefundOrder,
  useRetryDispatch,
  useSetOrderNote,
} from '@/hooks/useAdmin';
import { useAuth } from '@/providers/AuthProvider';
import { useDocumentTitle, useCopy } from '@/hooks/useMisc';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Field';
import { ConfirmDialog } from '@/components/ui/Modal';
import { FullPageLoader, ErrorState, OrderStatusBadge, Badge } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatDateTime, formatUsd } from '@/lib/format';
import { describeOrder } from '@/lib/orderItem';
import { cn, errorMessage, openWhatsapp } from '@/lib/utils';

export function AdminOrderDetail() {
  const { orderId } = useParams<{ orderId: string }>();
  const { isAdmin } = useAuth();
  const { data, isLoading, error, refetch, isFetching } = useAdminOrder(orderId);
  const { copy } = useCopy();

  const retry = useRetryDispatch();
  const complete = useCompleteOrder();
  const refund = useRefundOrder();
  const setNote = useSetOrderNote();

  const [note, setNoteValue] = useState('');
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundToWallet, setRefundToWallet] = useState(true);
  const [completeOpen, setCompleteOpen] = useState(false);
  // Las contraseñas de las cuentas se ocultan por defecto: quedan a la vista de
  // cualquiera que mire la pantalla del panel.
  const [revealSensitive, setRevealSensitive] = useState(false);

  useDocumentTitle(data ? `Orden ${data.order.code}` : 'Orden');

  useEffect(() => {
    if (data) setNoteValue(data.order.adminNote ?? '');
  }, [data]);

  if (isLoading) return <FullPageLoader />;
  if (error || !data) {
    return <ErrorState title="Orden no encontrada" message="Revisa el enlace e intenta de nuevo." />;
  }

  const { order, events, customer } = data;
  const playerFields = data.playerFieldLabels ?? [];
  const walletApplied = order.pricing.walletAppliedUsd ?? 0;

  const canRetry =
    order.fulfillment === 'auto' && ['failed', 'paid', 'dispatching'].includes(order.status);
  const canComplete = ['paid', 'dispatching', 'failed', 'awaiting_manual'].includes(order.status);
  const canRefund = ['paid', 'dispatching', 'failed', 'awaiting_manual', 'completed'].includes(
    order.status
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to={ROUTES.adminOrders}
          className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Órdenes
        </Link>

        <button
          type="button"
          onClick={() => void refetch()}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-base-600 bg-base-800 text-slate-400 transition hover:text-white"
          aria-label="Actualizar"
        >
          <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} aria-hidden />
        </button>
      </div>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-lg font-bold text-white">{order.code}</h1>
              <OrderStatusBadge status={order.status} />
              <Badge variant={order.fulfillment === 'auto' ? 'brand' : 'success'}>
                {order.fulfillment === 'auto' ? 'Automática' : 'Manual'}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-slate-300">{describeOrder(order)}</p>
            <p className="text-xs text-slate-500">
              {order.gameName} · creada el {formatDateTime(order.createdAt)}
            </p>
          </div>

          <div className="text-right">
            <p className="text-xl font-bold tabular text-white">
              {formatBs(order.pricing.totalBs)}
            </p>
            <p className="text-xs tabular text-slate-400">
              {formatUsd(order.pricing.totalUsd)} · tasa {order.pricing.rate}
            </p>
            {walletApplied > 0 && (
              <p className="text-xs tabular text-emerald-300">
                Saldo aplicado {formatUsd(walletApplied)}
                {order.pricing.totalBs === 0 && ' · sin transferencia'}
              </p>
            )}
            {order.pricing.profitUsd !== undefined && (
              <p className="text-xs tabular text-emerald-400">
                Utilidad {formatUsd(order.pricing.profitUsd)}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-base-600 pt-4">
          {canRetry && (
            <Button
              size="sm"
              loading={retry.isPending}
              leftIcon={<RotateCcw className="h-4 w-4" aria-hidden />}
              onClick={() =>
                retry.mutate(order.id, {
                  onSuccess: () => toast.success('Reintento ejecutado.'),
                  onError: (mutationError) => toast.error(errorMessage(mutationError)),
                })
              }
            >
              Reintentar despacho
            </Button>
          )}

          {canComplete && (
            <Button
              size="sm"
              variant="success"
              leftIcon={<CheckCircle2 className="h-4 w-4" aria-hidden />}
              onClick={() => setCompleteOpen(true)}
            >
              Marcar completada
            </Button>
          )}

          {canRefund && isAdmin && (
            <Button
              size="sm"
              variant="danger"
              leftIcon={<Undo2 className="h-4 w-4" aria-hidden />}
              onClick={() => setRefundOpen(true)}
            >
              Reembolsar
            </Button>
          )}

          {order.whatsappUrl && (
            <Button
              size="sm"
              variant="whatsapp"
              leftIcon={<MessageCircle className="h-4 w-4" aria-hidden />}
              onClick={() => openWhatsapp(order.whatsappUrl!)}
            >
              Abrir WhatsApp
            </Button>
          )}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Cliente y jugador" icon={<User className="h-4 w-4" aria-hidden />} />
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Correo</dt>
              <dd className="truncate text-white">{order.user.email ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Nombre</dt>
              <dd className="truncate text-white">{order.user.displayName ?? '—'}</dd>
            </div>
            {/* Todos los datos que pidió el juego. Para un Mobile Legends son
                dos, y sin el Zone ID no se puede reenviar la recarga a mano. */}
            {(playerFields.length > 0
              ? playerFields
              : [{ key: 'playerId', label: 'ID de jugador', sensitive: false }]
            ).map((field) => {
              const value =
                order.playerFields?.[field.key] ??
                (field.key === 'playerId' ? order.playerId : '');
              if (!value) return null;

              return (
                <div key={field.key} className="flex items-center justify-between gap-3">
                  <dt className="text-slate-400">{field.label}</dt>
                  <dd className="flex items-center gap-2">
                    <span className="tabular text-white">
                      {field.sensitive && !revealSensitive ? '••••••••' : value}
                    </span>
                    {field.sensitive && (
                      <button
                        type="button"
                        onClick={() => setRevealSensitive((current) => !current)}
                        className="rounded p-1 text-slate-500 hover:text-white"
                        aria-label={revealSensitive ? 'Ocultar' : 'Mostrar'}
                      >
                        {revealSensitive ? (
                          <EyeOff className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void copy(value, field.key)}
                      className="rounded p-1 text-slate-500 hover:text-white"
                      aria-label={`Copiar ${field.label}`}
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </dd>
                </div>
              );
            })}
            {customer && (
              <>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-400">Órdenes completadas</dt>
                  <dd className="tabular text-white">{customer.stats.completedOrders}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-400">Total gastado</dt>
                  <dd className="tabular text-white">{formatUsd(customer.stats.totalSpentUsd)}</dd>
                </div>
                <div className="pt-2">
                  <Link
                    to={ROUTES.adminUser(customer.uid)}
                    className="text-xs font-semibold text-neon-crimson hover:underline"
                  >
                    Ver ficha del usuario →
                  </Link>
                </div>
              </>
            )}
          </dl>
        </Card>

        <Card>
          <CardHeader title="Pago" />
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">Referencia</dt>
              <dd className="flex items-center gap-2">
                <span className="tabular text-white">{order.payment.reference ?? '—'}</span>
                {order.payment.reference && (
                  <button
                    type="button"
                    onClick={() => void copy(order.payment.reference!, 'ref')}
                    className="rounded p-1 text-slate-500 hover:text-white"
                    aria-label="Copiar referencia"
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Verificado</dt>
              <dd className="text-white">{formatDateTime(order.payment.verifiedAt)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Intentos</dt>
              <dd className="tabular text-white">{order.payment.attempts}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-slate-400">Banco destino</dt>
              <dd className="text-white">
                {order.payment.bankSnapshot.code} · {order.payment.bankSnapshot.idNumber}
                {order.payment.method === 'transfer' && ' · Transferencia'}
              </dd>
            </div>
            {order.meta?.ip && (
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">IP</dt>
                <dd className="tabular text-slate-300">{order.meta.ip}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>

      {order.fulfillment === 'auto' && (
        <Card>
          <CardHeader
            title="Llamadas al proveedor"
            description={
              order.dispatch.calls.length > 1
                ? 'Combo: las llamadas se ejecutan en secuencia. El reintento sólo repite las que fallaron.'
                : undefined
            }
          />

          {order.dispatch.calls.length === 0 ? (
            <p className="text-sm text-slate-400">Sin llamadas configuradas.</p>
          ) : (
            <ul className="space-y-2">
              {order.dispatch.calls.map((call) => (
                <li
                  key={call.index}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-base-900/60 px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    {call.status === 'success' ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden />
                    ) : call.status === 'error' ? (
                      <XCircle className="h-4 w-4 text-red-400" aria-hidden />
                    ) : call.status === 'processing' ? (
                      <Loader2 className="h-4 w-4 animate-spin text-amber-400" aria-hidden />
                    ) : (
                      <Circle className="h-4 w-4 text-slate-500" aria-hidden />
                    )}
                    <span className="text-sm text-white">
                      #{call.index + 1} · package_id {call.packageId}
                      {call.providerGameId ? ` · game_id ${call.providerGameId}` : ''}
                    </span>
                  </div>

                  <div className="text-right text-xs">
                    {call.providerOrderId && (
                      <p className="tabular text-slate-300">
                        Orden proveedor: {call.providerOrderId}
                        {call.providerStatus && (
                          <span className="text-slate-500"> · {call.providerStatus}</span>
                        )}
                      </p>
                    )}
                    {call.playerName && (
                      <p className="text-slate-300">Jugador: {call.playerName}</p>
                    )}
                    {call.error && <p className="text-red-400">{call.error}</p>}
                    <p className="text-slate-500">
                      {call.attempts} intento(s)
                      {call.httpStatus ? ` · HTTP ${call.httpStatus}` : ''}
                      {call.completedAt ? ` · ${formatDateTime(call.completedAt)}` : ''}
                    </p>
                  </div>

                  {/* Respuesta cruda del proveedor: sin esto, un fallo de
                      despacho no se puede diagnosticar. */}
                  {call.providerResponse && (
                    <details className="w-full">
                      <summary className="cursor-pointer text-[11px] font-semibold text-neon-crimson">
                        Ver respuesta del proveedor
                      </summary>
                      <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-base-900 p-3 text-[11px] leading-relaxed text-slate-300">
                        {JSON.stringify(call.providerResponse, null, 2)}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}

          {order.dispatch.lastError && (
            <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">
              Último error: {order.dispatch.lastError}
            </p>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="Nota interna" description="Sólo la ve el equipo" />
        <Textarea
          value={note}
          onChange={(event) => setNoteValue(event.target.value.slice(0, 1000))}
          placeholder="Anota aquí lo que haga falta para el seguimiento…"
          rows={3}
        />
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          loading={setNote.isPending}
          leftIcon={<Save className="h-4 w-4" aria-hidden />}
          onClick={() =>
            setNote.mutate(
              { orderId: order.id, note },
              {
                onSuccess: () => toast.success('Nota guardada.'),
                onError: (mutationError) => toast.error(errorMessage(mutationError)),
              }
            )
          }
        >
          Guardar nota
        </Button>
      </Card>

      <Card>
        <CardHeader title="Historial" />
        <ol className="space-y-3">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 text-sm">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-base-500" aria-hidden />
              <div className="min-w-0">
                <p className="text-slate-200">{event.message}</p>
                <p className="text-xs text-slate-500">
                  {formatDateTime(event.createdAt)} · {event.actor}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <ConfirmDialog
        open={completeOpen}
        onClose={() => setCompleteOpen(false)}
        onConfirm={() =>
          complete.mutate(
            { orderId: order.id, note: note || undefined },
            {
              onSuccess: () => {
                toast.success('Orden marcada como completada.');
                setCompleteOpen(false);
              },
              onError: (mutationError) => toast.error(errorMessage(mutationError)),
            }
          )
        }
        title="Marcar como completada"
        message="Confirma que el producto ya fue entregado al jugador. Se le notificará y se sumará a sus estadísticas."
        confirmLabel="Sí, completar"
        loading={complete.isPending}
      />

      <ConfirmDialog
        open={refundOpen}
        onClose={() => setRefundOpen(false)}
        onConfirm={() =>
          refund.mutate(
            { orderId: order.id, toWallet: refundToWallet, note: note || undefined },
            {
              onSuccess: () => {
                toast.success('Orden reembolsada.');
                setRefundOpen(false);
              },
              onError: (mutationError) => toast.error(errorMessage(mutationError)),
            }
          )
        }
        title="Reembolsar orden"
        message={
          <div className="space-y-4">
            <p>
              La orden pasará a estado <strong>reembolsada</strong> y se descontará de los ingresos
              del día.
            </p>
            <Switch
              checked={refundToWallet}
              onChange={setRefundToWallet}
              label={`Acreditar ${formatUsd(order.pricing.totalUsd)} al saldo del cliente`}
              description="Desactívalo si vas a devolver el dinero por transferencia."
            />
          </div>
        }
        confirmLabel="Reembolsar"
        destructive
        loading={refund.isPending}
      />
    </div>
  );
}
