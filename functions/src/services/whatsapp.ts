/**
 * Construcción del enlace de WhatsApp para productos manuales (Categoría B).
 *
 * Formato exigido por las especificaciones:
 *   https://wa.me/{NUMERO}?text={MENSAJE_ENCODEADO}
 */
import { formatBs } from '../lib/money';
import { describeOrder } from '../lib/orderItem';
import type { Order, PlayerField } from '../types/models';

/** Deja el número en el formato internacional sin símbolos que exige wa.me. */
export function normalizeWhatsappNumber(raw: string): string {
  return raw.replace(/\D/g, '');
}

export interface ManualMessageInput {
  gameName: string;
  productName: string;
  playerId: string;
  /**
   * Resto de datos de la cuenta a recargar, ya etiquetados
   * (`[{ label: 'Zone ID', value: '2345' }]`).
   *
   * Van en el mensaje porque sin ellos el asesor no puede completar la entrega:
   * un Mobile Legends sin Zone ID, o un Roblox sin la clave, no se recarga.
   */
  extraFields?: Array<{ label: string; value: string }>;
  amountBs: number;
  reference: string;
  orderCode: string;
}

export function buildManualMessage(input: ManualMessageInput): string {
  const extras = (input.extraFields ?? []).map(
    (field) => `   • ${field.label}: ${field.value}`
  );

  return [
    '🛒 NUEVA RECARGA MANUAL - REFILL STORE',
    '',
    `🎮 Juego: ${input.gameName}`,
    `📦 Producto: ${input.productName}`,
    `👤 Datos de la cuenta: ${input.playerId}`,
    ...extras,
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
export function buildManualOrderUrl(
  order: Order,
  adminNumber: string,
  fields: PlayerField[] = []
): string {
  // El campo principal ya se muestra aparte; aquí van los demás (Zone ID,
  // correo, contraseña) con la etiqueta que definió el juego.
  const extraFields = fields
    .filter((field) => field.providerField !== 'player_id')
    .map((field) => ({ label: field.label, value: order.playerFields?.[field.key] ?? '' }))
    .filter((entry) => entry.value.length > 0);

  const message = buildManualMessage({
    gameName: order.gameName,
    productName: describeOrder(order),
    playerId: order.playerId,
    extraFields,
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
