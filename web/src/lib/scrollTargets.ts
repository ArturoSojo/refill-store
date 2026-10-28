import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export const CUSTOM_SCROLL_OPTION = '__custom__';

export interface ScrollWireframeMeta {
  pageTitle: string;
  parentCard?: string;
  targetTitle: string;
  targetSubtitle: string;
  targetHint?: string;
  isInput?: boolean;
}

export interface ScrollTargetPreset {
  id: string;
  optionLabel: string;
  shortLabel: string;
  journeyLabel: string;
  suggestedRoute: string;
  autoFocus: boolean;
  wireframe: ScrollWireframeMeta;
}

/**
 * Catálogo semántico de anclas disponibles en la tienda para saltos con scroll
 * suave, auto-foco y resalte visual Gamer Mode.
 */
export const SCROLL_TARGET_PRESETS: ScrollTargetPreset[] = [
  {
    id: 'telefono',
    optionLabel: '📱 Cuenta → Campo "Teléfono (opcional)"',
    shortLabel: '📱 Teléfono (opcional)',
    journeyLabel: '📱 Teléfono (opcional) en "Datos y preferencias" (con auto-foco en el campo)',
    suggestedRoute: '/cuenta',
    autoFocus: true,
    wireframe: {
      pageTitle: 'Mi cuenta (/cuenta)',
      parentCard: '✨ Datos y preferencias',
      targetTitle: 'Teléfono (opcional)',
      targetSubtitle: '0412-0000000',
      targetHint: 'Puedes usarlo para iniciar sesión o recuperar tu cuenta sin usar SMS.',
      isInput: true,
    },
  },
  {
    id: 'datos-preferencias',
    optionLabel: '✨ Cuenta → Tarjeta "Datos y preferencias"',
    shortLabel: '✨ Datos y preferencias',
    journeyLabel: '✨ Tarjeta "Datos y preferencias"',
    suggestedRoute: '/cuenta',
    autoFocus: true,
    wireframe: {
      pageTitle: 'Mi cuenta (/cuenta)',
      targetTitle: '✨ Datos y preferencias',
      targetSubtitle: 'Nombre para mostrar · Teléfono (opcional) · Avisos de órdenes',
      isInput: false,
    },
  },
  {
    id: 'seguridad',
    optionLabel: '🔑 Cuenta → Tarjeta "Seguridad"',
    shortLabel: '🔑 Seguridad',
    journeyLabel: '🔑 Tarjeta "Seguridad"',
    suggestedRoute: '/cuenta',
    autoFocus: false,
    wireframe: {
      pageTitle: 'Mi cuenta (/cuenta)',
      targetTitle: '🔑 Seguridad',
      targetSubtitle: 'Contraseña de acceso y estado de vinculación de tu cuenta',
      isInput: false,
    },
  },
  {
    id: 'refillcoins',
    optionLabel: '🪙 Cuenta → Tarjeta "RefillCoins disponibles"',
    shortLabel: '🪙 RefillCoins disponibles',
    journeyLabel: '🪙 Tarjeta "RefillCoins disponibles"',
    suggestedRoute: '/cuenta',
    autoFocus: false,
    wireframe: {
      pageTitle: 'Mi cuenta (/cuenta)',
      targetTitle: '🪙 RefillCoins disponibles · 1 USD = 1 RC',
      targetSubtitle: 'Úsalas al comprar para pagar al instante sin esperar verificación',
      isInput: false,
    },
  },
  {
    id: 'mi-nivel',
    optionLabel: '💎 Cuenta → Tarjeta "Tu Nivel (Membresía)"',
    shortLabel: '💎 Tu Nivel (Membresía)',
    journeyLabel: '💎 Tarjeta "Tu Nivel (Membresía)"',
    suggestedRoute: '/cuenta',
    autoFocus: false,
    wireframe: {
      pageTitle: 'Mi cuenta (/cuenta)',
      targetTitle: '💎 TU NIVEL · Descuento activo',
      targetSubtitle: 'Progreso de membresía y porcentaje de ahorro en cada recarga',
      isInput: false,
    },
  },
  {
    id: 'ultimas-ordenes',
    optionLabel: '📋 Cuenta → Tarjeta "Últimas órdenes"',
    shortLabel: '📋 Últimas órdenes',
    journeyLabel: '📋 Tarjeta "Últimas órdenes"',
    suggestedRoute: '/cuenta',
    autoFocus: false,
    wireframe: {
      pageTitle: 'Mi cuenta (/cuenta)',
      targetTitle: '📋 Últimas órdenes',
      targetSubtitle: 'Resumen rápido de tus compras más recientes y su estado',
      isInput: false,
    },
  },
  {
    id: 'accesos-rapidos',
    optionLabel: '⚡ Cuenta → Accesos rápidos',
    shortLabel: '⚡ Accesos rápidos',
    journeyLabel: '⚡ Grilla "Accesos rápidos" (Órdenes, IDs, Referidos, Notificaciones)',
    suggestedRoute: '/cuenta',
    autoFocus: false,
    wireframe: {
      pageTitle: 'Mi cuenta (/cuenta)',
      targetTitle: '⚡ Accesos rápidos',
      targetSubtitle: 'Mis órdenes · IDs de jugador · Referidos · Notificaciones',
      isInput: false,
    },
  },
  {
    id: 'juegos',
    optionLabel: '🎮 Inicio → Catálogo de Juegos',
    shortLabel: '🎮 Catálogo de Juegos',
    journeyLabel: '🎮 Sección "Catálogo de Juegos"',
    suggestedRoute: '/',
    autoFocus: false,
    wireframe: {
      pageTitle: 'Inicio (/)',
      targetTitle: '🎮 Catálogo de Juegos',
      targetSubtitle: 'Recargas de juegos · Gift cards · Game keys',
      isInput: false,
    },
  },
];

/** Normaliza un identificador de sección quitando `#` iniciales y espacios. */
export function sanitizeScrollTarget(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^#+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '');
}

export function getScrollPreset(targetId?: string | null): ScrollTargetPreset | undefined {
  const clean = sanitizeScrollTarget(targetId);
  if (!clean) return undefined;
  return SCROLL_TARGET_PRESETS.find((preset) => preset.id === clean);
}

export function isExternalHref(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  return /^(https?:\/\/|mailto:|tel:)/i.test(rawUrl.trim());
}

/**
 * Obtiene el ID de scroll efectivo combinando el campo explícito `scrollTarget`
 * y el hash `#ancla` que pudiera traer la URL destino.
 */
export function resolveEffectiveScrollTarget(
  rawUrl?: string | null,
  explicitScrollTarget?: string | null
): string {
  const explicit = sanitizeScrollTarget(explicitScrollTarget);
  if (explicit) return explicit;

  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed || isExternalHref(trimmed)) return '';

  const hashIndex = trimmed.indexOf('#');
  if (hashIndex === -1) return '';
  return sanitizeScrollTarget(trimmed.slice(hashIndex + 1));
}

export interface ResolvedNavigationTarget {
  isExternal: boolean;
  /** URL lista para navegar o abrir (ej. `/cuenta#telefono`). */
  fullHref: string;
  /** Ruta base sin `#hash` (ej. `/cuenta`). */
  basePath: string;
  pathname: string;
  search: string;
  scrollTarget: string;
}

/**
 * Resuelve la ruta final y el ancla de scroll a partir de `url` y `scrollTarget`.
 */
export function resolveNavigationTarget(
  rawUrl?: string | null,
  explicitScrollTarget?: string | null
): ResolvedNavigationTarget {
  const trimmed = (rawUrl ?? '').trim();

  if (isExternalHref(trimmed)) {
    return {
      isExternal: true,
      fullHref: trimmed,
      basePath: trimmed,
      pathname: '',
      search: '',
      scrollTarget: '',
    };
  }

  const scrollTarget = resolveEffectiveScrollTarget(trimmed, explicitScrollTarget);
  const rawBeforeHash = trimmed.split('#')[0].trim();
  const preset = getScrollPreset(scrollTarget);

  let basePath = rawBeforeHash;
  if (!basePath) {
    if (scrollTarget) {
      basePath = preset?.suggestedRoute ?? '/';
    } else {
      return {
        isExternal: false,
        fullHref: '',
        basePath: '',
        pathname: '',
        search: '',
        scrollTarget: '',
      };
    }
  } else if (!basePath.startsWith('/')) {
    basePath = `/${basePath}`;
  }

  const queryIndex = basePath.indexOf('?');
  const pathname = queryIndex >= 0 ? basePath.slice(0, queryIndex) || '/' : basePath;
  const search = queryIndex >= 0 ? basePath.slice(queryIndex) : '';
  const cleanBase = `${pathname}${search}`;
  const fullHref = scrollTarget ? `${cleanBase}#${scrollTarget}` : cleanBase;

  return {
    isExternal: false,
    fullHref,
    basePath: cleanBase,
    pathname,
    search,
    scrollTarget,
  };
}

/**
 * Sincroniza la URL destino cuando el administrador elige una sección en el
 * selector de scroll del Panel Admin.
 */
export function applyScrollTargetToUrl(
  currentUrl: string,
  nextScrollTarget: string
): { url: string; scrollTarget: string } {
  const cleanTarget = sanitizeScrollTarget(nextScrollTarget);
  const trimmed = (currentUrl ?? '').trim();
  const external = isExternalHref(trimmed);
  const withoutHash = external ? '' : trimmed.split('#')[0].trim();

  if (!cleanTarget) {
    return {
      url: external ? trimmed : withoutHash,
      scrollTarget: '',
    };
  }

  const preset = getScrollPreset(cleanTarget);
  if (preset) {
    const currentPathname = withoutHash.split('?')[0];
    const currentSearch = withoutHash.includes('?') ? withoutHash.slice(withoutHash.indexOf('?')) : '';
    const base =
      currentPathname === preset.suggestedRoute
        ? `${preset.suggestedRoute}${currentSearch}`
        : preset.suggestedRoute;

    return {
      url: `${base}#${cleanTarget}`,
      scrollTarget: cleanTarget,
    };
  }

  const customBase = withoutHash && withoutHash.startsWith('/') ? withoutHash : '/';
  return {
    url: `${customBase}#${cleanTarget}`,
    scrollTarget: cleanTarget,
  };
}

/**
 * Extrae el `scrollTarget` cuando el administrador edita manualmente el campo URL
 * (por ejemplo, escribiendo `/cuenta#telefono` a mano).
 */
export function deriveScrollTargetFromManualUrl(nextUrl: string): string {
  const trimmed = (nextUrl ?? '').trim();
  if (!trimmed || isExternalHref(trimmed)) return '';
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex === -1) return '';
  return sanitizeScrollTarget(trimmed.slice(hashIndex + 1));
}

const HIGHLIGHT_CLASSES = [
  'gamer-scroll-highlight',
  'ring-2',
  'ring-red-500/90',
  'shadow-[0_0_25px_rgba(239,68,68,0.35)]',
  'transition-all',
  'duration-500',
];

const HIGHLIGHT_DURATION_MS = 2600;
const highlightTimers = new WeakMap<HTMLElement, number>();
let activeSearchCancel: (() => void) | null = null;

/**
 * Hace scroll suave hacia `#targetId`, aplica el resalte Gamer Mode temporal
 * (~2.6s) y enfoca automáticamente el `<input>` interno si corresponde.
 *
 * Incluye espera reactiva con `requestAnimationFrame` para cubrir pantallas
 * cuyos datos terminan de montar de forma asíncrona (ej. `/cuenta`).
 */
export function scrollToAndHighlight(
  targetId: string,
  options: { maxWaitMs?: number } = {}
): () => void {
  const cleanId = sanitizeScrollTarget(targetId);
  if (!cleanId || typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }

  if (activeSearchCancel) {
    activeSearchCancel();
    activeSearchCancel = null;
  }

  const maxWaitAfterReadyMs = options.maxWaitMs ?? 700;
  const hardCapMs = 10_000;
  const startedAt = performance.now();
  let readySince: number | null = null;
  let cancelled = false;
  let rafId = 0;
  let focusTimerId = 0;

  const cancel = () => {
    cancelled = true;
    if (rafId) window.cancelAnimationFrame(rafId);
    if (focusTimerId) window.clearTimeout(focusTimerId);
  };

  activeSearchCancel = cancel;

  const applyEffect = (element: HTMLElement) => {
    if (cancelled) return;

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const previousTimer = highlightTimers.get(element);
    if (previousTimer) {
      window.clearTimeout(previousTimer);
    }

    element.classList.add(...HIGHLIGHT_CLASSES);
    const removeTimer = window.setTimeout(() => {
      element.classList.remove(...HIGHLIGHT_CLASSES);
      highlightTimers.delete(element);
    }, HIGHLIGHT_DURATION_MS);
    highlightTimers.set(element, removeTimer);

    const inputEl =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element
        : element.querySelector<HTMLElement>(
            'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"]):not(:disabled), textarea:not(:disabled)'
          );

    if (inputEl) {
      focusTimerId = window.setTimeout(() => {
        if (cancelled) return;
        inputEl.focus({ preventScroll: true });
      }, 320);
    }
  };

  const poll = () => {
    if (cancelled) return;
    const found = document.getElementById(cleanId);
    if (found) {
      // Un frame adicional garantiza que el layout esté asentado tras cerrar un modal o montar datos.
      rafId = window.requestAnimationFrame(() => applyEffect(found));
      return;
    }

    const nowMs = performance.now();
    const isPageLoading = Boolean(document.querySelector('[data-page-loader="true"]'));
    if (isPageLoading) {
      readySince = null;
    } else if (readySince === null) {
      readySince = nowMs;
    }

    const withinHardCap = nowMs - startedAt < hardCapMs;
    const withinReadyWindow = readySince === null || nowMs - readySince < maxWaitAfterReadyMs;

    if (withinHardCap && withinReadyWindow) {
      rafId = window.requestAnimationFrame(poll);
    }
  };

  rafId = window.requestAnimationFrame(poll);
  return cancel;
}

export interface ScrollNavigationState {
  scrollTrigger?: number;
  scrollTarget?: string;
}

/**
 * Hook reutilizable para botones de Modales y enlaces de Avisos en la tienda.
 * Soporta tanto cambio de ruta (Escenario 1) como clic estando ya en la misma
 * página (Escenario 2).
 */
export function useSmartStoreNavigate() {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(
    (
      rawUrl?: string | null,
      explicitScrollTarget?: string | null,
      onBeforeNavigate?: () => void
    ) => {
      const target = resolveNavigationTarget(rawUrl, explicitScrollTarget);
      onBeforeNavigate?.();

      if (!target.fullHref) return;

      if (target.isExternal) {
        window.open(target.fullHref, '_blank', 'noopener,noreferrer');
        return;
      }

      const samePage =
        location.pathname === target.pathname && location.search === target.search;

      if (target.scrollTarget) {
        const nextHash = `#${target.scrollTarget}`;
        navigate(target.fullHref, {
          replace: samePage && location.hash === nextHash,
          state: {
            scrollTrigger: Date.now(),
            scrollTarget: target.scrollTarget,
          } satisfies ScrollNavigationState,
        });
        return;
      }

      if (samePage) {
        if (location.hash) {
          navigate(target.basePath, { replace: true });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      navigate(target.fullHref);
    },
    [location.hash, location.pathname, location.search, navigate]
  );
}
