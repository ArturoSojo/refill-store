/** Cupones de descuento: validación y consumo. */
import { FieldValue } from 'firebase-admin/firestore';
import { coupons, orders, now, Timestamp } from '../config/firebase';
import { failedPrecondition, notFound } from '../lib/errors';
import { round } from '../lib/money';
import type { Coupon, OrderStatus } from '../types/models';

export interface CouponEvaluation {
  coupon: Coupon;
  discountUsd: number;
}

/**
 * Estados en los que una orden gasta un uso del cupón.
 *
 * Incluye las que todavía se pueden pagar, no sólo las cobradas: si sólo
 * contaran las pagadas, alguien podría crear varias órdenes a la vez con el
 * mismo cupón y pagarlas todas, saltándose el límite.
 *
 * Y deja fuera `cancelled` y `expired`, que es lo que estaba mal: se contaba
 * cualquier orden creada con el cupón, así que abandonar el pago quemaba el uso
 * y el cliente se quedaba sin poder aprovecharlo. `refunded` sí cuenta, para que
 * no se pueda reciclar el cupón pidiendo la devolución.
 */
const COUNTS_AS_USE: OrderStatus[] = [
  'awaiting_payment',
  'verifying',
  'payment_rejected',
  'paid',
  'dispatching',
  'awaiting_manual',
  'completed',
  'failed',
  'refunded',
];

function toMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return (value as Timestamp).toMillis();
  }
  return null;
}

/**
 * Cuenta cuántas veces se gastó ya el cupón bajo un criterio.
 *
 * Se traen los estados y se filtran en memoria en lugar de pedirle a Firestore
 * un `count()` con `in`: el conjunto es diminuto (lo acota el propio límite del
 * cupón) y así no hace falta un índice compuesto por cada combinación.
 */
async function countUses(
  code: string,
  criterio: { uid?: string; gameId?: string; playerId?: string }
): Promise<number> {
  let query = orders().where('pricing.couponCode', '==', code);

  if (criterio.uid) query = query.where('uid', '==', criterio.uid);
  if (criterio.gameId) query = query.where('gameId', '==', criterio.gameId);
  if (criterio.playerId) query = query.where('playerId', '==', criterio.playerId);

  const snap = await query.select('status').limit(50).get();
  return snap.docs.filter((doc) => COUNTS_AS_USE.includes(doc.get('status') as OrderStatus))
    .length;
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
  /**
   * ID de la cuenta que se va a recargar.
   *
   * Opcional sólo porque la previsualización del precio puede pedirse antes de
   * que el cliente lo escriba. Al crear la orden siempre llega, que es donde
   * importa.
   */
  playerId?: string | null;
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

  // El límite se aplica por DOS caminos a la vez: la cuenta y el ID del juego.
  //
  // Sólo por cuenta no protege de nada: crear correos nuevos es gratis, así que
  // un límite de «un uso por usuario» se convierte en ilimitado para quien esté
  // dispuesto a registrarse varias veces y recargar siempre el mismo personaje.
  // Contando también por ID de jugador, el cupón se agota para esa cuenta del
  // juego venga de donde venga.
  //
  // El conteo por ID va acotado al juego: un `123456789` de Free Fire y uno de
  // Blood Strike son personas distintas, y bloquear al segundo sería un error.
  if (coupon.perUserLimit > 0) {
    const [porCuenta, porJugador] = await Promise.all([
      countUses(code, { uid: options.uid }),
      options.playerId
        ? countUses(code, { gameId: options.gameId, playerId: options.playerId })
        : Promise.resolve(0),
    ]);

    if (porCuenta >= coupon.perUserLimit) {
      throw failedPrecondition('Ya usaste ese cupón el máximo de veces permitido.');
    }

    if (porJugador >= coupon.perUserLimit) {
      throw failedPrecondition(
        'Ese cupón ya se usó para recargar esa cuenta del juego el máximo de veces permitido.'
      );
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
