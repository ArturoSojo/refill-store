/**
 * Historial de una orden (`orders/{id}/events`).
 *
 * Vive en su propio módulo para que `dispatch` y `orders` puedan escribir
 * eventos sin depender el uno del otro.
 */
import { orders, now } from '../config/firebase';
import { log } from '../lib/logger';
import type { OrderEvent, OrderStatus } from '../types/models';

export interface AddEventInput {
  orderId: string;
  type: string;
  message: string;
  status?: OrderStatus | null;
  actor?: OrderEvent['actor'];
  actorUid?: string | null;
  data?: Record<string, unknown> | null;
}

/** Nunca lanza: el historial es informativo, no debe romper el flujo de compra. */
export async function addEvent(input: AddEventInput): Promise<void> {
  try {
    await orders()
      .doc(input.orderId)
      .collection('events')
      .add({
        type: input.type,
        message: input.message,
        status: input.status ?? null,
        actor: input.actor ?? 'system',
        actorUid: input.actorUid ?? null,
        data: input.data ?? null,
        createdAt: now(),
      });
  } catch (error) {
    log.warn('No se pudo registrar el evento de la orden', {
      orderId: input.orderId,
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function listEvents(orderId: string): Promise<OrderEvent[]> {
  const snap = await orders()
    .doc(orderId)
    .collection('events')
    .orderBy('createdAt', 'asc')
    .limit(100)
    .get();

  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as OrderEvent);
}
