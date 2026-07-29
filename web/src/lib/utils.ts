/** Utilidades pequeñas y transversales. */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Combina clases resolviendo conflictos de Tailwind (la última gana). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Copia al portapapeles con respaldo para navegadores móviles antiguos. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    textarea.remove();
    return success;
  } catch {
    return false;
  }
}

/** Deja sólo dígitos: se usa para IDs de jugador y referencias bancarias. */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** Enmascara un ID largo: 3363122817 → 336••••817 */
export function maskId(value: string): string {
  if (value.length <= 6) return value;
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Ejecuta `fn` como máximo una vez cada `wait` ms. */
export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 350) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Convierte un HEX en `r, g, b` para usarlo dentro de `rgba()`. */
export function hexToRgb(hex: string): string {
  const clean = hex.replace('#', '');
  const bigint = parseInt(
    clean.length === 3
      ? clean
          .split('')
          .map((char) => char + char)
          .join('')
      : clean,
    16
  );
  return `${(bigint >> 16) & 255}, ${(bigint >> 8) & 255}, ${bigint & 255}`;
}

/** Abre WhatsApp respetando el bloqueo de ventanas emergentes en iOS. */
export function openWhatsapp(url: string): void {
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) window.location.href = url;
}

export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** Mensaje de error legible venga de donde venga. */
export function errorMessage(error: unknown, fallback = 'Ocurrió un error inesperado.'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}
