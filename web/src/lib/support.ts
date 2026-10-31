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

/**
 * Resuelve el enlace de WhatsApp para órdenes de entrega manual (`awaiting_manual`).
 * Si `order.whatsappUrl` ya viene generado, lo devuelve directamente.
 * Si viene vacío o null, construye automáticamente el enlace `https://wa.me/...`
 * con el teléfono administrativo o de soporte de `config` y el mensaje prellenado.
 */
export function resolveManualWhatsappUrl(
  order: {
    code: string;
    productName: string;
    playerId?: string | null;
    gameName?: string | null;
    pricing?: { totalBs?: number; totalUsd?: number } | null;
    payment?: { reference?: string | null } | null;
    whatsappUrl?: string | null;
  },
  config?: PublicConfig | null
): string | null {
  if (order.whatsappUrl && order.whatsappUrl.trim().length > 0) {
    return order.whatsappUrl.trim();
  }

  // Extraer número telefónico destino
  const rawNumber =
    config?.whatsapp?.supportNumber ||
    (config?.supportUrl ? config.supportUrl.replace(/.*wa\.me\/(\d+).*/, '$1') : null) ||
    '584122686326';
  const cleanNumber = String(rawNumber).replace(/\D/g, '');

  if (!cleanNumber) return null;

  const playerPart = order.playerId ? ` para el ID *${order.playerId}*` : '';
  const refPart = order.payment?.reference ? ` (Ref: ${order.payment.reference})` : '';
  const message = `Hola, acabo de pagar mi orden *${order.code}* (${order.productName})${playerPart}${refPart}. ¿Me ayudan a activarla, por favor?`;

  return `https://wa.me/${cleanNumber}?text=${encodeURIComponent(message)}`;
}

