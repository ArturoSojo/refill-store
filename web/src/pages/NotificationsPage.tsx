import { Link } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { useNotifications, useMarkNotificationsRead } from '@/hooks/useAccount';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Button } from '@/components/ui/Button';
import { EmptyState, Skeleton } from '@/components/ui/Feedback';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

export function NotificationsPage() {
  useDocumentTitle('Notificaciones');
  const { data, isLoading } = useNotifications();
  const markRead = useMarkNotificationsRead();

  const notifications = data?.notifications ?? [];
  const unread = notifications.filter((item) => !item.read).length;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
            <Bell className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h1 className="text-xl font-bold">Notificaciones</h1>
            <p className="text-sm text-slate-400">
              {unread > 0 ? `${unread} sin leer` : 'Todo al día'}
            </p>
          </div>
        </div>

        {unread > 0 && (
          <Button
            size="sm"
            variant="secondary"
            loading={markRead.isPending}
            leftIcon={<CheckCheck className="h-4 w-4" aria-hidden />}
            onClick={() => markRead.mutate()}
          >
            Marcar leídas
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={<BellOff className="h-7 w-7" aria-hidden />}
          title="Sin notificaciones"
          description="Aquí te avisaremos cuando tus recargas se entreguen o haya novedades."
        />
      ) : (
        <ul className="space-y-2">
          {notifications.map((notification) => {
            const content = (
              <div
                className={cn(
                  'card flex gap-3 p-4 transition',
                  !notification.read && 'border-neon-red/40 bg-neon-red/5'
                )}
              >
                <span
                  className={cn(
                    'mt-1 h-2 w-2 shrink-0 rounded-full',
                    notification.read ? 'bg-base-500' : 'bg-neon-red'
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-white">{notification.title}</p>
                  <p className="mt-0.5 text-sm text-slate-400">{notification.body}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatRelative(notification.createdAt)}
                  </p>
                </div>
              </div>
            );

            return (
              <li key={notification.id}>
                {notification.link ? (
                  <Link to={notification.link}>{content}</Link>
                ) : (
                  content
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
