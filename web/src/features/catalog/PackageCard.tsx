/**
 * Tarjeta de paquete seleccionable.
 *
 * A diferencia de la versión anterior, no navega: se selecciona en la misma
 * pantalla y el resumen fijo de abajo se actualiza. Así el cliente compara
 * paquetes sin perder el ID que ya escribió.
 *
 * La jerarquía visual pone primero la cantidad de moneda del juego (que es lo
 * que el jugador busca) y después el precio en bolívares (que es lo que va a
 * transferir). El precio en dólares queda de apoyo.
 */
import { motion } from 'framer-motion';
import { Check, MessageCircle, Zap } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { formatBs, formatUsd } from '@/lib/format';
import { cn, hexToRgb } from '@/lib/utils';
import type { Game, PublicProduct } from '@/types/models';

interface PackageCardProps {
  product: PublicProduct;
  game: Game;
  selected: boolean;
  onSelect: () => void;
  index?: number;
}

export function PackageCard({ product, game, selected, onSelect, index = 0 }: PackageCardProps) {
  const accent = game.accentColor || '#F03030';
  const soldOut = product.stock !== null && product.stock <= 0;
  const isManual = product.fulfillment === 'manual';
  const hasDiscount = product.compareAtUsd !== null && product.compareAtUsd > product.priceUsd;

  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.035, 0.4), duration: 0.28 }}
      whileTap={soldOut ? undefined : { scale: 0.97 }}
      onClick={soldOut ? undefined : onSelect}
      disabled={soldOut}
      data-selected={selected}
      aria-pressed={selected}
      className={cn(
        'neon-card sheen flex w-full flex-col p-3 text-left',
        soldOut ? 'cursor-not-allowed opacity-45' : 'hover:-translate-y-0.5'
      )}
      style={
        {
          '--accent': accent,
          '--accent-soft': `rgba(${hexToRgb(accent)}, 0.26)`,
        } as React.CSSProperties
      }
    >
      {product.badge && (
        <span
          className="absolute right-0 top-2.5 z-10 rounded-l-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-white"
          style={{ backgroundColor: accent }}
        >
          {product.badge}
        </span>
      )}

      {selected && (
        <motion.span
          initial={{ scale: 0, rotate: -30 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', damping: 13, stiffness: 420 }}
          className="absolute left-2.5 top-2.5 z-10 flex h-5 w-5 items-center justify-center rounded-full text-black"
          style={{ backgroundColor: accent }}
        >
          <Check className="h-3 w-3" strokeWidth={3.5} aria-hidden />
        </motion.span>
      )}

      {/* Cantidad de moneda del juego */}
      <div className="mb-2 flex items-baseline gap-1.5 pt-3">
        <CurrencyIcon game={game} className="h-7 w-7 self-center text-2xl" />
        <div className="min-w-0">
          {product.kind === 'special' ? (
            <p className="truncate text-sm font-bold leading-tight text-white">{product.name}</p>
          ) : (
            <>
              <p className="text-xl font-black leading-none text-white">
                {product.amount.toLocaleString('es-VE')}
              </p>
              {product.bonus > 0 && (
                <p className="text-[11px] font-bold leading-tight text-emerald-400">
                  +{product.bonus.toLocaleString('es-VE')} extra
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Precio */}
      <div className="mt-auto">
        <p className="text-base font-extrabold leading-tight tabular text-white">
          {formatBs(product.priceBs)}
        </p>
        <p className="flex items-center gap-1.5 text-[11px] tabular text-slate-400">
          {formatUsd(product.priceUsd)}
          {hasDiscount && (
            <span className="text-slate-600 line-through">
              {formatUsd(product.compareAtUsd ?? 0)}
            </span>
          )}
        </p>
      </div>

      <span
        className={cn(
          'mt-2 inline-flex items-center gap-1 self-start rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
          isManual ? 'bg-green-500/15 text-green-300' : 'bg-neon-red/15 text-neon-crimson'
        )}
      >
        {isManual ? (
          <>
            <MessageCircle className="h-2.5 w-2.5" aria-hidden />
            WhatsApp
          </>
        ) : (
          <>
            <Zap className="h-2.5 w-2.5" aria-hidden />
            Instantáneo
          </>
        )}
      </span>

      {soldOut && (
        <span className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-base-900/70 text-xs font-bold text-red-300">
          AGOTADO
        </span>
      )}
    </motion.button>
  );
}
