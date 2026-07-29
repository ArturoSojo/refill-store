/**
 * Construcción del enlace de WhatsApp para productos manuales (Categoría B).
 *
 * Formato exigido por las especificaciones:
 *   https://wa.me/{NUMERO}?text={MENSAJE_ENCODEADO}
 */
import { formatBs } from '../lib/money';
import type { Order } from '../types/models';

/** Deja el número en el formato internacional sin símbolos que exige wa.me. */
export function normalizeWhatsappNumber(raw: string): string {
  return raw.replace(/\D/g, '');
}

export interface ManualMessageInput {
  gameName: string;
  productName: string;
  playerId: string;
  amountBs: number;
  reference: string;
  orderCode: string;
}

export function buildManualMessage(input: ManualMessageInput): string {
  return [
    '🛒 NUEVA RECARGA MANUAL - REFILL STORE',
    '',
    `🎮 Juego: ${input.gameName}`,
    `📦 Producto: ${input.productName}`,
    `👤 ID Jugador: ${input.playerId}`,
    `💵 Monto Pagado: ${formatBs(input.amountBs)} Bs`,
    `🧾 N° de Referencia: ${input.reference}`,
    `🔖 Orden: ${input.orderCode}`,
    '📌 Estado: ✅ Pago Verificado en Web',
  ].join('\n');
}

export function buildWhatsappUrl(number: string, message: string): string {
  return `https://wa.me/${normalizeWhatsappNumber(number)}?text=${encodeURIComponent(message)}`;
}

/** Enlace listo para el cliente a partir de una orden manual ya pagada. */
export function buildManualOrderUrl(order: Order, adminNumber: string): string {
  const message = buildManualMessage({
    gameName: order.gameName,
    productName: order.productName,
    playerId: order.playerId,
    amountBs: order.pricing.totalBs,
    reference: order.payment.reference ?? 'N/D',
    orderCode: order.code,
  });
  return buildWhatsappUrl(adminNumber, message);
}

/** Enlace genérico de soporte, con la orden como contexto si aplica. */
export function buildSupportUrl(
  supportNumber: string,
  options: { orderCode?: string; topic?: string } = {}
): string {
  const lines = ['Hola Refill Store 👋'];
  if (options.orderCode) lines.push(`Necesito ayuda con mi orden ${options.orderCode}.`);
  if (options.topic) lines.push(options.topic);
  return buildWhatsappUrl(supportNumber, lines.join('\n'));
}
