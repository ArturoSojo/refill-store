import { useState } from 'react';
import { motion } from 'framer-motion';
import { LifeBuoy, Loader2, MessageCircle, Save, Sparkles } from 'lucide-react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { BrandMark } from '@/components/common/Brand';
import { Input } from '@/components/ui/Field';
import { OrderStatusBadge } from '@/components/ui/Feedback';
import { useSavePlayerId } from '@/hooks/useAccount';
import { ROUTES } from '@/lib/constants';
import { statusMeta, formatBs } from '@/lib/format';
import { openWhatsapp } from '@/lib/utils';
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
 *  - manual verificada     → botón grande de WhatsApp con el mensaje precargado;
 *  - en proceso o fallida  → estado en vivo y acceso directo al soporte.
 */
export function ResultStep({ order, game, supportUrl }: ResultStepProps) {
  const meta = statusMeta(order.status);
  const savePlayerId = useSavePlayerId();
  const [label, setLabel] = useState('');
  const [saved, setSaved] = useState(false);

  const isProcessing = ['paid', 'dispatching', 'verifying'].includes(order.status);
  const isDone = order.status === 'completed';
  const needsWhatsapp = order.status === 'awaiting_manual' && order.whatsappUrl;

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
            {isProcessing ? (
              <Loader2 className="h-8 w-8 animate-spin text-neon-crimson" aria-hidden />
            ) : needsWhatsapp ? (
              <MessageCircle className="h-8 w-8 text-green-400" aria-hidden />
            ) : (
              <Sparkles className="h-8 w-8 text-amber-400" aria-hidden />
            )}
          </div>
        )}

        <h2 className="text-xl font-bold text-white">
          {isDone
            ? '¡Recarga entregada!'
            : needsWhatsapp
              ? 'Pago verificado'
              : isProcessing
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
            <dd className="text-right font-medium text-white">{order.productName}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">{game.playerIdLabel}</dt>
            <dd className="tabular text-white">{order.playerId}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-400">Pagado</dt>
            <dd className="tabular text-white">{formatBs(order.pricing.totalBs)}</dd>
          </div>
        </dl>
      </motion.div>

      {needsWhatsapp && (
        <div className="card border-green-500/30 bg-green-500/5">
          <p className="text-sm text-green-100">
            Este producto lo activa un asesor. Abre WhatsApp: el mensaje ya lleva tu juego,
            producto, ID, monto y referencia.
          </p>
          <Button
            className="mt-4"
            variant="whatsapp"
            size="lg"
            fullWidth
            leftIcon={<MessageCircle className="h-5 w-5" aria-hidden />}
            onClick={() => openWhatsapp(order.whatsappUrl!)}
          >
            Abrir WhatsApp
          </Button>
        </div>
      )}

      {/* Guardar el ID sólo tiene sentido si el pago salió bien. */}
      {(isDone || needsWhatsapp) && !saved && (
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
        <ButtonLink to={ROUTES.game(order.gameId)} variant="primary" fullWidth>
          Comprar otra recarga
        </ButtonLink>
      </div>

      {(order.status === 'failed' || order.status === 'payment_rejected') && supportUrl && (
        <ButtonLink
          to={supportUrl}
          external
          variant="whatsapp"
          fullWidth
          leftIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}
        >
          Hablar con soporte
        </ButtonLink>
      )}
    </div>
  );
}
