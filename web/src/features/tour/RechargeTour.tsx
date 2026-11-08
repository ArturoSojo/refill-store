/**
 * Motor del tutorial interactivo «Te acompaño mientras recargas».
 *
 * - `RechargeTourProvider` mantiene el estado entre inicio, juego y checkout.
 * - El overlay recorta un hueco (box-shadow) sobre el elemento con
 *   `data-tour`, que sigue siendo clicable y escribible, con un indicador
 *   visual limpio y un HUD compacto que nunca tapa lo que el cliente debe tocar.
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
/** Margen lateral seguro para que el anillo nunca se pegue ni se corte en bordes móviles. */
const SAFE_EDGE_X = 6;
/** Tiempo que se espera a un elemento opcional antes de saltar el paso. */
const OPTIONAL_WAIT_MS = 1500;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PlayerTourState {
  game: string | null;
  hasPlayerId: boolean;
  idValid: boolean;
  isVerifying: boolean;
  isVerified: boolean;
  verifiedNickname: string | null;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b ||
  (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

const samePlayerState = (a: PlayerTourState, b: PlayerTourState) =>
  a.game === b.game &&
  a.hasPlayerId === b.hasPlayerId &&
  a.idValid === b.idValid &&
  a.isVerifying === b.isVerifying &&
  a.isVerified === b.isVerified &&
  a.verifiedNickname === b.verifiedNickname;

function findTarget(name?: string): HTMLElement | null {
  if (!name) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? el : null;
}

function readPlayerTourState(): PlayerTourState {
  const idBox = document.querySelector<HTMLElement>('[data-tour="player-id-input"]');
  const game = idBox?.dataset.tourGame ?? null;
  const hasPlayerId = Boolean(idBox);
  const idValid = idBox?.dataset.tourIdValid === 'true';
  const isVerifying = idBox?.dataset.tourVerifying === 'true';
  const verifiedNickname = idBox?.dataset.tourNickname || null;
  const isVerified =
    idBox?.dataset.tourVerified === 'true' ||
    Boolean(verifiedNickname) ||
    Boolean(findTarget('verified-player-badge'));

  return {
    game,
    hasPlayerId,
    idValid,
    isVerifying,
    isVerified,
    verifiedNickname,
  };
}

function resolvePostVerificationStepIndex(): number {
  return findTarget('verified-player-badge') ? stepIndex('verified-badge') : stepIndex('package');
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
      const currentStep = TOUR_STEPS[current];
      if (!currentStep) return current;

      // Si el usuario verificó su ID (ya sea desde "Escribe aquí tu ID" o "Ahora toca Verificar ID"),
      // salta automáticamente el paso de "Ahora toca Verificar ID" y pasa a cuenta verificada o recarga.
      if (event === 'id-verified' && (currentStep.id === 'player-id' || currentStep.id === 'verify-id')) {
        direction.current = 1;
        return resolvePostVerificationStepIndex();
      }

      if (currentStep.advanceOn !== event) return current;
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

  const cardRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [viewportTop, setViewportTop] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  // Datos reactivos de la pantalla de compra para adaptar textos y saltar pasos redundantes.
  const [pageInfo, setPageInfo] = useState<PlayerTourState>(() => readPlayerTourState());

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

      const nextPlayerState = readPlayerTourState();
      setPageInfo((prev) => (samePlayerState(prev, nextPlayerState) ? prev : nextPlayerState));

      if (el) {
        missingSince.current = null;
        const rect = el.getBoundingClientRect();

        if (scrolledFor.current !== index) {
          scrolledFor.current = index;
          const visibleHeight = vv?.height ?? window.innerHeight;
          const hudHeight = cardRef.current?.offsetHeight ?? 108;
          const topOffset = hudHeight + 24;
          const bottomSafe = 88;
          const availableHeight = Math.max(120, visibleHeight - topOffset - bottomSafe);

          // Ajustamos scrollMarginTop para que scrollIntoView respete la altura del HUD.
          el.style.scrollMarginTop = `${topOffset}px`;
          el.style.scrollMarginBottom = `${bottomSafe}px`;

          const isFixedTarget = window.getComputedStyle(el).position === 'fixed';
          if (!isFixedTarget) {
            // Primero ejecutamos scrollIntoView suave centrado como base.
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Si el contenedor es una grilla alta (ej. paquetes o catálogo) o al centrarse
            // su encabezado queda por encima de `topOffset` (debajo del HUD), corregimos
            // con el offset superior exacto para que las pestañas y primeros ítems queden visibles.
            const centeredTop = (visibleHeight - rect.height) / 2;
            if (rect.height > availableHeight || centeredTop < topOffset) {
              const targetScrollY = Math.max(0, window.scrollY + rect.top - topOffset);
              window.scrollTo({ top: targetScrollY, behavior: 'smooth' });
            }
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

  // Máquina de estados inteligente para la validación de ID (`CUENTA`):
  // 1) Si el usuario cae en `verify-id` ("Ahora toca Verificar ID") pero el ID ya está verificado
  //    (o tiene nickname verificado), salta automáticamente ese paso.
  // 2) Si está en `player-id` ("Escribe aquí tu ID") y ya tiene un ID válido + completó la verificación,
  //    avanza automáticamente tras 800ms saltando `verify-id`.
  useEffect(() => {
    if (step.id === 'verify-id' && pageInfo.idValid && (pageInfo.isVerified || Boolean(pageInfo.verifiedNickname))) {
      if (direction.current === -1) {
        direction.current = -1;
        goTo(stepIndex('player-id'));
      } else {
        goTo(resolvePostVerificationStepIndex());
      }
      return undefined;
    }

    if (step.id === 'player-id' && pageInfo.idValid && (pageInfo.isVerified || Boolean(pageInfo.verifiedNickname))) {
      const timer = window.setTimeout(() => {
        goTo(resolvePostVerificationStepIndex());
      }, 800);
      return () => window.clearTimeout(timer);
    }

    return undefined;
  }, [step.id, pageInfo.idValid, pageInfo.isVerified, pageInfo.verifiedNickname, direction, goTo]);

  const previous = TOUR_STEPS[index - 1];
  const canGoBack = Boolean(previous) && (previous!.route === 'any' || previous!.route === step.route);

  // Nunca se fuerza un juego: desde el inicio se ilumina el catálogo y desde
  // un juego, su selector, para que el cliente elija lo que quiere comprar.
  const goToStart = () => {
    goTo(stepIndex(location.pathname.startsWith('/juego/') ? 'game-select' : 'catalog'));
  };

  const onBack = () => {
    // Si ya está verificado y retrocede desde `verified-badge`, vuelve a `player-id` sin pasar por `verify-id`.
    if (step.id === 'verified-badge' && (pageInfo.isVerified || Boolean(pageInfo.verifiedNickname))) {
      direction.current = -1;
      goTo(stepIndex('player-id'));
      return;
    }
    back();
  };

  const onPrimary = () => {
    if (
      step.id === 'player-id' &&
      pageInfo.idValid &&
      (pageInfo.isVerified || Boolean(pageInfo.verifiedNickname) || pageInfo.isVerifying)
    ) {
      goTo(resolvePostVerificationStepIndex());
      return;
    }

    switch (step.primaryAction) {
      case 'goStart':
        goToStart();
        break;
      case 'verify': {
        if (pageInfo.isVerified || Boolean(pageInfo.verifiedNickname) || findTarget('verified-player-badge')) {
          goTo(resolvePostVerificationStepIndex());
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
    text = 'Elige el monto o paquete que quieres comprar. Puedes sumar unidades con [+].';
  }

  if (dialogOpen) return null;

  // El HUD compacto vive arriba por defecto para no chocar con la barra de pago ni navegación
  // inferior, salvo que el elemento resaltado quede pegado al borde superior sin margen.
  const hudEstimatedHeight = cardRef.current?.offsetHeight ?? 108;
  const overlapsTopHud = box ? box.top < hudEstimatedHeight + 14 && box.top + box.height < viewportHeight * 0.65 : false;
  const cardOnTop = keyboardOpen || step.forceTop || !overlapsTopHud;

  const hole = useMemo(() => {
    if (!box) return null;
    const screenWidth = window.innerWidth;
    const left = Math.max(SAFE_EDGE_X, box.left - PAD);
    const right = Math.min(screenWidth - SAFE_EDGE_X, box.left + box.width + PAD);
    const width = Math.max(0, right - left);
    const top = box.top - PAD;
    const height = box.height + PAD * 2;
    return { top, left, width, height };
  }, [box]);

  const blockers = useMemo(() => {
    if (!hole) return [];
    const screenHeight = window.innerHeight;
    const topHeight = Math.max(0, hole.top);
    const middleTop = Math.max(0, hole.top);
    const middleBottom = Math.min(screenHeight, hole.top + hole.height);
    const middleHeight = Math.max(0, middleBottom - middleTop);
    const bottomTop = Math.max(0, Math.min(screenHeight, hole.top + hole.height));

    return [
      { top: 0, left: 0, right: 0, height: topHeight },
      { top: bottomTop, left: 0, right: 0, bottom: 0 },
      { top: middleTop, left: 0, width: hole.left, height: middleHeight },
      { top: middleTop, left: hole.left + hole.width, right: 0, height: middleHeight },
    ];
  }, [hole]);

  return (
    <>
      {hole ? (
        <>
          {/* Bloquean todo menos el hueco activo, para que el cliente interactúe directo con él. */}
          {blockers.map((style, i) => (
            <div key={i} className="fixed z-[9990]" style={style} aria-hidden />
          ))}
          <div
            className="pointer-events-none fixed z-[9991] rounded-2xl ring-2 ring-rose-500/80 transition-all duration-150"
            style={{
              ...hole,
              boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.72), 0 0 20px rgba(244, 63, 94, 0.25)',
            }}
            aria-hidden
          >
            {/* Pulso sutil en el borde del contenedor activo en lugar del emoji gigante */}
            <span className="absolute -top-2.5 right-3 inline-flex items-center gap-1.5 rounded-full border border-rose-400/50 bg-rose-600/95 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-[0_0_12px_rgba(244,63,94,0.6)]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-80" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              Aquí
            </span>
          </div>
        </>
      ) : (
        <div className="fixed inset-0 z-[9990] bg-black/70" aria-hidden />
      )}

      <div
        ref={cardRef}
        role="region"
        aria-label="Guía para recargar"
        className={cn(
          'fixed inset-x-3 z-[9999] mx-auto max-w-md rounded-2xl border border-rose-500/40 bg-zinc-950/95 p-3 shadow-2xl backdrop-blur-md sm:p-4',
          !cardOnTop && 'bottom-20 sm:bottom-4'
        )}
        style={cardOnTop ? { top: viewportTop + 8 } : undefined}
      >
        {/* Fila superior compacta: Etiqueta del paso + Contador y barra fina de progreso + Botón Salir */}
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-[11px] font-bold uppercase tracking-wider text-neon-crimson">
              {step.category}
            </span>
            <span
              className="shrink-0 text-[11px] font-semibold tabular text-zinc-400"
              aria-label={`Paso ${index + 1} de ${TOUR_STEPS.length}`}
            >
              {index + 1}/{TOUR_STEPS.length}
            </span>
            <div className="h-1 max-w-[68px] flex-1 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
              <div
                className="h-full rounded-full bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.85)] transition-all duration-300"
                style={{ width: `${((index + 1) / TOUR_STEPS.length) * 100}%` }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => stop(false)}
            className="shrink-0 rounded-lg px-2 py-0.5 text-xs font-semibold text-zinc-400 transition hover:bg-zinc-800 hover:text-white"
          >
            ✕ Salir
          </button>
        </div>

        <h3 className="text-sm font-bold leading-snug text-white sm:text-base">{title}</h3>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-zinc-300 sm:mt-1 sm:line-clamp-none sm:text-sm">
          {step.target && !box && !step.optional
            ? 'Preparando esta pantalla… un momento.'
            : text}
        </p>

        {/* Botones compactos en la esquina inferior derecha */}
        <div className="mt-2 flex items-center justify-end gap-1.5">
          {canGoBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800 hover:text-white"
            >
              {'< Atrás'}
            </button>
          )}
          {!step.hidePrimary && (
            <button
              type="button"
              onClick={onPrimary}
              className="rounded-lg bg-brand-gradient px-3 py-1.5 text-xs font-bold text-white shadow-glow transition hover:brightness-110 active:scale-[0.98]"
            >
              {step.primaryLabel}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
