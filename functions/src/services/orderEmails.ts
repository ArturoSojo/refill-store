/**
 * Decide cuándo escribirle al cliente y con qué.
 *
 * Separado del transporte (`email.ts`) y de las plantillas
 * (`emailTemplates.ts`): aquí sólo viven las reglas de negocio —si toca enviar,
 * a quién, y que no se envíe dos veces—.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { db, orders, games } from '../config/firebase';
import { log } from '../lib/logger';
import { send } from './email';
import { renderOrderEmail, type EmailKind } from './emailTemplates';
import { resolvePlayerFields } from './catalog';
import { getConfig } from './settings';
import * as usersService from './users';
import type { Game, Order } from '../types/models';

/** Interruptor del panel que gobierna cada tipo de correo. */
const INTERRUPTOR: Record<EmailKind, 'onPaymentVerified' | 'onDelivered' | 'onDispatchFailed'> = {
  payment_verified: 'onPaymentVerified',
  delivered: 'onDelivered',
  dispatch_failed: 'onDispatchFailed',
};

/**
 * Reserva el envío antes de mandarlo.
 *
 * Se marca primero y se envía después, no al revés: ante dos ejecuciones a la
 * vez —el despacho automático y un reintento del panel, por ejemplo— es
 * preferible perder un correo que mandarle al cliente dos comprobantes de la
 * misma compra. Si el envío falla, la marca se retira para poder reintentarlo.
 */
async function claim(orderId: string, kind: EmailKind): Promise<boolean> {
  const ref = orders().doc(orderId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;

    const yaEnviados = (snap.get('emailsSent') as string[] | undefined) ?? [];
    if (yaEnviados.includes(kind)) return false;

    tx.set(ref, { emailsSent: FieldValue.arrayUnion(kind) }, { merge: true });
    return true;
  });
}

async function release(orderId: string, kind: EmailKind): Promise<void> {
  await orders()
    .doc(orderId)
    .set({ emailsSent: FieldValue.arrayRemove(kind) }, { merge: true })
    .catch(() => undefined);
}

/**
 * Envía el correo que corresponde al estado de la orden. Nunca lanza.
 *
 * Se llama sin esperar el resultado: el cliente no debe quedarse mirando una
 * pantalla de carga porque el SMTP de Gmail tardó dos segundos.
 */
export async function sendOrderEmail(kind: EmailKind, orderId: string): Promise<void> {
  try {
    const config = await getConfig();
    if (config.email?.enabled === false) return;
    if (config.email?.[INTERRUPTOR[kind]] === false) return;

    const snap = await orders().doc(orderId).get();
    if (!snap.exists) return;

    const order = { id: snap.id, ...snap.data() } as Order;

    const destinatario = order.user?.email;
    if (!destinatario) return;

    // El cliente puede haber apagado los avisos de sus órdenes en su perfil.
    const profile = await usersService.getProfileOrNull(order.uid);
    if (profile && profile.preferences?.notifyOrderUpdates === false) return;

    if (!(await claim(orderId, kind))) return;

    // Las etiquetas reales de cada campo del juego («Zone ID», no `zoneId`).
    const gameSnap = await games().doc(order.gameId).get();
    const playerFields = gameSnap.exists
      ? resolvePlayerFields({ id: gameSnap.id, ...gameSnap.data() } as Game)
      : [];

    const rendered = renderOrderEmail(kind, order, config, playerFields);
    const result = await send({ to: destinatario, ...rendered });

    if (!result.sent) {
      await release(orderId, kind);
      log.warn('Correo de orden no enviado', { orderId, kind, reason: result.reason });
    }
  } catch (error) {
    log.warn('Fallo al preparar el correo de la orden', {
      orderId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    await release(orderId, kind);
  }
}
