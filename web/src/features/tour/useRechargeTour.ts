/**
 * Definición del tutorial «Te acompaño mientras recargas» y su contexto.
 *
 * El motor (provider + overlay) vive en `RechargeTour.tsx`. Las pantallas sólo
 * hacen dos cosas: marcar con `data-tour="..."` los elementos que se resaltan y
 * avisar con `notify(evento)` cuando el cliente hace la acción real, para que
 * la guía avance sola.
 */
import { createContext, useContext } from 'react';

export const TOUR_STORAGE_KEY = 'refill.rechargeTour.seen';

/** Acciones reales del cliente que hacen avanzar la guía. */
export type TourEvent =
  | 'id-verified'
  | 'package-selected'
  | 'checkout-started'
  | 'payment-submitted';

/** Pantalla donde vive cada paso: evita ofrecer «Atrás» hacia otra página. */
export type TourRoute = 'any' | 'home' | 'game' | 'checkout';

export type TourPrimaryAction =
  | 'advance'
  | 'goStart'
  | 'verify'
  | 'continue'
  | 'focusReference'
  | 'finish';

export interface TourStep {
  id: string;
  category: string;
  title: string;
  text: string;
  /** Valor de `data-tour` del elemento resaltado. Sin él se muestra sólo la tarjeta. */
  target?: string;
  route: TourRoute;
  advanceOn?: TourEvent;
  /** Si el elemento no existe en esta pantalla, el paso se salta solo. */
  optional?: boolean;
  /** Espera antes de saltar un paso opcional (ms). Por defecto 1500. */
  optionalWaitMs?: number;
  /** Sin botón principal: el paso avanza sólo con la acción del cliente. */
  hidePrimary?: boolean;
  /** Fuerza la tarjeta arriba para dejar libre un elemento inferior. */
  forceTop?: boolean;
  primaryLabel: string;
  primaryAction: TourPrimaryAction;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    category: 'Bienvenida',
    title: 'Te acompaño mientras recargas',
    text: 'Usa la pantalla como siempre: te indico qué tocar y avanzo contigo.',
    route: 'any',
    primaryLabel: 'Siguiente >',
    primaryAction: 'goStart',
  },
  {
    id: 'catalog',
    category: 'Juego / Gift card',
    title: 'Elige tu Juego o Gift Card',
    text: 'Toca el juego a recargar o cambia a "Gift cards" para elegir tu tarjeta.',
    target: 'catalog-selector',
    route: 'home',
    hidePrimary: true,
    primaryLabel: '',
    primaryAction: 'advance',
  },
  {
    id: 'game-select',
    category: 'Juego',
    title: 'Elige el juego o región',
    text: 'Cambia de juego aquí arriba o toca "Siguiente >" si ya estás en el que buscas.',
    target: 'game-selector',
    route: 'game',
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'player-id',
    category: 'Cuenta',
    title: 'Escribe aquí tu ID de jugador',
    text: 'Es el número de tu cuenta en tu perfil del juego (no tu apodo).',
    target: 'player-id-input',
    route: 'game',
    optional: true,
    optionalWaitMs: 600,
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'verify-id',
    category: 'Cuenta',
    title: 'Ahora toca "Verificar ID"',
    text: 'Confirmaremos el nombre de tu cuenta antes de continuar al pago.',
    target: 'verify-id-button',
    route: 'game',
    advanceOn: 'id-verified',
    optional: true,
    optionalWaitMs: 600,
    primaryLabel: 'Verificar >',
    primaryAction: 'verify',
  },
  {
    id: 'verified-badge',
    category: 'Cuenta',
    title: 'Mira que sea tu cuenta',
    text: 'Confirma que sea tu nombre de jugador; ahí enviaremos tu recarga.',
    target: 'verified-player-badge',
    route: 'game',
    optional: true,
    optionalWaitMs: 600,
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'package',
    category: 'Recarga',
    title: 'Elige tu recarga',
    text: 'Toca el paquete que deseas. Arriba puedes cambiar de categoría o sumar con [+].',
    target: 'package-grid',
    route: 'game',
    advanceOn: 'package-selected',
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'purchase-bar',
    category: 'Pagar',
    title: 'Abajo sale tu total',
    text: 'Revisa el monto en Bolívares y USD, ajusta la cantidad y toca "Continuar".',
    target: 'purchase-bar',
    route: 'game',
    advanceOn: 'checkout-started',
    forceTop: true,
    primaryLabel: 'Continuar >',
    primaryAction: 'continue',
  },
  {
    id: 'contact',
    category: 'Contacto',
    title: 'Tus datos de contacto',
    text: 'Déjanos tu WhatsApp o correo para enviarte el recibo de tu recarga.',
    target: 'buyer-contact-section',
    route: 'checkout',
    optional: true,
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'bank-details',
    category: 'Pago móvil',
    title: 'Estos son los datos para pagar',
    text: 'Haz el Pago Móvil por el monto exacto en Bs. Toca cualquier dato para copiarlo.',
    target: 'payment-bank-details',
    route: 'checkout',
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'reference',
    category: 'Referencia',
    title: 'Coloca tu referencia (sin capturas)',
    text: 'Escribe los dígitos de referencia de tu Pago Móvil y toca "Ya pagué, verificar".',
    target: 'payment-reference-form',
    route: 'checkout',
    advanceOn: 'payment-submitted',
    primaryLabel: 'Entendido',
    primaryAction: 'focusReference',
  },
  {
    id: 'done',
    category: 'Listo',
    title: '¡Así de fácil! Recarga automática',
    text: 'Al verificar tu referencia, enviamos la recarga al instante a tu cuenta.',
    target: 'order-status-section',
    route: 'checkout',
    primaryLabel: 'Listo',
    primaryAction: 'finish',
  },
];

export const stepIndex = (id: string) => TOUR_STEPS.findIndex((step) => step.id === id);

export interface RechargeTourContextValue {
  active: boolean;
  index: number;
  /** Inicia la guía; `from` es el índice del paso (0 = bienvenida, 1 = ID). */
  start: (from?: number) => void;
  /** Cierra la guía. Con `completed` recuerda que el cliente ya la conoció. */
  stop: (completed?: boolean) => void;
  next: () => void;
  back: () => void;
  /** Salta directo a un paso. */
  goTo: (index: number) => void;
  /** Avisa de una acción real del cliente; avanza si el paso actual la espera. */
  notify: (event: TourEvent) => void;
}

const noop = () => undefined;

export const RechargeTourContext = createContext<RechargeTourContextValue>({
  active: false,
  index: 0,
  start: noop,
  stop: noop,
  next: noop,
  back: noop,
  goTo: noop,
  notify: noop,
});

export function useRechargeTour(): RechargeTourContextValue {
  return useContext(RechargeTourContext);
}

