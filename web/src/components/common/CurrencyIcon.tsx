/**
 * Ícono de la moneda de un juego.
 *
 * Los juegos traen una imagen (`currencyIconUrl`) y, como respaldo, el emoji de
 * siempre. El emoji se veía genérico —el mismo 🪙 para el Gold de Blood Strike
 * y para los Tokens de Honor of Kings—, así que la imagen manda cuando existe;
 * si falla al cargar (URL rota puesta desde el panel) se vuelve al emoji en vez
 * de dejar un hueco.
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Game } from '@/types/models';

interface CurrencyIconProps {
  game: Pick<Game, 'currencyIcon' | 'currencyIconUrl' | 'currencyLabel'>;
  /** Clases de tamaño; por defecto un cuadrado de 1.5rem. */
  className?: string;
}

export function CurrencyIcon({ game, className }: CurrencyIconProps) {
  const [failed, setFailed] = useState(false);
  const url = game.currencyIconUrl?.trim();

  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        loading="lazy"
        onError={() => setFailed(true)}
        className={cn('h-6 w-6 shrink-0 object-contain', className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center leading-none', className)}
    >
      {game.currencyIcon || '🎮'}
    </span>
  );
}
