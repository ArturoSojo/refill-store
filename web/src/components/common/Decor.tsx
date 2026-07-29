/** Piezas decorativas: fondo animado y números que cuentan hacia arriba. */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Fondo con rejilla HUD y dos orbes flotando.
 *
 * Todo es CSS: nada de canvas ni bucles de animación en JS, para no gastar
 * batería en móviles gama baja, que es donde se usa la tienda.
 */
export function AnimatedBackground({ className }: { className?: string }) {
  return (
    <div className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)} aria-hidden>
      <div className="absolute inset-0 bg-hud-grid opacity-60" />
      <div className="absolute -left-24 -top-24 h-72 w-72 animate-float rounded-full bg-neon-red/20 blur-3xl" />
      <div
        className="absolute -right-20 top-10 h-64 w-64 animate-float rounded-full bg-neon-blue/15 blur-3xl"
        style={{ animationDelay: '2.5s' }}
      />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-base to-transparent" />
    </div>
  );
}

interface CountUpProps {
  value: number;
  /** Milisegundos que dura la animación. */
  duration?: number;
  format?: (value: number) => string;
  className?: string;
}

/** Número que sube desde cero cuando entra en pantalla. */
export function CountUp({ value, duration = 900, format, className }: CountUpProps) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || started.current) return;
        started.current = true;

        const start = performance.now();
        const tick = (nowMs: number) => {
          const progress = Math.min((nowMs - start) / duration, 1);
          // easeOutCubic: arranca rápido y frena, que es lo que se siente bien.
          const eased = 1 - (1 - progress) ** 3;
          setDisplay(value * eased);
          if (progress < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [value, duration]);

  return (
    <span ref={ref} className={cn('tabular', className)}>
      {format ? format(display) : Math.round(display).toLocaleString('es-VE')}
    </span>
  );
}
