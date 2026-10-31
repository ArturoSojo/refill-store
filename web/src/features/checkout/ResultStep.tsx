import { useState } from 'react';
import { motion } from 'framer-motion';
import { LifeBuoy, Loader2, MessageCircle, Save, Send, Sparkles } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { BrandMark } from '@/components/common/Brand';
import { CopyField } from '@/components/common/CopyField';
import { Input } from '@/components/ui/Field';
import { OrderStatusBadge } from '@/components/ui/Feedback';
import { useSavePlayerId } from '@/hooks/useAccount';
import { ROUTES } from '@/lib/constants';
import { statusMeta, formatBs } from '@/lib/format';
import { describeOrder } from '@/lib/orderItem';
import { openWhatsapp } from '@/lib/utils';
import { useConfig } from '@/providers/ConfigProvider';
import { buildTelegramOrderUrl, getActiveSupportChannels, resolveManualWhatsappUrl } from '@/lib/support';
import type { Game, Order } from '@/types/models';

interface ResultStepProps {
  order: Order;
  game: Game;
  supportUrl?: string;
}

/**
 * Pantalla final.
 *
 * Tiene tres caras según cómo terminó la orden:
 *  - automática completada → celebración y enlace al detalle;
 *  - manual verificada     → botones dúo (WhatsApp / Telegram) con mensaje precargado;
 *  - en proceso o fallida  → estado en vivo y acceso directo a canales de soporte.
 */
export function ResultStep({ order, game, supportUrl }: ResultStepProps) {
  const { config } = useConfig();
  const { showWhatsapp, showTelegram } = getActiveSupportChannels(config);
  const meta = statusMeta(order.status);
  const savePlayerId = useSavePlayerId();
  const [label, setLabel] = useState('');
  const [saved, setSaved] = useState(false);

  const isProcessing = ['paid', 'dispatching', 'verifying'].includes(order.status);
  const isDone = order.status === 'completed';
  const canRetryPayment = ['awaiting_payment', 'payment_rejected'].includes(order.status);
  const paymentConfirmed = ['paid', 'dispatching', 'awaiting_manual', 'in_review', 'completed', 'failed'].includes(order.status);
  const isManualAwaiting = order.status === 'awaiting_manual';
  const manualWhatsappUrl = resolveManualWhatsappUrl(order, config);
  const needsFulfillmentChat = isManualAwaiting && (Boolean(manualWhatsappUrl) || showTelegram);
  // Manual sin chat: el equipo lo entrega y avisa si ningún canal de chat está activo.
  const manualPending = isManualAwaiting && !manualWhatsappUrl && !showTelegram;

  return (
    <div className="space-y-5">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', damping: 20, stiffness: 260 }}
        className="card text-center"
      >
        {/* Entrega completada: se celebra con el emblema de la marca en vez de
            un icono genérico. Es el momento de la compra que más se recuerda. */}
        {isDone ? (
          <motion.div
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', damping: 12, stiffness: 220 }}
            className="mx-auto mb-4 flex items-center justify-center"
          >
            <BrandMark size={88} />
          </motion.div>
        ) : (
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/15">
            {isProcessing || manualPending ? (
              <Loader2 className="h-8 w-8 animate-spin text-neon-crimson" aria-hidden />
            ) : needsFulfillmentChat ? (
              <MessageCircle className="h-8 w-8 text-emerald-400" aria-hidden />
            ) : (
              <Sparkles className="h-8 w-8 text-amber-400" aria-hidden />
            )}
          </div>
        )}

        <h2 className="text-xl font-bold text-white">
          {isDone
            ? '¡Recarga entregada!'
            : needsFulfillmentChat
              ? 'Pago verificado'
              : isProcessing || manualPending
                ? 'Procesando tu recarga…'
                : meta.label}
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-slate-400">{meta.description}</p>

        <div className="mt-4 flex items-center justify-center gap-2">
          <OrderStatusBadge status={order.status} />
          <span className="rounded-full border border-base-600 bg-base-900 px-2.5 py-1 text-xs font-semibold tabular text-slate-300">
            {order.code}
          </span>
        </div>

        <dl className="mt-5 space-y-1.5 border-t border-base-600 pt-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-400">Producto</dt>
            <dd className="text-right font-medium text-white">{describeOrder(order)}</dd>
          </div>
          {order.playerId && <div className="flex justify-between">
            <dt className="text-slate-400">{game.playerIdLabel || 'ID del jugador'}</dt>
            <dd className="tabular text-white">{order.playerId}</dd>
          </div>}
          <div className="flex justify-between">
            <dt className="text-slate-400">{paymentConfirmed ? 'Pagado' : 'Total de la orden'}</dt>
            <dd className="tabular text-white">{formatBs(order.pricing.totalBs)}</dd>
          </div>
        </dl>
      </motion.div>

      {isDone && order.deliveredCodes && order.deliveredCodes.length > 0 && (
        <div className="card border-emerald-500/25">
          <h3 className="mb-3 text-sm font-bold text-emerald-100">Tus códigos digitales</h3>
          <div className="space-y-2">
            {order.deliveredCodes.map((code, index) => (
              <CopyField key={`${index}-${code}`} label={`Código ${index + 1}`} value={code} emphasis />
            ))}
          </div>
        </div>
      )}

      {manualPending && (
        <div className="card border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-amber-50">
            Tu pago ya está confirmado. Este producto lo activa nuestro equipo a mano, así que
            no tienes que hacer nada más.
          </p>
          <p className="mt-2 text-sm text-amber-100/80">
            Te enviaremos una notificación aquí y un correo a{' '}
            <span className="font-semibold">{order.user.email ?? 'tu correo'}</span> apenas esté
            completada.
          </p>
          {order.contactPhone && (
            <p className="mt-2 text-xs text-amber-100/70">
              También te escribiremos al {order.contactPhone}.
            </p>
          )}
        </div>
      )}

      {needsFulfillmentChat && (
        <div className="card border-emerald-500/30 bg-emerald-500/5">
          <p className="text-sm text-emerald-100">
            Este producto lo activa un asesor. Elige por dónde prefieres continuar para completar la entrega:
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {showWhatsapp && manualWhatsappUrl && (
              <Button
                variant="whatsapp"
                size="lg"
                fullWidth
                leftIcon={<MessageCircle className="h-5 w-5" aria-hidden />}
                onClick={() => openWhatsapp(manualWhatsappUrl)}
              >
                Continuar por WhatsApp
              </Button>
            )}
            {showTelegram && (
              <ButtonLink
                to={buildTelegramOrderUrl(order.code, true, config)}
                external
                variant="telegram"
                size="lg"
                fullWidth
                leftIcon={<Send className="h-5 w-5" aria-hidden />}
              >
                Continuar por Telegram
              </ButtonLink>
            )}
          </div>
        </div>
      )}

      {/* Guardar el ID sólo tiene sentido si el pago salió bien. */}
      {(isDone || needsFulfillmentChat || manualPending) && !saved && (
        <div className="card">
          <p className="text-sm font-medium text-white">¿Guardas este ID para la próxima?</p>
          <p className="mt-1 text-xs text-slate-400">
            Aparecerá como acceso rápido en tus próximas compras de {game.name}.
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="Ej: Mi cuenta principal"
              value={label}
              onChange={(event) => setLabel(event.target.value.slice(0, 40))}
              containerClassName="flex-1"
            />
            <Button
              variant="secondary"
              loading={savePlayerId.isPending}
              disabled={label.trim().length < 2}
              leftIcon={<Save className="h-4 w-4" aria-hidden />}
              onClick={() =>
                savePlayerId.mutate(
                  {
                    gameId: order.gameId,
                    playerId: order.playerId,
                    label: label.trim(),
                  },
                  { onSuccess: () => setSaved(true) }
                )
              }
            >
              Guardar
            </Button>
          </div>
        </div>
      )}

      {saved && (
        <p className="rounded-xl bg-emerald-500/10 px-4 py-3 text-center text-sm text-emerald-300">
          ID guardado. Lo verás en tus próximas compras.
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <ButtonLink to={ROUTES.order(order.id)} variant="secondary" fullWidth>
          Ver detalle de la orden
        </ButtonLink>
        <ButtonLink
          to={canRetryPayment ? `${ROUTES.checkout(order.productId)}?orden=${order.id}` : ROUTES.game(order.gameId)}
          variant="primary"
          fullWidth
        >
          {canRetryPayment ? 'Volver a esta orden' : 'Comprar otra recarga'}
        </ButtonLink>
      </div>

      {(order.status === 'in_review' || order.status === 'failed' || order.status === 'payment_rejected') && (
        <div className="grid gap-3 sm:grid-cols-2">
          {showWhatsapp && supportUrl && (
            <ButtonLink
              to={supportUrl}
              external
              variant="whatsapp"
              fullWidth
              leftIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}
            >
              Hablar por WhatsApp
            </ButtonLink>
          )}
          {showTelegram && (
            <ButtonLink
              to={buildTelegramOrderUrl(order.code, false, config)}
              external
              variant="telegram"
              fullWidth
              leftIcon={<Send className="h-4 w-4" aria-hidden />}
            >
              Hablar por Telegram
            </ButtonLink>
          )}
        </div>
      )}
    </div>
  );
}
