/**
 * Creadores de contenido y sus comisiones.
 *
 * Un creador tiene un código que comparte con su audiencia. Cuando alguien
 * compra usándolo, el creador devenga un porcentaje de esa venta. El dinero no
 * se le abona en el acto: queda como comisión *pendiente* en un libro por
 * asientos, y el administrador la liquida cuando quiere, moviéndola a su
 * cartera con `moveWallet`.
 *
 * Por qué un subsistema aparte y no un cupón ni un referido:
 *
 *  - Un cupón ocupa el único slot `pricing.couponCode` de la orden, así que el
 *    cliente no podría usar una promo y un código de creador a la vez. Además
 *    un cupón siempre descuenta (`value` es positivo obligatorio) y se
 *    «consume» con límites de uso, semántica incompatible con una atribución
 *    ilimitada y reversible.
 *  - Un referido es un vínculo único y permanente (`applyReferral` rechaza el
 *    segundo), de monto fijo y pagado una sola vez. Aquí hace falta un
 *    porcentaje en *cada* compra, y que un cliente pueda comprar hoy con el
 *    código de un creador y mañana con el de otro.
 *
 * Las tres piezas delicadas están copiadas de código ya probado en el repo: el
 * candado de unicidad al estilo de `paymentRefs`, la transacción de dinero de
 * `moveWallet` y el congelado de datos en la orden al estilo de `bankSnapshot`.
 */
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { creators, creatorCodes, db, now } from '../config/firebase';
import { failedPrecondition, invalidArgument, notFound } from '../lib/errors';
import { normalizeCreatorCode } from '../lib/ids';
import { log } from '../lib/logger';
import { round } from '../lib/money';
import { PAGE_LIMIT, paginate } from '../lib/pagination';
import { moveWallet } from './users';
import type {
  CommissionEntry,
  CommissionStatus,
  Creator,
  Order,
  OrderCreatorRef,
} from '../types/models';

/** Un porcentaje mayor que esto es con seguridad un error de tipeo. */
export const MAX_COMMISSION_PERCENT = 30;
export const MAX_CREATOR_DISCOUNT_PERCENT = 30;

const CODE_PATTERN = /^[A-Z0-9_-]{3,24}$/;

function commissions(uid: string) {
  return creators().doc(uid).collection('commissions');
}

function payouts(uid: string) {
  return creators().doc(uid).collection('payouts');
}

function toCreator(id: string, data: FirebaseFirestore.DocumentData): Creator {
  return { uid: id, ...data } as Creator;
}

export async function getCreator(uid: string): Promise<Creator | null> {
  const snap = await creators().doc(uid).get();
  return snap.exists ? toCreator(snap.id, snap.data() ?? {}) : null;
}

export async function requireCreator(uid: string): Promise<Creator> {
  const creator = await getCreator(uid);
  if (!creator) throw notFound('Este usuario no es creador de contenido.');
  return creator;
}

/**
 * Resuelve un código a su creador, o `null` si no existe.
 *
 * Devuelve `null` en vez de lanzar cuando el código no existe para que quien
 * llama decida: el checkout muestra un aviso, el despacho lo ignora.
 */
export async function resolveByCode(rawCode: string): Promise<Creator | null> {
  const code = normalizeCreatorCode(rawCode);
  if (!code) return null;

  const lock = await creatorCodes().doc(code).get();
  if (!lock.exists) return null;

  const uid = lock.data()?.uid as string | undefined;
  if (!uid) return null;

  return getCreator(uid);
}

/**
 * Valida un código en el momento de comprar y devuelve la referencia a congelar.
 *
 * Lanza con un mensaje dirigido al cliente: es el mismo trato que reciben los
 * cupones, y el checkout lo muestra tal cual.
 */
export async function resolveForPurchase(
  rawCode: string,
  buyerUid: string
): Promise<{ creator: Creator; ref: OrderCreatorRef }> {
  const creator = await resolveByCode(rawCode);
  if (!creator) throw invalidArgument('Ese código de creador no existe.');
  if (!creator.active) throw failedPrecondition('Ese código de creador ya no está activo.');

  // Sin esto el código sería un descuento personal permanente para el propio
  // creador, convertible en saldo gastable. Mismo criterio que los referidos.
  if (creator.uid === buyerUid) {
    throw failedPrecondition('No puedes usar tu propio código de creador.');
  }

  return {
    creator,
    ref: {
      uid: creator.uid,
      code: creator.code,
      // Se congela: subir la comisión mañana no debe recalcular lo ya vendido.
      commissionPercent: creator.commissionPercent,
    },
  };
}

// ---------------------------------------------------------------------------
// Alta y edición
// ---------------------------------------------------------------------------

export interface CreatorInput {
  code: string;
  active: boolean;
  commissionPercent: number;
  discountPercent: number;
  displayName: string | null;
  email: string | null;
  notes: string | null;
}

/**
 * Crea o actualiza un creador, tomando el código en exclusiva.
 *
 * El candado va en una transacción porque dos administradores asignando el
 * mismo código a la vez producirían dos creadores con el mismo código, y la
 * atribución acabaría en quien Firestore devolviera primero.
 */
export async function upsertCreator(uid: string, input: CreatorInput): Promise<Creator> {
  const code = normalizeCreatorCode(input.code);
  if (!CODE_PATTERN.test(code)) {
    throw invalidArgument(
      'El código debe tener entre 3 y 24 caracteres, sólo letras, números, guion o guion bajo.'
    );
  }
  if (input.commissionPercent < 0 || input.commissionPercent > MAX_COMMISSION_PERCENT) {
    throw invalidArgument(`La comisión va de 0% a ${MAX_COMMISSION_PERCENT}%.`);
  }
  if (input.discountPercent < 0 || input.discountPercent > MAX_CREATOR_DISCOUNT_PERCENT) {
    throw invalidArgument(`El descuento va de 0% a ${MAX_CREATOR_DISCOUNT_PERCENT}%.`);
  }

  const creatorRef = creators().doc(uid);
  const lockRef = creatorCodes().doc(code);

  await db.runTransaction(async (tx) => {
    const [existing, lock] = await Promise.all([tx.get(creatorRef), tx.get(lockRef)]);

    const lockOwner = lock.exists ? (lock.data()?.uid as string | undefined) : undefined;
    if (lockOwner && lockOwner !== uid) {
      throw failedPrecondition(`El código ${code} ya lo está usando otro creador.`);
    }

    const previousCode = existing.exists ? (existing.data()?.code as string | undefined) : undefined;

    tx.set(lockRef, { uid, updatedAt: now() });

    // El candado viejo se libera para que el código quede disponible otra vez.
    if (previousCode && previousCode !== code) {
      tx.delete(creatorCodes().doc(previousCode));
    }

    const base = {
      uid,
      code,
      active: input.active,
      commissionPercent: input.commissionPercent,
      discountPercent: input.discountPercent,
      displayName: input.displayName,
      email: input.email,
      notes: input.notes,
      updatedAt: now(),
    };

    if (existing.exists) {
      tx.set(creatorRef, base, { merge: true });
    } else {
      tx.set(creatorRef, {
        ...base,
        stats: { orders: 0, salesUsd: 0, pendingUsd: 0, paidUsd: 0, revertedUsd: 0 },
        createdAt: now(),
      });
    }
  });

  return requireCreator(uid);
}

/**
 * Da de baja a un creador sin borrarlo.
 *
 * Nunca se elimina el documento: su libro de comisiones es el respaldo de lo
 * que se le pagó, y el candado del código impide que otro lo herede y reciba
 * atribuciones de la audiencia del anterior.
 */
export async function deactivate(uid: string): Promise<Creator> {
  await requireCreator(uid);
  await creators().doc(uid).set({ active: false, updatedAt: now() }, { merge: true });
  return requireCreator(uid);
}

// ---------------------------------------------------------------------------
// Devengo
// ---------------------------------------------------------------------------

/** Base de cálculo de la comisión: lo que la tienda cobró por la orden. */
function saleBase(order: Order): number {
  return order.pricing.totalUsd;
}

/**
 * Registra la comisión de una orden completada.
 *
 * Idempotente por construcción: el asiento se guarda con el id de la orden y se
 * escribe con `create()`, así que un segundo intento falla en vez de pagar dos
 * veces. Hace falta de verdad: una orden puede llegar a completada por el
 * despacho automático y también a mano desde el panel.
 *
 * No lanza nunca hacia arriba. Se llama justo después de marcar la orden como
 * completada, y un fallo aquí no puede deshacer una recarga que el jugador ya
 * recibió: se deja constancia en el registro y queda para conciliar.
 */
export async function accrueCommission(order: Order): Promise<void> {
  const ref = order.creator;
  if (!ref) return;

  const saleUsd = round(saleBase(order), 2);
  const amountUsd = round((saleUsd * ref.commissionPercent) / 100, 2);
  if (amountUsd <= 0) return;

  try {
    await db.runTransaction(async (tx) => {
      const entryRef = commissions(ref.uid).doc(order.id);
      const existing = await tx.get(entryRef);
      if (existing.exists) return; // Ya devengada: no se toca.

      const entry: CommissionEntry = {
        orderId: order.id,
        orderCode: order.code,
        status: 'pending',
        saleUsd,
        percent: ref.commissionPercent,
        amountUsd,
        gameId: order.gameId,
        gameName: order.gameName,
        productName: order.productName,
        payoutId: null,
        createdAt: now(),
        updatedAt: now(),
      };

      tx.create(entryRef, entry);
      tx.set(
        creators().doc(ref.uid),
        {
          stats: {
            orders: FieldValue.increment(1),
            salesUsd: FieldValue.increment(saleUsd),
            pendingUsd: FieldValue.increment(amountUsd),
          },
          updatedAt: now(),
        },
        { merge: true }
      );
    });

    log.info('Comisión de creador devengada', {
      creator: ref.uid,
      order: order.code,
      amountUsd,
    });
  } catch (error) {
    log.error('No se pudo devengar la comisión del creador', {
      creator: ref.uid,
      order: order.code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Anula la comisión de una orden reembolsada.
 *
 * Si todavía estaba pendiente, se descuenta del pendiente y se marca anulada.
 * Si ya se le pagó, **no se le quita el dinero de la cartera**: debitar podría
 * fallar por saldo insuficiente y dejar el libro y el saldo en desacuerdo. En
 * su lugar el importe queda como pendiente negativo y se compensa contra la
 * siguiente liquidación, que es como funciona una devolución entre socios.
 */
export async function revertCommission(order: Order): Promise<void> {
  const ref = order.creator;
  if (!ref) return;

  try {
    await db.runTransaction(async (tx) => {
      const entryRef = commissions(ref.uid).doc(order.id);
      const snap = await tx.get(entryRef);
      if (!snap.exists) return;

      const entry = snap.data() as CommissionEntry;
      if (entry.status === 'reverted') return; // Ya anulada.

      tx.set(entryRef, { status: 'reverted', updatedAt: now() }, { merge: true });
      tx.set(
        creators().doc(ref.uid),
        {
          stats: {
            orders: FieldValue.increment(-1),
            salesUsd: FieldValue.increment(-entry.saleUsd),
            pendingUsd: FieldValue.increment(-entry.amountUsd),
            revertedUsd: FieldValue.increment(entry.amountUsd),
          },
          updatedAt: now(),
        },
        { merge: true }
      );
    });

    log.info('Comisión de creador anulada por reembolso', {
      creator: ref.uid,
      order: order.code,
    });
  } catch (error) {
    log.error('No se pudo anular la comisión del creador', {
      creator: ref.uid,
      order: order.code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Liquidación
// ---------------------------------------------------------------------------

/** Tope de asientos por liquidación: una transacción de Firestore admite 500 escrituras. */
const PAYOUT_BATCH = 300;

export interface PayoutResult {
  payoutId: string;
  amountUsd: number;
  entries: number;
  /** Quedan asientos sin liquidar: hay que repetir la operación. */
  hasMore: boolean;
}

/**
 * Paga al creador su comisión pendiente, acreditándola en su cartera.
 *
 * Se marca cada asiento antes de mover el dinero, dentro de la misma
 * transacción, para que un fallo no deje pagos sin registrar. El saldo entra en
 * la cartera con `moveWallet`, que es donde el creador ya sabe mirar.
 */
export async function payPending(
  uid: string,
  options: { actorUid: string | null }
): Promise<PayoutResult> {
  const creator = await requireCreator(uid);

  const pending = await commissions(uid)
    .where('status', '==', 'pending')
    .limit(PAYOUT_BATCH + 1)
    .get();

  const hasMore = pending.size > PAYOUT_BATCH;
  const docs = hasMore ? pending.docs.slice(0, PAYOUT_BATCH) : pending.docs;

  if (docs.length === 0) throw failedPrecondition('Este creador no tiene comisiones pendientes.');

  const amountUsd = round(
    docs.reduce((total, doc) => total + ((doc.data() as CommissionEntry).amountUsd ?? 0), 0),
    2
  );
  if (amountUsd <= 0) throw failedPrecondition('El monto pendiente no es pagable.');

  const payoutRef = payouts(uid).doc();

  await db.runTransaction(async (tx: Transaction) => {
    tx.set(payoutRef, {
      id: payoutRef.id,
      amountUsd,
      entries: docs.length,
      actorUid: options.actorUid,
      createdAt: now(),
    });

    for (const doc of docs) {
      tx.set(
        doc.ref,
        { status: 'paid' as CommissionStatus, payoutId: payoutRef.id, updatedAt: now() },
        { merge: true }
      );
    }

    tx.set(
      creators().doc(uid),
      {
        stats: {
          pendingUsd: FieldValue.increment(-amountUsd),
          paidUsd: FieldValue.increment(amountUsd),
        },
        updatedAt: now(),
      },
      { merge: true }
    );
  });

  await moveWallet({
    uid,
    deltaUsd: amountUsd,
    reason: `Comisiones de creador (${docs.length} venta/s)`,
    actorUid: options.actorUid,
  });

  log.info('Comisiones de creador liquidadas', { creator: uid, amountUsd, code: creator.code });

  return { payoutId: payoutRef.id, amountUsd, entries: docs.length, hasMore };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export async function listCommissions(
  uid: string,
  options: { limit: number; cursor?: string; status?: CommissionStatus }
) {
  const base = options.status
    ? commissions(uid).where('status', '==', options.status)
    : commissions(uid);

  return paginate(
    base,
    { orderBy: 'createdAt', limit: options.limit, cursor: options.cursor, withTotal: true },
    (id, data) => ({ ...(data as CommissionEntry), orderId: id })
  );
}

export async function listCreators(options: { limit: number; cursor?: string }) {
  return paginate(
    creators(),
    { orderBy: 'createdAt', limit: options.limit, cursor: options.cursor, withTotal: true },
    toCreator
  );
}

export { PAGE_LIMIT };
