/** Cupones de descuento: validación y consumo. */
import { FieldValue } from 'firebase-admin/firestore';
import { coupons, orders, now, Timestamp } from '../config/firebase';
import { failedPrecondition, notFound } from '../lib/errors';
import { round } from '../lib/money';
import type { Coupon } from '../types/models';

export interface CouponEvaluation {
  coupon: Coupon;
  discountUsd: number;
}

function toMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return (value as Timestamp).toMillis();
  }
  return null;
}

/**
 * Comprueba que el cupón se pueda usar en esta compra y calcula el descuento.
 * No lo consume: eso ocurre sólo cuando el pago se confirma.
 */
export async function evaluate(options: {
  code: string;
  uid: string;
  subtotalUsd: number;
  gameId: string;
  productId: string;
}): Promise<CouponEvaluation> {
  const code = options.code.trim().toUpperCase();
  const snap = await coupons().doc(code).get();
  if (!snap.exists) throw notFound('Ese cupón no existe.');

  const coupon = { code: snap.id, ...snap.data() } as Coupon;

  if (!coupon.active) throw failedPrecondition('Ese cupón ya no está activo.');

  const nowMs = Date.now();
  const from = toMillis(coupon.validFrom);
  const until = toMillis(coupon.validUntil);
  if (from !== null && nowMs < from) throw failedPrecondition('Ese cupón todavía no es válido.');
  if (until !== null && nowMs > until) throw failedPrecondition('Ese cupón ya venció.');

  if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit) {
    throw failedPrecondition('Ese cupón alcanzó su límite de usos.');
  }

  if (options.subtotalUsd < coupon.minOrderUsd) {
    throw failedPrecondition(
      `Ese cupón aplica en compras desde $${coupon.minOrderUsd.toFixed(2)}.`
    );
  }

  if (coupon.gameIds.length > 0 && !coupon.gameIds.includes(options.gameId)) {
    throw failedPrecondition('Ese cupón no aplica para este juego.');
  }

  if (coupon.productIds.length > 0 && !coupon.productIds.includes(options.productId)) {
    throw failedPrecondition('Ese cupón no aplica para este producto.');
  }

  if (coupon.perUserLimit > 0) {
    const used = await orders()
      .where('uid', '==', options.uid)
      .where('pricing.couponCode', '==', code)
      .count()
      .get();
    if (used.data().count >= coupon.perUserLimit) {
      throw failedPrecondition('Ya usaste ese cupón el máximo de veces permitido.');
    }
  }

  let discountUsd =
    coupon.type === 'percent'
      ? (options.subtotalUsd * coupon.value) / 100
      : coupon.value;

  if (coupon.maxDiscountUsd !== null) {
    discountUsd = Math.min(discountUsd, coupon.maxDiscountUsd);
  }

  // Nunca dejar el total en cero o negativo.
  discountUsd = Math.min(discountUsd, round(options.subtotalUsd - 0.01, 2));

  return { coupon, discountUsd: round(Math.max(discountUsd, 0), 2) };
}

/** Incrementa el contador de usos. Se llama al confirmar el pago. */
export async function consume(code: string): Promise<void> {
  await coupons()
    .doc(code.trim().toUpperCase())
    .set({ usageCount: FieldValue.increment(1), updatedAt: now() }, { merge: true });
}

export async function list(): Promise<Coupon[]> {
  const snap = await coupons().orderBy('createdAt', 'desc').limit(200).get();
  return snap.docs.map((doc) => ({ code: doc.id, ...doc.data() }) as Coupon);
}
