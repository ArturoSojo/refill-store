import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LifeBuoy, MessageSquare } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAdminTickets, useSetTicketStatus } from '@/hooks/useAdmin';
import { useAuditLogs } from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { Badge, EmptyState, Skeleton } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { auditActionLabel, formatDateTime, formatRelative } from '@/lib/format';
import { errorMessage } from '@/lib/utils';

const STATUS_META = {
  open: { label: 'Abierto', variant: 'info' as const },
  pending: { label: 'En espera', variant: 'warning' as const },
  closed: { label: 'Cerrado', variant: 'default' as const },
};

export function AdminSupport() {
  useDocumentTitle('Panel · Soporte');
  const [status, setStatus] = useState('');

  const tickets = useAdminTickets(status || undefined);
  const setTicketStatus = useSetTicketStatus();

  const list = tickets.data?.tickets ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Soporte</h1>
          <p className="text-sm text-slate-400">{list.length} consulta(s)</p>
        </div>

        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          placeholder="Todos los estados"
          options={[
            { value: 'open', label: 'Abiertos' },
            { value: 'pending', label: 'En espera' },
            { value: 'closed', label: 'Cerrados' },
          ]}
          containerClassName="w-48"
        />
      </div>

      {tickets.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<LifeBuoy className="h-7 w-7" aria-hidden />}
          title="Sin consultas"
          description="Cuando un cliente escriba desde la web, su consulta aparecerá aquí."
        />
      ) : (
        <Card className="p-0">
          {list.map((ticket) => (
            <div
              key={ticket.id}
              className="flex flex-wrap items-center gap-3 border-b border-base-700 px-4 py-3 last:border-b-0"
            >
              {/* Al panel, no a la tienda: `ROUTES.ticket` abre la pantalla del
                  cliente y sacaba al administrador del panel. */}
              <Link to={ROUTES.adminTicket(ticket.id)} className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-white">
                    {ticket.subject}
                  </span>
                  <Badge variant={STATUS_META[ticket.status].variant}>
                    {STATUS_META[ticket.status].label}
                  </Badge>
                  {ticket.unreadForStaff && <Badge variant="brand">Nuevo</Badge>}
                </div>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {ticket.userEmail} · {ticket.lastMessagePreview}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {formatRelative(ticket.updatedAt)}
                </p>
              </Link>

              <Select
                value={ticket.status}
                onChange={(event) =>
                  setTicketStatus.mutate(
                    {
                      id: ticket.id,
                      status: event.target.value as 'open' | 'pending' | 'closed',
                    },
                    {
                      onSuccess: () => toast.success('Estado actualizado.'),
                      onError: (error) => toast.error(errorMessage(error)),
                    }
                  )
                }
                options={[
                  { value: 'open', label: 'Abierto' },
                  { value: 'pending', label: 'En espera' },
                  { value: 'closed', label: 'Cerrado' },
                ]}
                containerClassName="w-36"
                className="py-2 text-xs"
              />
            </div>
          ))}
        </Card>
      )}

      <p className="text-xs text-slate-500">
        Para responder, abre la consulta: los mensajes del staff llegan como notificación al
        cliente.
      </p>
    </div>
  );
}

export function AdminLogs() {
  useDocumentTitle('Panel · Bitácora');
  const [action, setAction] = useState('');
  const logs = useAuditLogs({ action: action || undefined, limit: 100 });

  const list = logs.data?.logs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Bitácora</h1>
          <p className="text-sm text-slate-400">Registro de acciones sensibles</p>
        </div>

        <Select
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="Todas las acciones"
          options={[
            { value: 'order.payment.verified', label: 'Pagos verificados' },
            { value: 'order.payment.rejected', label: 'Pagos rechazados' },
            { value: 'order.dispatched', label: 'Despachos' },
            { value: 'order.dispatch.failed', label: 'Fallos de despacho' },
            { value: 'order.retried', label: 'Reintentos' },
            { value: 'order.refunded', label: 'Reembolsos' },
            { value: 'config.updated', label: 'Configuración' },
            { value: 'rate.updated', label: 'Cambios de tasa' },
            { value: 'user.role.changed', label: 'Cambios de rol' },
            { value: 'user.banned', label: 'Bloqueos' },
            { value: 'product.updated', label: 'Productos' },
          ]}
          containerClassName="w-56"
        />
      </div>

      {logs.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<MessageSquare className="h-7 w-7" aria-hidden />}
          title="Sin registros"
          description="Aquí quedará constancia de cada acción del equipo."
        />
      ) : (
        <Card className="p-0">
          {list.map((log) => (
            <div key={log.id} className="border-b border-base-700 px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="brand">{auditActionLabel(log.action)}</Badge>
                <span className="text-xs text-slate-500">{formatDateTime(log.createdAt)}</span>
              </div>
              <p className="mt-1.5 text-sm text-slate-200">{log.summary}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {log.actorEmail ?? log.actorUid ?? 'sistema'}
                {log.ip ? ` · ${log.ip}` : ''}
              </p>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
