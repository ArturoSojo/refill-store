/** Tipos del asistente de recargas en formato chat. */

export type ChatFamily = 'topup' | 'gift_card' | 'game_key';

/** Métodos de pago que acepta `POST /orders`. */
export type ChatPaymentMethod = 'pagomovil_bdv' | 'transfer' | 'binance_pay';

/** Pasos de la conversación. */
export type ChatStep =
  | 'welcome'
  | 'menu'
  | 'games'
  | 'packages'
  | 'fields'
  | 'summary'
  | 'auth'
  | 'phone'
  | 'method'
  | 'reference'
  | 'monitoring'
  | 'done';

/** Opción interactiva que se pinta como botón o tarjeta dentro de una burbuja del bot. */
export interface ChatOption {
  id: string;
  label: string;
  /** Texto corto opcional bajo la etiqueta (precio, ayuda…). */
  hint?: string;
  /** Color de acento del juego. */
  accent?: string;
  /** Portada o logo para las tarjetas de juego. */
  imageUrl?: string;
}

/** Dato copiable con un toque (banco, cédula, teléfono, monto, códigos…). */
export interface ChatCopyField {
  label: string;
  /** Lo que se copia al portapapeles. */
  value: string;
  /** Lo que se muestra, si difiere del valor copiado. */
  display?: string;
  emphasis?: boolean;
}

export interface ChatMessage {
  id: number;
  from: 'bot' | 'user';
  text: string;
  /** Tarjetas o botones principales del mensaje. */
  options?: ChatOption[];
  /** `games`: cuadrícula con portada · `list`: una por fila · `buttons`: píldoras. */
  optionsVariant?: 'buttons' | 'games' | 'list';
  /** Acciones secundarias (ver más, volver al menú), siempre como píldoras. */
  actions?: ChatOption[];
  /** Filas «etiqueta + valor + copiar» bajo la burbuja. */
  copyFields?: ChatCopyField[];
  /** Muestra un indicador de progreso (spinner) junto al texto. */
  progress?: boolean;
}
