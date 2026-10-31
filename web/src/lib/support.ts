import type { PublicConfig } from '@/types/models';

/**
 * Obtiene el username del bot de Telegram de soporte sin '@'.
 */
export function getTelegramBotUsername(config?: PublicConfig | null): string {
  return (config?.telegramSupportBotUsername || 'V2RefillBot').replace(/^@/, '');
}

/**
 * Construye el enlace de deep linking para una orden específica en Telegram.
 * - Si es manual: /start manual_RF-XXXXXX (reconoce la orden y alerta al admin con botones de acción).
 * - Si es automática/soporte: /start orden_RF-XXXXXX (consulta directa en vivo).
 */
export function buildTelegramOrderUrl(
  orderCode: string,
  isManual = false,
  config?: PublicConfig | null
): string {
  const username = getTelegramBotUsername(config);
  const cleanCode = (orderCode || '').trim();
  const prefix = isManual ? 'manual_' : 'orden_';
  return `https://t.me/${username}?start=${prefix}${encodeURIComponent(cleanCode)}`;
}

/**
 * Construye el enlace de soporte general en Telegram.
 * Por defecto abre el menú interactivo de bienvenida y FAQs (/start soporte).
 */
export function buildTelegramSupportUrl(
  config?: PublicConfig | null,
  startParam = 'soporte'
): string {
  const username = getTelegramBotUsername(config);
  return startParam
    ? `https://t.me/${username}?start=${encodeURIComponent(startParam)}`
    : `https://t.me/${username}`;
}

/**
 * Retorna las banderas de visibilidad de los canales de soporte según la configuración activa.
 */
export function getActiveSupportChannels(config?: PublicConfig | null) {
  const mode = config?.supportChannelMode ?? 'both';
  return {
    showWhatsapp: mode === 'both' || mode === 'whatsapp',
    showTelegram: mode === 'both' || mode === 'telegram',
    isBoth: mode === 'both',
  };
}
