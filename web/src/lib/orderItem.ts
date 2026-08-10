/**
 * Cómo se nombra lo comprado (espejo de `functions/src/lib/orderItem.ts`).
 *
 * El nombre del producto por sí solo miente cuando se compra más de una unidad:
 * dos veces «100 + 10 Diamantes» son 220, no 110.
 */
import type { Order } from '@/types/models';

export interface OrderItemLike {
  productName: string;
  productAmount?: number | null;
  productBonus?: number | null;
  pricing: { quantity: number };
}

/**
 * Nombre de lo comprado, con la cantidad cuando hay más de una unidad.
 *
 *   1 unidad   → «100 + 10 Diamantes»
 *   2 unidades → «2× 100 + 10 Diamantes (200 + 20 en total)»
 *
 * El total sólo aparece si la orden guardó cuánto entrega cada unidad; las
 * anteriores a ese campo se quedan en el «2×», que ya evita la confusión.
 */
export function describeOrderItem(order: OrderItemLike): string {
  const quantity = order.pricing?.quantity ?? 1;
  if (quantity <= 1) return order.productName;

  const amount = order.productAmount ?? null;
  const bonus = order.productBonus ?? null;

  if (amount === null || amount <= 0) return `${quantity}× ${order.productName}`;

  const totalAmount = (amount * quantity).toLocaleString('es-VE');
  const totalBonus = bonus ? (bonus * quantity).toLocaleString('es-VE') : null;
  const total = totalBonus ? `${totalAmount} + ${totalBonus}` : totalAmount;

  return `${quantity}× ${order.productName} (${total} en total)`;
}

/** Versión corta para listas apretadas: sólo «2× nombre». */
export function shortOrderItem(order: OrderItemLike): string {
  const quantity = order.pricing?.quantity ?? 1;
  return quantity > 1 ? `${quantity}× ${order.productName}` : order.productName;
}

export function describeOrder(order: Order): string {
  return describeOrderItem(order);
}
