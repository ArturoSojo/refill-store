/**
 * Selector horizontal de juegos.
 *
 * Sigue el patrón de las tiendas de recargas: una fila deslizable con la
 * portada de cada juego y la seleccionada con halo del color del propio juego.
 * Cambiar de juego no obliga a volver atrás, que es lo que rompía el flujo
 * cuando cada juego vivía en su propia página.
 */
import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { hexToRgb } from '@/lib/utils';
import type { Game } from '@/types/models';

interface GameSelectorProps {
  games: Game[];
  selectedId: string;
  onSelect: (gameId: string) => void;
}

export function GameSelector({ games, selectedId, onSelect }: GameSelectorProps) {
  const selectedRef = useRef<HTMLLIElement>(null);

  // Al entrar por enlace directo a un juego, su tarjeta puede quedar fuera de
  // la vista en móvil. Se trae al centro para que se vea cuál está elegido.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [selectedId]);

  return (
    <div className="-mx-4 overflow-x-auto px-4 no-scrollbar">
      <ul className="flex w-max gap-3 pb-1">
        {games.map((game, index) => {
          const selected = game.id === selectedId;
          const accent = game.accentColor || '#F03030';
          const accentSecondary = game.accentColorSecondary || '#3018F0';

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
                  {!game.logoUrl && (
                    <span
                      className="absolute inset-0 flex items-center justify-center text-4xl drop-shadow-lg"
                      aria-hidden
                    >
                      {game.currencyIcon || '🎮'}
                    </span>
                  )}

                  {selected && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', damping: 14, stiffness: 400 }}
                      className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-white text-black shadow-lg"
                    >
                      <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                    </motion.span>
                  )}
                </div>

                <p
                  className={`mt-2 truncate px-0.5 text-xs font-bold transition-colors ${
                    selected ? 'text-white' : 'text-slate-400 group-hover:text-slate-200'
                  }`}
                >
                  {game.name}
                </p>
              </button>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}
