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
export type TourRoute = 'any' | 'game' | 'checkout';

export type TourPrimaryAction =
  | 'advance'
  | 'goGame'
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
    text: 'Usa la pantalla como siempre: te voy diciendo qué tocar y avanzo en cuanto lo hagas.',
    route: 'any',
    primaryLabel: 'Siguiente >',
    primaryAction: 'goGame',
  },
  {
    id: 'player-id',
    category: 'Cuenta',
    title: 'Escribe aquí tu ID de jugador',
    text: 'Es el número de tu cuenta, no tu apodo. Lo ves en tu perfil dentro del juego. Escríbelo aquí para continuar.',
    target: 'player-id-input',
    route: 'game',
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'verify-id',
    category: 'Cuenta',
    title: 'Ahora toca "Verificar ID"',
    text: 'Te mostramos el nombre de la cuenta para que confirmes que es la tuya antes de pagar. Si no es, cambias el ID y ya.',
    target: 'verify-id-button',
    route: 'game',
    advanceOn: 'id-verified',
    optional: true,
    primaryLabel: 'Verificar >',
    primaryAction: 'verify',
  },
  {
    id: 'verified-badge',
    category: 'Cuenta',
    title: 'Mira que sea tu cuenta',
    text: 'Este es el nombre del jugador con ese ID. Si no es la tuya, corrige el ID y vuelve a verificarlo: la recarga se envía directo a la cuenta que aparece aquí.',
    target: 'verified-player-badge',
    route: 'game',
    optional: true,
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'package',
    category: 'Recarga',
    title: 'Elige tu recarga',
    text: 'Toca el paquete que quieres comprar. Arriba puedes cambiar entre Diamantes, Subida de nivel o Especiales, y si quieres varias unidades puedes sumar con [+].',
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
    text: 'Aquí ves el paquete elegido, la cantidad y el monto exacto en Bolívares y USD. Toca "Continuar" para ir al pago.',
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
    text: 'Déjanos tu WhatsApp o correo para enviarte el recibo y avisarte apenas se complete tu recarga.',
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
    text: 'Haz el Pago Móvil a estos datos por el monto exacto en Bolívares que aparece en pantalla. Toca cualquier dato (Cédula, Teléfono, Banco o Monto) para copiarlo rápido.',
    target: 'payment-bank-details',
    route: 'checkout',
    primaryLabel: 'Siguiente >',
    primaryAction: 'advance',
  },
  {
    id: 'reference',
    category: 'Referencia',
    title: 'Coloca tu referencia (sin capturas)',
    text: 'No necesitas subir fotos ni comprobantes. Solo escribe el número de referencia que te dio tu banco al hacer el Pago Móvil y toca "Ya pagué, verificar". Nuestro sistema lo confirma solo en segundos.',
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
    text: 'En cuanto verificas tu referencia, el sistema envía tu recarga al instante a tu cuenta del juego. Aquí mismo verás cuando pase a Completado.',
    target: 'order-status-section',
    route: 'checkout',
    primaryLabel: 'Listo',
    primaryAction: 'finish',
  },
];

export interface RechargeTourContextValue {
  active: boolean;
  index: number;
  /** Inicia la guía; `from` es el índice del paso (0 = bienvenida, 1 = ID). */
  start: (from?: number) => void;
  /** Cierra la guía. Con `completed` recuerda que el cliente ya la conoció. */
  stop: (completed?: boolean) => void;
  next: () => void;
  back: () => void;
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
  notify: noop,
});

export function useRechargeTour(): RechargeTourContextValue {
  return useContext(RechargeTourContext);
}
