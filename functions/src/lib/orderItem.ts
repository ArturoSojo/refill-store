/**
 * Cómo se nombra lo comprado en los mensajes al cliente.
 *
 * Se mantiene ESPEJO en `web/src/lib/orderItem.ts`.
 *
 * Existe porque el nombre del producto por sí solo miente cuando se compra más
 * de una unidad: quien pedía dos veces «100 + 10 Diamantes» recibía un aviso
 * que decía «100 + 10 Diamantes ya está en tu cuenta», sin rastro de que eran
 * 220. Concentrar aquí el formato evita que el próximo mensaje que se escriba
 * vuelva a olvidarse de la cantidad.
 */
import type { Order } from '../types/models';

/** Lo mínimo que hace falta para nombrar la compra. */
export interface OrderItemLike {
  productName: string;
  productAmount?: number | null;
  productBonus?: number | null;
  pricing: { quantity: number };
}

/**
 * Nombre de lo comprado, con la cantidad cuando hay más de una unidad.
 *
 *   1 unidad  → «100 + 10 Diamantes»
 *   2 unidades → «2× 100 + 10 Diamantes (200 + 20 en total)»
 *
 * El total entre paréntesis sólo aparece si la orden guardó cuánto entrega cada
 * unidad. Las órdenes anteriores a ese campo se quedan en el «2×», que ya basta
 * para no confundir.
 */
export function describeOrderItem(order: OrderItemLike): string {
  const quantity = order.pricing?.quantity ?? 1;
  if (quantity <= 1) return order.productName;

  const amount = order.productAmount ?? null;
  const bonus = order.productBonus ?? null;

  if (amount === null || amount <= 0) {
    return `${quantity}× ${order.productName}`;
  }

  const totalAmount = (amount * quantity).toLocaleString('es-VE');
  const totalBonus = bonus ? (bonus * quantity).toLocaleString('es-VE') : null;
  const total = totalBonus ? `${totalAmount} + ${totalBonus}` : totalAmount;

  return `${quantity}× ${order.productName} (${total} en total)`;
}

/** Versión corta para asuntos de correo y avisos: sólo «2× nombre». */
export function shortOrderItem(order: OrderItemLike): string {
  const quantity = order.pricing?.quantity ?? 1;
  return quantity > 1 ? `${quantity}× ${order.productName}` : order.productName;
}

/** Atajo para cuando ya se tiene la orden completa. */
export function describeOrder(order: Order): string {
  return describeOrderItem(order);
}
