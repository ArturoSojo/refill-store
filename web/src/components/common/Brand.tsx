/**
 * Piezas de marca.
 *
 * El emblema y el rótulo se generan desde el arte de `assets-src/` con
 * `npm run brand`, y llegan con canal alfa real: se pintan directamente sobre
 * cualquier superficie sin recortes ni modos de mezcla.
 *
 * El halo se pinta con un pseudo-hermano difuminado detrás del emblema. Es un
 * `<span>` aparte y no un `filter: drop-shadow` sobre la imagen porque el
 * drop-shadow sigue el contorno exacto del trazo neón —que es fino— y produce
 * un resplandor sucio en vez de un halo suave.
 */
import { cn } from '@/lib/utils';

interface BrandMarkProps {
  /** Lado del cuadrado en píxeles. */
  size?: number;
  className?: string;
  glow?: boolean;
}

export function BrandMark({ size = 36, className, glow = true }: BrandMarkProps) {
  // El emblema tiene trazos finos: por debajo de ~48 px conviene servir el
  // archivo pequeño, y por encima el de 256 para que no se pixele.
  const asset = size <= 48 ? 128 : size <= 160 ? 256 : 512;

  return (
    <span
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      {glow && (
        <span
          className="pointer-events-none absolute inset-1 rounded-full bg-neon-red/35 blur-lg"
          aria-hidden
        />
      )}
      <picture>
        <source srcSet={`/brand/emblem-${asset}.webp`} type="image/webp" />
        <img
          src={`/brand/emblem-${asset}.png`}
          alt=""
          width={size}
          height={size}
          className="relative h-full w-full object-contain"
          loading="eager"
          decoding="async"
        />
      </picture>
    </span>
  );
}

interface BrandLockupProps {
  /** Ancho en píxeles. */
  width?: number;
  className?: string;
}

/** Emblema + rótulo «REFILL STORE», en vertical. */
export function BrandLockup({ width = 200, className }: BrandLockupProps) {
  return (
    <span className={cn('relative inline-block', className)} style={{ width }}>
      <picture>
        <source
          srcSet="/brand/wordmark-320.webp 320w, /brand/wordmark-640.webp 640w"
          sizes={`${width}px`}
          type="image/webp"
        />
        <img
          src="/brand/wordmark-320.png"
          srcSet="/brand/wordmark-320.png 320w, /brand/wordmark-640.png 640w"
          sizes={`${width}px`}
          alt="Refill Store"
          className="block h-auto w-full"
          loading="lazy"
          decoding="async"
        />
      </picture>
    </span>
  );
}

/**
 * Arte de fondo del hero: el banner completo de la marca.
 *
 * Dos decisiones de encuadre:
 *
 *  - `object-top` recorta la franja inferior, donde el arte lleva rotulado
 *    «REFILL STORE». Sin ese recorte el nombre aparecería dos veces en la misma
 *    pantalla —una en la cabecera y otra detrás del titular—.
 *  - El eje horizontal se fija en 62 %, que es donde queda el personaje. En
 *    escritorio da igual (el ancho manda y se ve la imagen completa), pero en
 *    móvil, donde el alto manda y sobra ancho, es lo que evita que el recorte
 *    se coma la cara.
 */
export function HeroArt({ className }: { className?: string }) {
  return (
    <div
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      aria-hidden
    >
      <picture>
        <source
          srcSet="/brand/hero-800.webp 800w, /brand/hero-1200.webp 1200w, /brand/hero-1920.webp 1920w"
          sizes="100vw"
          type="image/webp"
        />
        <img
          src="/brand/hero-1600.jpg"
          alt=""
          className="h-full w-full object-cover object-[62%_top] opacity-70 sm:opacity-95"
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      </picture>

      {/* Velo lateral: da contraste al titular sin apagar al personaje. */}
      <div className="absolute inset-0 bg-gradient-to-r from-base via-base/80 to-base/10 sm:via-base/55 sm:to-transparent" />
      {/* Difuminado inferior: remata el recorte y funde el arte con la página. */}
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-base via-base/80 to-transparent" />
    </div>
  );
}
