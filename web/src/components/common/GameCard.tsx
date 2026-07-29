import { Link } from 'react-router-dom';
import { ChevronRight, Zap } from 'lucide-react';
import { ROUTES, FALLBACK_ACCENT, FALLBACK_ACCENT_SECONDARY } from '@/lib/constants';
import { hexToRgb } from '@/lib/utils';
import type { Game } from '@/types/models';

interface GameCardProps {
  game: Game;
  productCount?: number;
  minPriceUsd?: number;
}

export function GameCard({ game, productCount, minPriceUsd }: GameCardProps) {
  const accent = game.accentColor || FALLBACK_ACCENT;
  const accentSecondary = game.accentColorSecondary || FALLBACK_ACCENT_SECONDARY;

  return (
    <Link
      to={ROUTES.game(game.id)}
      className="group relative block overflow-hidden rounded-2xl border border-base-600 bg-base-800 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/20"
      style={{ boxShadow: `0 10px 40px -20px rgba(${hexToRgb(accent)}, 0.6)` }}
    >
      {/* Fondo: la portada si existe, si no un degradado con el color del juego. */}
      <div
        className="relative h-32 sm:h-40"
        style={{
          background: game.coverUrl
            ? `url(${game.coverUrl}) center/cover`
            : `linear-gradient(135deg, ${accent} 0%, ${accentSecondary} 100%)`,
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-base-800 via-base-800/40 to-transparent" />

        {game.logoUrl && (
          <img
            src={game.logoUrl}
            alt=""
            className="absolute bottom-3 left-4 h-14 w-14 rounded-xl border border-white/20 object-cover shadow-lg"
            loading="lazy"
          />
        )}

        <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-black/50 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
          <Zap className="h-3 w-3" aria-hidden />
          Entrega inmediata
        </span>
      </div>

      <div className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-bold text-white">{game.name}</h3>
          <p className="mt-0.5 truncate text-sm text-slate-400">
            {productCount ? `${productCount} paquetes` : game.currencyLabel}
            {minPriceUsd !== undefined && minPriceUsd > 0 && (
              <span className="text-slate-500"> · desde ${minPriceUsd.toFixed(2)}</span>
            )}
          </p>
        </div>

        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:translate-x-0.5"
          style={{ backgroundColor: `rgba(${hexToRgb(accent)}, 0.18)`, color: accent }}
        >
          <ChevronRight className="h-5 w-5" aria-hidden />
        </span>
      </div>
    </Link>
  );
}
