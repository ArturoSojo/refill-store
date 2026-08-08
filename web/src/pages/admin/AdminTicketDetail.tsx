/**
 * Conversación de soporte vista desde el panel.
 *
 * Existe porque la lista de tickets enlazaba a `/soporte/:id`, que es la
 * pantalla de la TIENDA: al abrir una consulta, el administrador salía del
 * panel y aparecía en la tienda como un cliente más, con el menú de abajo y sin
 * forma de volver a lo que estaba haciendo.
 *
 * Aquí la conversación vive dentro del panel y además muestra lo que hace falta
 * para responder con criterio: quién escribe, cuánto ha comprado y la orden
 * sobre la que reclama.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, ExternalLink, Receipt, Send, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTicket, useSendTicketMessage } from '@/hooks/useAccount';
import { useSetTicketStatus, useAdminUser } from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select, Textarea } from '@/components/ui/Field';
import { Badge, FullPageLoader, ErrorState } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { formatDateTime, formatRelative, formatUsd } from '@/lib/format';
import { cn, errorMessage } from '@/lib/utils';
import type { TicketStatus } from '@/types/models';

const ESTADOS: Record<TicketStatus, { label: string; variant: 'brand' | 'warning' | 'success' }> = {
  open: { label: 'Abierta', variant: 'brand' },
  pending: { label: 'Pendiente', variant: 'warning' },
  closed: { label: 'Cerrada', variant: 'success' },
};

export function AdminTicketDetail() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const { data, isLoading, error } = useTicket(ticketId);
  const sendMessage = useSendTicketMessage(ticketId);
  const setStatus = useSetTicketStatus();

  const [body, setBody] = useState('');
  const finalRef = useRef<HTMLDivElement>(null);

  const cliente = useAdminUser(data?.ticket.uid);

  useDocumentTitle(data ? `Soporte · ${data.ticket.subject}` : 'Soporte');

  // Al llegar un mensaje nuevo la vista baja sola, como en cualquier chat.
  useEffect(() => {
    finalRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [data?.messages.length]);

  if (isLoading) return <FullPageLoader />;
  if (error || !data) {
    return (
      <ErrorState
        title="Consulta no encontrada"
        message="Puede que se haya eliminado. Vuelve a la lista de soporte."
      />
    );
  }

  const { ticket, messages } = data;
  const perfil = cliente.data?.profile;

  const enviar = () => {
    const texto = body.trim();
    if (!texto) return;

    sendMessage.mutate(texto, {
      onSuccess: () => setBody(''),
      onError: (mutationError) => toast.error(errorMessage(mutationError)),
    });
  };

  return (
    <div className="space-y-4">
      <Link
        to={ROUTES.adminTickets}
        className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Soporte
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-bold text-white">{ticket.subject}</h1>
              <Badge variant={ESTADOS[ticket.status].variant}>
                {ESTADOS[ticket.status].label}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Abierta el {formatDateTime(ticket.createdAt)}
            </p>
          </div>

          <Select
            value={ticket.status}
            onChange={(event) =>
              setStatus.mutate(
                { id: ticket.id, status: event.target.value as TicketStatus },
                {
                  onSuccess: () => toast.success('Estado actualizado.'),
                  onError: (mutationError) => toast.error(errorMessage(mutationError)),
                }
              )
            }
            options={[
              { value: 'open', label: 'Abierta' },
              { value: 'pending', label: 'Pendiente' },
              { value: 'closed', label: 'Cerrada' },
            ]}
            containerClassName="w-40"
          />
        </div>

        {/* Contexto del cliente: responder sin saber si es su primera compra o
            si lleva veinte no es lo mismo. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-base-600 pt-4 text-xs">
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <User className="h-3.5 w-3.5" aria-hidden />
            {ticket.userName ?? ticket.userEmail ?? 'Cliente'}
          </span>
          {perfil && (
            <>
              <span className="text-slate-500">
                {perfil.stats.completedOrders} recargas · {formatUsd(perfil.stats.totalSpentUsd)}
              </span>
              <Link
                to={ROUTES.adminUser(perfil.uid)}
                className="inline-flex items-center gap-1 font-semibold text-neon-crimson hover:underline"
              >
                <ExternalLink className="h-3 w-3" aria-hidden />
                Ver su ficha
              </Link>
            </>
          )}
          {ticket.orderId && (
            <Link
              to={ROUTES.adminOrder(ticket.orderId)}
              className="inline-flex items-center gap-1 font-semibold text-neon-crimson hover:underline"
            >
              <Receipt className="h-3 w-3" aria-hidden />
              Orden relacionada
            </Link>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Conversación" description={`${messages.length} mensaje(s)`} />

        <ul className="space-y-3">
          {messages.map((entry) => (
            <li
              key={entry.id}
              // Invertido respecto a la tienda: aquí «nosotros» somos el staff,
              // así que sus mensajes van a la derecha.
              className={cn('flex', entry.fromStaff ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-4 py-3',
                  entry.fromStaff
                    ? 'rounded-tr-sm border border-neon-red/30 bg-neon-red/15'
                    : 'rounded-tl-sm border border-base-600 bg-base-900'
                )}
              >
                <p className="whitespace-pre-wrap text-sm text-slate-100">{entry.body}</p>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  {entry.fromStaff ? (entry.authorName ?? 'Soporte') : 'Cliente'} ·{' '}
                  {formatRelative(entry.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <div ref={finalRef} />

        {ticket.status === 'closed' ? (
          <p className="mt-4 rounded-xl bg-base-900 px-4 py-3 text-center text-xs text-slate-400">
            Esta consulta está cerrada. Cámbiale el estado arriba para volver a responder.
          </p>
        ) : (
          <div className="mt-4 flex items-end gap-2 rounded-2xl border border-base-600 bg-base-900 p-2">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value.slice(0, 2000))}
              onKeyDown={(event) => {
                // Enter envía; Shift+Enter hace salto de línea.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  enviar();
                }
              }}
              placeholder="Responder al cliente…"
              rows={2}
              className="min-h-[44px] border-0 bg-transparent focus:ring-0"
            />
            <Button
              size="icon"
              disabled={body.trim().length === 0}
              loading={sendMessage.isPending}
              onClick={enviar}
              aria-label="Enviar respuesta"
            >
              <Send className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
