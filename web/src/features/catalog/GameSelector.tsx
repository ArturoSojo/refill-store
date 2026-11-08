/**
 * Selector horizontal de juegos.
 *
 * Sigue el patrón de las tiendas de recargas: una fila deslizable con la
 * portada de cada juego y la seleccionada con halo del color del propio juego.
 * Cambiar de juego no obliga a volver atrás, que es lo que rompía el flujo
 * cuando cada juego vivía en su propia página.
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, ChevronLeft, ChevronRight, Globe, Loader2, MapPin } from 'lucide-react';
import { CurrencyIcon } from '@/components/common/CurrencyIcon';
import { hexToRgb } from '@/lib/utils';
import { resolveRegionInfo, cleanGameTitle } from '@/lib/regions';
import type { Game } from '@/types/models';

interface GameSelectorProps {
  games: Game[];
  selectedId: string;
  onSelect: (gameId: string) => void;
  onEnd?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

export function GameSelector({ games, selectedId, onSelect, onEnd, hasMore = false, isLoadingMore = false }: GameSelectorProps) {
  const selectedRef = useRef<HTMLLIElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const updateScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const remaining = scroller.scrollWidth - scroller.scrollLeft - scroller.clientWidth;
    setAtStart(scroller.scrollLeft <= 4);
    setAtEnd(remaining <= 4);
    if (remaining < 160 && hasMore && !isLoadingMore) onEndRef.current?.();
  };

  const advance = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const remaining = scroller.scrollWidth - scroller.scrollLeft - scroller.clientWidth;
    if (direction === 1 && remaining < 160 && hasMore) onEndRef.current?.();
    scroller.scrollBy({ left: direction * Math.max(160, scroller.clientWidth * 0.7), behavior: 'smooth' });
  };

  // Al entrar por enlace directo a un juego, su tarjeta puede quedar fuera de
  // la vista en móvil. Se trae al centro para que se vea cuál está elegido.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [selectedId]);

  useEffect(() => {
    const frame = requestAnimationFrame(updateScroll);
    return () => cancelAnimationFrame(frame);
    // El tamaño de la fila y el estado de carga son las causas de esta medición.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games.length, hasMore, isLoadingMore]);

  return (
    <div className="relative -mx-4 px-4">
      <div ref={scrollerRef} onScroll={updateScroll} className="overflow-x-auto scroll-smooth pb-1 no-scrollbar" aria-label="Juegos disponibles">
      <ul className="flex w-max gap-3 pr-12">
        {games.map((game, index) => {
          const selected = game.id === selectedId;
          const accent = game.accentColor || '#F03030';
          const accentSecondary = game.accentColorSecondary || '#3018F0';
          const regionInfo = resolveRegionInfo(game.regionCode || game.region, game.name, game.shortName);

          return (
            <motion.li
              key={game.id}
              ref={selected ? selectedRef : undefined}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05, duration: 0.3 }}
            >
              <button
                type="button"
                onClick={() => onSelect(game.id)}
                data-selected={selected}
                aria-pressed={selected}
                className="neon-card sheen group w-[124px] p-2 text-left sm:w-[148px]"
                style={
                  {
                    '--accent': accent,
                    '--accent-soft': `rgba(${hexToRgb(accent)}, 0.3)`,
                  } as React.CSSProperties
                }
              >
                <div
                  className="relative aspect-square w-full overflow-hidden rounded-xl"
                  style={{
                    background: game.logoUrl
                      ? `url(${game.logoUrl}) center/cover`
                      : `linear-gradient(145deg, ${accent} 0%, ${accentSecondary} 100%)`,
                  }}
                >
                  {/* Badge de Región en el carrusel */}
                  <span
                    className={`absolute left-1.5 top-1.5 z-10 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-extrabold shadow-md backdrop-blur border ${
                      regionInfo.isRegionRestricted
                        ? 'bg-amber-950/95 text-amber-300 border-amber-500/50'
                        : 'bg-emerald-950/90 text-emerald-300 border-emerald-500/40'
                    }`}
                  >
                    {regionInfo.isRegionRestricted ? (
                      <MapPin className="h-2 w-2 shrink-0 text-amber-400" aria-hidden />
                    ) : (
                      <Globe className="h-2 w-2 shrink-0 text-emerald-400" aria-hidden />
                    )}
                    <span>{regionInfo.regionBadge}</span>
                  </span>

                  {!game.logoUrl && (
                    <span
                      className="absolute inset-0 flex items-center justify-center text-4xl drop-shadow-lg"
                      aria-hidden
                    >
                      <CurrencyIcon game={game} className="h-11 w-11 text-4xl" />
                    </span>
                  )}

                  {selected && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', damping: 14, stiffness: 400 }}
                      className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-white text-black shadow-lg"
                    >
                      <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                    </motion.span>
                  )}
                </div>

                <p
                  className={`mt-2 line-clamp-2 min-h-[2rem] leading-tight px-0.5 text-xs font-bold transition-colors ${
                    selected ? 'text-white font-black' : 'text-slate-300 group-hover:text-white'
                  }`}
                  style={{ color: selected ? '#ffffff' : undefined }}
                  title={cleanGameTitle(game.name)}
                >
                  {cleanGameTitle(game.name)}
                </p>
              </button>
            </motion.li>
          );
        })}
      </ul>
      </div>
      <button type="button" onClick={() => advance(-1)} disabled={atStart}
        aria-label="Ver juegos anteriores"
        className="absolute left-1 top-14 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-base-500 bg-base-900/90 text-white shadow-lg backdrop-blur transition hover:border-neon-red disabled:opacity-0">
        <ChevronLeft className="h-5 w-5" aria-hidden />
      </button>
      <button type="button" onClick={() => advance(1)} disabled={atEnd && !hasMore}
        aria-label="Ver más juegos"
        className="absolute right-1 top-14 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-base-500 bg-base-900/90 text-white shadow-lg backdrop-blur transition hover:border-neon-red disabled:opacity-0">
        {isLoadingMore ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <ChevronRight className="h-5 w-5" aria-hidden />}
      </button>
    </div>
  );
}
