import { Link } from 'react-router-dom';
import { Clock, MessageCircle, Star, Zap } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatUsd } from '@/lib/format';
import { cn, hexToRgb } from '@/lib/utils';
import type { Game, PublicProduct } from '@/types/models';

interface ProductCardProps {
  product: PublicProduct;
  game?: Game;
  currencyIcon?: string;
  className?: string;
}

/**
 * Tarjeta de paquete.
 *
 * Muestra el monto en bolívares en grande porque es lo que el cliente va a
 * transferir; el precio en dólares queda como referencia secundaria.
 */
export function ProductCard({ product, game, currencyIcon, className }: ProductCardProps) {
  const accent = game?.accentColor ?? '#F03030';
  const isManual = product.fulfillment === 'manual';
  const hasDiscount = product.compareAtUsd !== null && product.compareAtUsd > product.priceUsd;
  const soldOut = product.stock !== null && product.stock <= 0;

  const total = product.amount + product.bonus;

  return (
    <Link
      to={soldOut ? '#' : ROUTES.checkout(product.id)}
      onClick={(event) => soldOut && event.preventDefault()}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border bg-base-800 p-4 transition-all duration-200',
        soldOut
          ? 'cursor-not-allowed border-base-600 opacity-50'
          : 'border-base-600 hover:-translate-y-0.5 hover:border-white/20',
        className
      )}
      style={
        soldOut ? undefined : { boxShadow: `0 8px 32px -22px rgba(${hexToRgb(accent)}, 0.9)` }
      }
    >
      {(product.badge || product.featured) && (
        <span className="absolute right-0 top-3 flex flex-col items-end gap-1">
          {product.badge && (
            <span
              className="rounded-l-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
              style={{ backgroundColor: accent }}
            >
              {product.badge}
            </span>
          )}
          {product.featured && (
            <span className="flex items-center gap-0.5 rounded-l-full bg-amber-400 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-base-900">
              <Star className="h-2.5 w-2.5 fill-current" aria-hidden />
              Destacado
            </span>
          )}
        </span>
      )}

      <div className="flex items-start gap-3">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt=""
            className="h-11 w-11 shrink-0 rounded-xl object-cover"
            loading="lazy"
          />
        ) : (
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl"
            style={{ backgroundColor: `rgba(${hexToRgb(accent)}, 0.15)` }}
            aria-hidden
          >
            {game ? (
              <CurrencyIcon game={game} className="h-7 w-7 text-xl" />
            ) : (
              (currencyIcon ?? '🎮')
            )}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold leading-tight text-white">{product.name}</h3>
          {product.kind !== 'special' && product.bonus > 0 && (
            <p className="mt-0.5 text-xs text-slate-400">
              Total {total.toLocaleString('es-VE')} {game?.currencyLabel ?? ''}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-lg font-extrabold tabular text-white">
            {formatBs(product.priceBs)}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="tabular">{formatUsd(product.priceUsd)}</span>
            {hasDiscount && (
              <span className="tabular text-slate-500 line-through">
                {formatUsd(product.compareAtUsd ?? 0)}
              </span>
            )}
          </p>
        </div>

        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold',
            isManual
              ? 'bg-green-500/15 text-green-300'
              : 'bg-neon-red/15 text-neon-crimson'
          )}
        >
          {isManual ? (
            <>
              <MessageCircle className="h-3 w-3" aria-hidden />
              {product.manualFlow === 'whatsapp' ? 'WhatsApp' : 'Manual'}
            </>
          ) : (
            <>
              <Zap className="h-3 w-3" aria-hidden />
              Automático
            </>
          )}
        </span>
      </div>

      {soldOut ? (
        <p className="mt-3 text-center text-xs font-semibold text-red-400">Agotado</p>
      ) : (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-slate-500">
          <Clock className="h-3 w-3" aria-hidden />
          {isManual
            ? `Entrega en ~${product.deliveryEtaMinutes} min`
            : `Entrega en ~${product.deliveryEtaMinutes} min tras el pago`}
        </p>
      )}
    </Link>
  );
}
