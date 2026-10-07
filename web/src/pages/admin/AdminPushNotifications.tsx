import { useState } from 'react';
import { BellRing, CheckCircle2, Send, Smartphone } from 'lucide-react';
import toast from 'react-hot-toast';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { useDocumentTitle } from '@/hooks/useMisc';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/utils';

const TITLE_LIMIT = 60;
const BODY_LIMIT = 220;
const LINK_LIMIT = 160;

function isInternalAppPath(value: string): boolean {
  return !value || (value.startsWith('/') && !value.startsWith('//'));
}

export function AdminPushNotifications() {
  useDocumentTitle('Panel · Notificaciones push');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  const cleanLink = link.trim();
  const valid = cleanTitle.length >= 3
    && cleanTitle.length <= TITLE_LIMIT
    && cleanBody.length >= 3
    && cleanBody.length <= BODY_LIMIT
    && cleanLink.length <= LINK_LIMIT
    && isInternalAppPath(cleanLink);

  const sendPush = async () => {
    setSending(true);
    try {
      await api.post<{ messageId: string }>('/admin/push', {
        title: cleanTitle,
        body: cleanBody,
        link: cleanLink || null,
      });
      setConfirmOpen(false);
      setSent(true);
      setTitle('');
      setBody('');
      setLink('');
      toast.success('Firebase aceptó el envío push.');
    } catch (error) {
      toast.error(errorMessage(error, 'No se pudo enviar la notificación.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-neon-red/15 text-neon-crimson">
          <BellRing className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Notificaciones push</h1>
          <p className="text-sm text-slate-400">Envía un aviso a quienes tienen la app y habilitaron las notificaciones.</p>
        </div>
      </div>

      {sent && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <p>Firebase aceptó el envío a los dispositivos suscritos. La entrega depende de que cada dispositivo esté conectado y mantenga los permisos activos; no se informa un conteo de entregas.</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]">
        <Card>
          <CardHeader
            title="Redacta el aviso"
            description="Se enviará inmediatamente a todos los dispositivos suscritos a Refill Store."
            icon={<Send className="h-4 w-4" aria-hidden />}
          />

          <div className="space-y-4">
            <Input
              label="Título"
              required
              value={title}
              maxLength={TITLE_LIMIT}
              onChange={(event) => { setTitle(event.target.value); setSent(false); }}
              placeholder="Nueva promoción"
              rightSlot={<span className="text-xs tabular text-slate-500">{title.length}/{TITLE_LIMIT}</span>}
            />
            <Textarea
              label="Mensaje"
              required
              value={body}
              maxLength={BODY_LIMIT}
              onChange={(event) => { setBody(event.target.value); setSent(false); }}
              placeholder="Cuéntales qué hay de nuevo en la tienda…"
              hint={`${body.length}/${BODY_LIMIT} caracteres`}
            />
            <Input
              label="Ruta de la app (opcional)"
              value={link}
              maxLength={LINK_LIMIT}
              onChange={(event) => { setLink(event.target.value); setSent(false); }}
              placeholder="/familia/topup"
              hint="Al tocar la notificación, abrirá esta sección dentro de la app. Usa una ruta que empiece con /; no se permiten enlaces externos."
              error={cleanLink && !isInternalAppPath(cleanLink) ? 'Usa una ruta interna, por ejemplo /familia/topup.' : null}
            />

            <Button
              fullWidth
              leftIcon={<Send className="h-4 w-4" aria-hidden />}
              disabled={!valid}
              onClick={() => setConfirmOpen(true)}
            >
              Revisar y enviar
            </Button>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Vista previa" description="Así se verá el aviso en el teléfono." />
            <div className="rounded-2xl border border-base-500 bg-base-900 p-4 shadow-card">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neon-red/20 text-neon-crimson">
                  <BellRing className="h-5 w-5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-slate-300">Refill Store</p>
                    <span className="text-[10px] text-slate-500">ahora</span>
                  </div>
                  <p className="mt-1 break-words text-sm font-bold text-white">{cleanTitle || 'Título de la notificación'}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">{cleanBody || 'El mensaje aparecerá aquí.'}</p>
                  {cleanLink && isInternalAppPath(cleanLink) && (
                    <p className="mt-2 truncate text-xs text-neon-crimson">Al tocar: {cleanLink}</p>
                  )}
                </div>
              </div>
            </div>
          </Card>

          <Card className="border border-neon-red/20 bg-neon-red/5">
            <div className="flex items-start gap-3">
              <Smartphone className="mt-0.5 h-5 w-5 shrink-0 text-neon-crimson" aria-hidden />
              <div>
                <h2 className="text-sm font-semibold text-white">¿Quiénes la reciben?</h2>
                <p className="mt-1 text-sm text-slate-400">Sólo los dispositivos con la app instalada que aceptaron las notificaciones. Los visitantes de la web no la recibirán.</p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirmar envío"
        description="Se enviará ahora a los dispositivos suscritos de la app."
        size="sm"
        dismissable={!sending}
        footer={(
          <div className="flex w-full gap-2">
            <Button fullWidth variant="secondary" disabled={sending} onClick={() => setConfirmOpen(false)}>
              Volver a editar
            </Button>
            <Button fullWidth loading={sending} leftIcon={<Send className="h-4 w-4" aria-hidden />} onClick={() => void sendPush()}>
              Enviar notificación
            </Button>
          </div>
        )}
      >
        <div className="space-y-3 rounded-xl border border-base-600 bg-base-900 p-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Título</p>
            <p className="mt-1 break-words font-semibold text-white">{cleanTitle}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Mensaje</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-300">{cleanBody}</p>
          </div>
          {cleanLink && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Al tocar</p>
              <p className="mt-1 break-all text-sm text-neon-crimson">{cleanLink}</p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
