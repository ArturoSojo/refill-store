/**
 * Motor del tutorial interactivo «Te acompaño mientras recargas».
 *
 * - `RechargeTourProvider` mantiene el estado entre inicio, juego y checkout.
 * - El overlay recorta un hueco (box-shadow) sobre el elemento con
 *   `data-tour`, que sigue siendo clicable y escribible, y coloca una mano
 *   animada y una tarjeta que nunca tapa lo que el cliente debe tocar.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  RechargeTourContext,
  TOUR_STEPS,
  useRechargeTour,
  TOUR_STORAGE_KEY,
  stepIndex,
  type RechargeTourContextValue,
  type TourEvent,
} from './useRechargeTour';

/** Margen entre el borde resaltado y el elemento. */
const PAD = 6;
/** Tiempo que se espera a un elemento opcional antes de saltar el paso. */
const OPTIONAL_WAIT_MS = 1500;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b ||
  (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

function findTarget(name?: string): HTMLElement | null {
  if (!name) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? el : null;
}

function tourIsAllowedAt(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/familia/') ||
    pathname.startsWith('/juego/') ||
    pathname.startsWith('/comprar/')
  );
}

export function RechargeTourProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);
  /** Sentido del último movimiento: decide hacia dónde saltar pasos opcionales. */
  const direction = useRef<1 | -1>(1);

  const start = useCallback((from = 0) => {
    direction.current = 1;
    setIndex(Math.max(0, Math.min(from, TOUR_STEPS.length - 1)));
    setActive(true);
  }, []);

  const stop = useCallback((completed = false) => {
    setActive(false);
    if (completed) {
      try {
        localStorage.setItem(TOUR_STORAGE_KEY, '1');
      } catch {
        /* sin almacenamiento: no pasa nada */
      }
    }
  }, []);

  const next = useCallback(() => {
    direction.current = 1;
    setIndex((current) => current + 1);
  }, []);

  const back = useCallback(() => {
    direction.current = -1;
    setIndex((current) => Math.max(0, current - 1));
  }, []);

  const goTo = useCallback((target: number) => {
    direction.current = 1;
    setIndex(target);
  }, []);

  const notify = useCallback((event: TourEvent) => {
    setIndex((current) => {
      if (TOUR_STEPS[current]?.advanceOn !== event) return current;
      direction.current = 1;
      return current + 1;
    });
  }, []);

  // Pasado el último paso, la guía termina sola y se recuerda.
  useEffect(() => {
    if (active && index >= TOUR_STEPS.length) stop(true);
  }, [active, index, stop]);

  // Fuera de la tienda de compra (cuenta, admin…) la guía no tiene sentido.
  useEffect(() => {
    if (active && !tourIsAllowedAt(location.pathname)) setActive(false);
  }, [active, location.pathname]);

  // Al elegir un juego o gift card en el catálogo, la guía salta a los pasos de
  // ese producto (el selector de juego ya no hace falta).
  useEffect(() => {
    if (!active || TOUR_STEPS[index]?.id !== 'catalog') return;
    if (location.pathname.startsWith('/juego/')) goTo(stepIndex('player-id'));
  }, [active, index, location.pathname, goTo]);

  const value = useMemo<RechargeTourContextValue>(
    () => ({ active, index, start, stop, next, back, goTo, notify }),
    [active, index, start, stop, next, back, goTo, notify]
  );

  const step = TOUR_STEPS[index];

  return (
    <RechargeTourContext.Provider value={value}>
      {children}
      {active && step && createPortal(<TourOverlay direction={direction} />, document.body)}
    </RechargeTourContext.Provider>
  );
}

function TourOverlay({ direction }: { direction: { current: 1 | -1 } }) {
  const { index, next, back, goTo, stop } = useRechargeTour();
  const location = useLocation();
  const step = TOUR_STEPS[index]!;

  const [box, setBox] = useState<Box | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [viewportTop, setViewportTop] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  // Datos de la pantalla de compra para adaptar los textos al producto elegido.
  const [pageInfo, setPageInfo] = useState<{ game: string | null; hasPlayerId: boolean }>({
    game: null,
    hasPlayerId: false,
  });

  const scrolledFor = useRef<number | null>(null);
  const missingSince = useRef<number | null>(null);

  // Sigue al elemento en cada fotograma: cubre scroll, resize, animaciones,
  // cambios del DOM y el teclado del móvil (`visualViewport`) sin depender de
  // que cada uno dispare su propio evento.
  useEffect(() => {
    scrolledFor.current = null;
    missingSince.current = null;
    let frame = 0;

    const tick = () => {
      const el = findTarget(step.target);
      const vv = window.visualViewport;

      setDialogOpen(Boolean(document.querySelector('[role="dialog"]')));
      setKeyboardOpen(Boolean(vv && vv.height < window.innerHeight * 0.75));
      setViewportTop(vv?.offsetTop ?? 0);
      setViewportHeight(vv?.height ?? window.innerHeight);
      const idBox = document.querySelector<HTMLElement>('[data-tour="player-id-input"]');
      const game = idBox?.dataset.tourGame ?? null;
      const hasPlayerId = Boolean(idBox);
      setPageInfo((prev) => (prev.game === game && prev.hasPlayerId === hasPlayerId ? prev : { game, hasPlayerId }));

      if (el) {
        missingSince.current = null;
        const rect = el.getBoundingClientRect();

        if (scrolledFor.current !== index) {
          scrolledFor.current = index;
          const visibleHeight = vv?.height ?? window.innerHeight;
          if (rect.top < 70 || rect.bottom > visibleHeight - 20) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }

        const nextBox = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
        setBox((prev) => (sameBox(prev, nextBox) ? prev : nextBox));
      } else {
        setBox((prev) => (prev ? null : prev));
        if (step.target && step.optional) {
          const now = performance.now();
          missingSince.current ??= now;
          if (now - missingSince.current > (step.optionalWaitMs ?? OPTIONAL_WAIT_MS)) {
            missingSince.current = null;
            if (direction.current === 1) next();
            else if (index > 0) back();
          }
        }
      }

      frame = requestAnimationFrame(tick);
    };

    tick();
    return () => cancelAnimationFrame(frame);
  }, [index, step.target, step.optional, step.optionalWaitMs, direction, next, back]);

  const previous = TOUR_STEPS[index - 1];
  const canGoBack = Boolean(previous) && (previous!.route === 'any' || previous!.route === step.route);

  // Nunca se fuerza un juego: desde el inicio se ilumina el catálogo y desde
  // un juego, su selector, para que el cliente elija lo que quiere comprar.
  const goToStart = () => {
    goTo(stepIndex(location.pathname.startsWith('/juego/') ? 'game-select' : 'catalog'));
  };

  const onPrimary = () => {
    switch (step.primaryAction) {
      case 'goStart':
        goToStart();
        break;
      case 'verify': {
        if (findTarget('verified-player-badge')) {
          next();
          break;
        }
        const button = document.querySelector<HTMLButtonElement>('[data-tour="verify-id-button"] button');
        if (button && !button.disabled) {
          button.click();
        } else {
          document.querySelector<HTMLInputElement>('[data-tour="player-id-input"] input')?.focus();
        }
        break;
      }
      case 'continue':
        // Si el botón está deshabilitado (falta ID o paquete) no pasa nada y
        // la propia barra explica por qué.
        document.querySelector<HTMLButtonElement>('[data-tour-action="continue"]')?.click();
        break;
      case 'focusReference':
        document.querySelector<HTMLInputElement>('[data-tour="payment-reference-form"] input')?.focus();
        break;
      case 'finish':
        stop(true);
        break;
      default:
        next();
    }
  };

  // Textos que se adaptan al producto elegido (nunca un juego fijo).
  let title = step.title;
  let text = step.text;
  if (step.id === 'player-id' && pageInfo.game) {
    title = `Escribe aquí tu ID de ${pageInfo.game}`;
  } else if (step.id === 'package' && !pageInfo.hasPlayerId) {
    text = 'Elige el monto o paquete que quieres comprar. Si quieres varias unidades puedes sumar con [+].';
  }

  if (dialogOpen) return null;

  // Elemento en la mitad superior → tarjeta abajo; en la inferior, con teclado
  // abierto o si el paso lo pide → tarjeta arriba.
  const elementIsLow = box ? box.top + box.height / 2 > viewportHeight / 2 : false;
  const cardOnTop = keyboardOpen || step.forceTop || elementIsLow;

  const hole = box
    ? {
        top: Math.max(0, box.top - PAD),
        left: Math.max(0, box.left - PAD),
        width: box.width + PAD * 2,
        height: box.height + PAD * 2,
      }
    : null;

  // La mano apunta al borde del elemento por el lado que queda libre.
  const handBelow = hole ? !elementIsLow : false;
  const handTop = hole
    ? Math.min(
        Math.max(handBelow ? hole.top + hole.height + 2 : hole.top - 48, 8),
        viewportHeight - 52
      )
    : 0;
  const handLeft = hole
    ? Math.min(Math.max(hole.left + hole.width / 2 - 18, 8), window.innerWidth - 48)
    : 0;

  const blockers = hole
    ? [
        { top: 0, left: 0, right: 0, height: hole.top },
        { top: hole.top + hole.height, left: 0, right: 0, bottom: 0 },
        { top: hole.top, left: 0, width: hole.left, height: hole.height },
        { top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height },
      ]
    : [];

  return (
    <>
      {hole ? (
        <>
          {/* Bloquean todo menos el hueco, para que el cliente no se pierda. */}
          {blockers.map((style, i) => (
            <div key={i} className="fixed z-[9990]" style={style} aria-hidden />
          ))}
          <div
            className="pointer-events-none fixed z-[9991] rounded-2xl border-2 border-neon-red"
            style={{
              ...hole,
              boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.78), 0 0 28px rgba(240, 48, 48, 0.5)',
            }}
            aria-hidden
          />
          <div
            className="pointer-events-none fixed z-[9992]"
            style={{ top: handTop, left: handLeft }}
            aria-hidden
          >
            <span className="block animate-bounce text-4xl leading-none drop-shadow-lg">
              {handBelow ? '👆' : '👇'}
            </span>
          </div>
        </>
      ) : (
        <div className="fixed inset-0 z-[9990] bg-black/70" aria-hidden />
      )}

      <div
        role="region"
        aria-label="Guía para recargar"
        className={cn(
          'fixed inset-x-3 z-[9999] mx-auto max-w-md rounded-2xl border border-neon-red/40 bg-base-900/95 p-4 shadow-2xl backdrop-blur-md',
          !cardOnTop && 'bottom-4'
        )}
        style={cardOnTop ? { top: viewportTop + 12 } : undefined}
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-xs font-bold uppercase tracking-wider text-neon-crimson">
              {step.category}
            </span>
            <span className="flex items-center gap-1" aria-label={`Paso ${index + 1} de ${TOUR_STEPS.length}`}>
              {TOUR_STEPS.map((item, i) => (
                <span
                  key={item.id}
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    i === index ? 'bg-neon-red shadow-[0_0_6px_rgba(240,48,48,0.9)]' : 'bg-slate-600'
                  )}
                />
              ))}
            </span>
          </div>
          <button
            type="button"
            onClick={() => stop(false)}
            className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            ✕ Salir
          </button>
        </div>

        <h3 className="text-base font-bold text-white">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-300">
          {step.target && !box && !step.optional
            ? 'Preparando esta pantalla… un momento.'
            : text}
        </p>

        <div className="mt-3 flex items-center justify-between gap-2">
          {canGoBack ? (
            <button
              type="button"
              onClick={back}
              className="rounded-xl px-3 py-2 text-sm font-semibold text-slate-300 transition hover:bg-slate-800 hover:text-white"
            >
              {'< Atrás'}
            </button>
          ) : (
            <span />
          )}
          {!step.hidePrimary && <button
            type="button"
            onClick={onPrimary}
            className="rounded-xl bg-brand-gradient px-4 py-2 text-sm font-bold text-white shadow-glow transition hover:brightness-110 active:scale-[0.98]"
          >
            {step.primaryLabel}
          </button>}
        </div>
      </div>
    </>
  );
}
