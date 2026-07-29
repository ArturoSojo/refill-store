import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, LifeBuoy, MessageCircle, Plus, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useTickets,
  useTicket,
  useCreateTicket,
  useSendTicketMessage,
} from '@/hooks/useAccount';
import { useMyOrders } from '@/hooks/useOrders';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, FullPageLoader, Skeleton } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn, errorMessage } from '@/lib/utils';

const STATUS_LABEL = {
  open: { label: 'Abierto', variant: 'info' as const },
  pending: { label: 'En espera', variant: 'warning' as const },
  closed: { label: 'Cerrado', variant: 'default' as const },
};

export function SupportPage() {
  useDocumentTitle('Soporte');
  const { user } = useAuth();
  const { config } = useConfig();
  const tickets = useTickets();
  const orders = useMyOrders();
  const createTicket = useCreateTicket();

  const [formOpen, setFormOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [orderId, setOrderId] = useState('');

  const list = tickets.data?.tickets ?? [];

  const submit = () => {
    createTicket.mutate(
      { subject: subject.trim(), message: message.trim(), orderId: orderId || null },
      {
        onSuccess: () => {
          toast.success('Consulta enviada. Te respondemos pronto.');
          setFormOpen(false);
          setSubject('');
          setMessage('');
          setOrderId('');
        },
        onError: (error) => toast.error(errorMessage(error)),
      }
    );
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
          <LifeBuoy className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-bold">Soporte</h1>
          <p className="text-sm text-slate-400">Estamos para ayudarte</p>
        </div>
      </div>

      {config?.supportUrl && (
        <Card className="border-green-500/25 bg-green-500/5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-500/15 text-green-400">
              <MessageCircle className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">Respuesta más rápida por WhatsApp</p>
              <p className="mt-0.5 text-xs text-slate-400">
                Ideal si tu recarga es urgente o tienes un pago pendiente.
              </p>
              <ButtonLink
                className="mt-3"
                to={config.supportUrl}
                external
                variant="whatsapp"
                size="sm"
              >
                Abrir WhatsApp
              </ButtonLink>
            </div>
          </div>
        </Card>
      )}

      {user ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">Mis consultas</h2>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Plus className="h-4 w-4" aria-hidden />}
              onClick={() => setFormOpen(true)}
            >
              Nueva consulta
            </Button>
          </div>

          {tickets.isLoading ? (
            <div className="space-y-3">
              {[0, 1].map((index) => (
                <Skeleton key={index} className="h-20 rounded-2xl" />
              ))}
            </div>
          ) : list.length === 0 ? (
            <EmptyState
              title="Sin consultas"
              description="Abre una consulta y te responderemos desde el panel."
              action={<Button onClick={() => setFormOpen(true)}>Escribir consulta</Button>}
            />
          ) : (
            <ul className="space-y-2">
              {list.map((ticket) => (
                <li key={ticket.id}>
                  <Link to={ROUTES.ticket(ticket.id)} className="card card-hover block p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white">
                          {ticket.subject}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-slate-400">
                          {ticket.lastMessagePreview}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {formatRelative(ticket.updatedAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <Badge variant={STATUS_LABEL[ticket.status].variant}>
                          {STATUS_LABEL[ticket.status].label}
                        </Badge>
                        {ticket.unreadForUser && (
                          <span className="h-2 w-2 rounded-full bg-neon-red" aria-label="Nuevo mensaje" />
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <Card className="text-center">
          <p className="text-sm text-slate-400">
            Inicia sesión para abrir una consulta y ver tus respuestas.
          </p>
          <ButtonLink className="mt-4" to={ROUTES.login} fullWidth>
            Iniciar sesión
          </ButtonLink>
        </Card>
      )}

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title="Nueva consulta"
        description="Cuéntanos qué pasó y lo revisamos."
        size="md"
      >
        <div className="space-y-4">
          <Input
            label="Asunto"
            value={subject}
            onChange={(event) => setSubject(event.target.value.slice(0, 120))}
            placeholder="Ej: Mi recarga no llegó"
            required
          />

          <Select
            label="¿Es sobre alguna orden?"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            placeholder="Ninguna en particular"
            options={(orders.data?.orders ?? []).slice(0, 20).map((order) => ({
              value: order.id,
              label: `${order.code} — ${order.productName}`,
            }))}
          />

          <Textarea
            label="Mensaje"
            value={message}
            onChange={(event) => setMessage(event.target.value.slice(0, 2000))}
            placeholder="Describe con detalle lo que ocurrió…"
            rows={5}
            required
          />

          <Button
            fullWidth
            disabled={subject.trim().length < 4 || message.trim().length < 4}
            loading={createTicket.isPending}
            onClick={submit}
          >
            Enviar consulta
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function TicketPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const { data, isLoading } = useTicket(ticketId);
  const sendMessage = useSendTicketMessage(ticketId);
  const [body, setBody] = useState('');

  useDocumentTitle(data?.ticket.subject ?? 'Consulta');

  if (isLoading || !data) return <FullPageLoader />;

  const { ticket, messages } = data;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-2xl flex-col px-4 py-6">
      <Link
        to={ROUTES.support}
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Soporte
      </Link>

      <Card className="mb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-white">{ticket.subject}</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Abierta el {formatDateTime(ticket.createdAt)}
            </p>
          </div>
          <Badge variant={STATUS_LABEL[ticket.status].variant}>
            {STATUS_LABEL[ticket.status].label}
          </Badge>
        </div>
      </Card>

      <ul className="flex-1 space-y-3">
        {messages.map((entry) => (
          <li
            key={entry.id}
            className={cn('flex', entry.fromStaff ? 'justify-start' : 'justify-end')}
          >
            <div
              className={cn(
                'max-w-[85%] rounded-2xl px-4 py-3',
                entry.fromStaff
                  ? 'rounded-tl-sm border border-base-600 bg-base-800'
                  : 'rounded-tr-sm bg-neon-red/20 border border-neon-red/30'
              )}
            >
              <p className="whitespace-pre-wrap text-sm text-slate-100">{entry.body}</p>
              <p className="mt-1.5 text-[11px] text-slate-500">
                {entry.fromStaff ? 'Soporte' : 'Tú'} · {formatRelative(entry.createdAt)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {ticket.status !== 'closed' && (
        <div className="safe-bottom sticky bottom-20 mt-4 md:bottom-0">
          <div className="flex items-end gap-2 rounded-2xl border border-base-600 bg-base-800 p-2">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value.slice(0, 2000))}
              placeholder="Escribe tu mensaje…"
              rows={2}
              className="min-h-[44px] border-0 bg-transparent focus:ring-0"
            />
            <Button
              size="icon"
              disabled={body.trim().length === 0}
              loading={sendMessage.isPending}
              onClick={() =>
                sendMessage.mutate(body.trim(), {
                  onSuccess: () => setBody(''),
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
              aria-label="Enviar"
            >
              <Send className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
