/**
 * Bandeja de avisos del equipo.
 *
 * Es el canal que no depende de nada externo: aunque Telegram o el webhook
 * fallen, todo lo que necesita una persona queda aquí. Cada aviso dice además
 * por qué canales salió, que es la única forma de darse cuenta de que el bot
 * dejó de funcionar sin esperar a que se pierda una venta.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BellRing,
  CheckCheck,
  ExternalLink,
  Send,
  ShieldAlert,
  Wallet,
  MessageSquare,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useAdminAlerts,
  useMarkAlertRead,
  useMarkAlertsRead,
  useTestAlert,
} from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { LoadMore } from '@/components/common/LoadMore';
import { ROUTES } from '@/lib/constants';
import { formatDateTime } from '@/lib/format';
import { cn, errorMessage } from '@/lib/utils';
import type { AdminAlert } from '@/types/models';

const ICONS: Record<AdminAlert['kind'], typeof BellRing> = {
  dispatch_failed: ShieldAlert,
  manual_order: MessageSquare,
  new_ticket: MessageSquare,
  ticket_reply: MessageSquare,
  payment_rejected: ShieldAlert,
  low_balance: Wallet,
  provider_down: ShieldAlert,
  test: BellRing,
};

const SEVERITY_STYLE: Record<AdminAlert['severity'], string> = {
  info: 'bg-base-700 text-slate-300',
  warning: 'bg-amber-500/15 text-amber-300',
  critical: 'bg-red-500/15 text-red-300',
};

/** Traduce el resultado de envío a algo que se entienda de un vistazo. */
function DeliveryTag({ channel, state }: { channel: string; state: string }) {
  if (state === 'skipped') return null;

  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
        state === 'sent' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
      )}
    >
      {channel} {state === 'sent' ? '✓' : '✗'}
    </span>
  );
}

export function AdminAlerts() {
  useDocumentTitle('Panel · Avisos');
  const [onlyUnread, setOnlyUnread] = useState(false);

  const alerts = useAdminAlerts({ onlyUnread, limit: 60 });
  const markAll = useMarkAlertsRead();
  const markOne = useMarkAlertRead();
  const testAlert = useTestAlert();

  const list = alerts.items;
  const unread = alerts.unread;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Avisos</h1>
          <p className="text-sm text-slate-400">
            {unread > 0 ? `${unread} sin leer` : 'Todo revisado'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            loading={testAlert.isPending}
            leftIcon={<Send className="h-4 w-4" aria-hidden />}
            onClick={() =>
              testAlert.mutate(undefined, {
                onSuccess: (data) => {
                  const telegram = data.delivery?.telegram;
                  const webhook = data.delivery?.webhook;
                  toast.success(
                    telegram === 'sent' || webhook === 'sent'
                      ? 'Aviso de prueba enviado.'
                      : 'Aviso guardado, pero no salió por ningún canal externo. Revisa la configuración.'
                  );
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            Probar envío
          </Button>

          {unread > 0 && (
            <Button
              size="sm"
              loading={markAll.isPending}
              leftIcon={<CheckCheck className="h-4 w-4" aria-hidden />}
              onClick={() => markAll.mutate()}
            >
              Marcar todo leído
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        {[
          { id: false, label: 'Todos' },
          { id: true, label: 'Sin leer' },
        ].map((item) => (
          <button
            key={String(item.id)}
            type="button"
            onClick={() => setOnlyUnread(item.id)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm font-medium transition',
              onlyUnread === item.id
                ? 'border-neon-red bg-neon-red/15 text-white'
                : 'border-base-600 bg-base-800 text-slate-400 hover:text-white'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {alerts.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<BellRing className="h-7 w-7" aria-hidden />}
          title="Sin avisos"
          description="Aquí aparecerán las recargas fallidas, los productos manuales pagados, las consultas de soporte y el saldo bajo del proveedor."
        />
      ) : (
        <Card className="p-0">
          {list.map((alert) => {
            const Icon = ICONS[alert.kind] ?? BellRing;

            return (
              <div
                key={alert.id}
                className={cn(
                  'flex gap-3 border-b border-base-700 px-4 py-3 last:border-b-0',
                  !alert.read && 'bg-neon-red/[0.04]'
                )}
              >
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                    SEVERITY_STYLE[alert.severity]
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-white">{alert.title}</h2>
                    {!alert.read && <Badge variant="danger">Nuevo</Badge>}
                  </div>

                  <p className="mt-1 whitespace-pre-line text-sm text-slate-300">{alert.body}</p>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span>{formatDateTime(alert.createdAt)}</span>
                    <DeliveryTag channel="Telegram" state={alert.delivery?.telegram ?? 'skipped'} />
                    <DeliveryTag channel="Webhook" state={alert.delivery?.webhook ?? 'skipped'} />

                    {alert.link && (
                      <Link
                        to={alert.link}
                        className="inline-flex items-center gap-1 font-semibold text-neon-crimson hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" aria-hidden />
                        Abrir
                      </Link>
                    )}

                    {!alert.read && (
                      <button
                        type="button"
                        onClick={() => markOne.mutate(alert.id)}
                        className="font-semibold text-slate-400 hover:text-white"
                      >
                        Marcar leído
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <LoadMore
        loaded={list.length}
        total={alerts.total}
        hasMore={alerts.hasMore}
        loading={alerts.isLoadingMore}
        onLoadMore={alerts.loadMore}
        label="avisos"
      />

      <p className="text-center text-xs text-slate-500">
        ¿No te llegan por Telegram o correo? Configúralo en{' '}
        <Link to={ROUTES.adminSettings} className="font-semibold text-neon-crimson hover:underline">
          Configuración → Avisos
        </Link>
        .
      </p>
    </div>
  );
}
