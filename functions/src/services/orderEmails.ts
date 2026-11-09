/**
 * Decide cuándo escribirle al cliente y con qué.
 *
 * Separado del transporte (`email.ts`) y de las plantillas
 * (`emailTemplates.ts`): aquí sólo viven las reglas de negocio —si toca enviar,
 * a quién, y que no se envíe dos veces—.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { auth, db, orders, games, now } from '../config/firebase';
import { log } from '../lib/logger';
import { ADMIN_EMAIL, DEFAULT_REPLY_TO, SALES_FROM, send } from './email';
import { renderOrderEmail, type EmailKind } from './emailTemplates';
import { resolvePlayerFields } from './catalog';
import { getConfig } from './settings';
import * as usersService from './users';
import type { Game, Order, UserProfile } from '../types/models';

/** Interruptor del panel que gobierna cada tipo de correo. */
const INTERRUPTOR: Record<EmailKind, 'onPaymentVerified' | 'onDelivered' | 'onDispatchFailed'> = {
  payment_verified: 'onPaymentVerified',
  delivered: 'onDelivered',
  dispatch_failed: 'onDispatchFailed',
};

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.trim().includes('@') && value.trim().length >= 5;
}

/**
 * Obtiene siempre el correo real del comprador revisando el payload de la orden,
 * el documento `users/{uid}` en Firestore y Firebase Auth si no vino en la orden.
 */
async function resolveCustomerEmail(
  order: Order
): Promise<{ email: string | null; profile: UserProfile | null; fromFallback: boolean }> {
  const rawOrder = order as unknown as Record<string, unknown>;
  const directCandidates = [
    order.user?.email,
    rawOrder.userEmail,
    rawOrder.customerEmail,
    rawOrder.email,
    rawOrder.clienteContacto,
  ];

  let resolvedEmail: string | null = null;
  let fromFallback = false;

  for (const candidate of directCandidates) {
    if (isValidEmail(candidate)) {
      resolvedEmail = candidate.trim();
      fromFallback = candidate !== order.user?.email;
      break;
    }
  }

  const uid = (order.uid || '').trim();
  const isGuestUid = !uid || uid.startsWith('whatsapp:') || uid === 'guest';
  const profile = !isGuestUid ? await usersService.getProfileOrNull(uid) : null;

  if (!resolvedEmail && isValidEmail(profile?.email)) {
    resolvedEmail = profile.email.trim();
    fromFallback = true;
  }

  if (!resolvedEmail && !isGuestUid) {
    try {
      const authUser = await auth.getUser(uid);
      if (isValidEmail(authUser.email)) {
        resolvedEmail = authUser.email.trim();
        fromFallback = true;
      }
    } catch {
      // El usuario puede no existir en Firebase Auth si fue importado externamente.
    }
  }

  return { email: resolvedEmail, profile, fromFallback };
}

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

    const rawEnviados = snap.get('emailsSent');
    const yaEnviados = Array.isArray(rawEnviados) ? (rawEnviados as string[]) : [];
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

async function recordOrderEmailDiagnostics(
  orderId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await orders()
    .doc(orderId)
    .set(patch, { merge: true })
    .catch(() => undefined);
}

/**
 * Envía el correo que corresponde al estado de la orden al cliente y una copia
 * independiente al administrador (`soporterefillstore@gmail.com`). Nunca lanza.
 */
export async function sendOrderEmail(kind: EmailKind, orderId: string): Promise<void> {
  try {
    const config = await getConfig();
    if (config.email?.enabled === false) return;
    if (config.email?.[INTERRUPTOR[kind]] === false) return;

    const snap = await orders().doc(orderId).get();
    if (!snap.exists) return;

    const order = { id: snap.id, ...snap.data() } as Order;
    const { email: destinatario, profile, fromFallback } = await resolveCustomerEmail(order);

    if (!destinatario) {
      log.warn('Orden sin correo de cliente para enviar notificación', {
        orderId,
        code: order.code,
        uid: order.uid,
        kind,
      });
      await recordOrderEmailDiagnostics(orderId, {
        lastEmailError: `Sin correo de comprador para enviar '${kind}'`,
        lastEmailErrorAt: now(),
      });
      return;
    }

    if (fromFallback) {
      order.user = {
        email: destinatario,
        displayName: order.user?.displayName ?? profile?.displayName ?? null,
        photoURL: order.user?.photoURL ?? profile?.photoURL ?? null,
      };
      await recordOrderEmailDiagnostics(orderId, {
        'user.email': destinatario,
      });
    }

    // El cliente puede haber apagado los avisos de sus órdenes en su perfil.
    const skipCustomerByPreference = profile?.preferences?.notifyOrderUpdates === false;

    if (!(await claim(orderId, kind))) return;

    // Las etiquetas reales de cada campo del juego («Zone ID», no `zoneId`).
    const gameSnap = await games().doc(order.gameId).get();
    const playerFields = gameSnap.exists
      ? resolvePlayerFields({ id: gameSnap.id, ...gameSnap.data() } as Game)
      : [];

    const rendered = renderOrderEmail(kind, order, config, playerFields);

    const customerPromise = skipCustomerByPreference
      ? Promise.resolve({ sent: true, reason: null, messageId: 'skipped-by-user-preference' })
      : send({
          to: destinatario,
          from: SALES_FROM,
          replyTo: DEFAULT_REPLY_TO,
          ...rendered,
        });

    const adminSubject = `[Copia Admin] ${rendered.subject} · Cliente: ${destinatario}`;
    const adminPromise = send({
      to: ADMIN_EMAIL,
      from: SALES_FROM,
      replyTo: destinatario || DEFAULT_REPLY_TO,
      subject: adminSubject,
      text: `Notificación administrativa de orden (${kind})\nCliente: ${destinatario}\n\n${rendered.text}`,
      html: rendered.html,
    });

    const [customerSettled, adminSettled] = await Promise.allSettled([
      customerPromise,
      adminPromise,
    ]);

    const customerResult =
      customerSettled.status === 'fulfilled'
        ? customerSettled.value
        : {
            sent: false,
            reason:
              customerSettled.reason instanceof Error
                ? customerSettled.reason.message
                : String(customerSettled.reason),
            messageId: null,
          };

    if (adminSettled.status === 'rejected' || !adminSettled.value.sent) {
      const adminReason =
        adminSettled.status === 'rejected'
          ? String(adminSettled.reason)
          : adminSettled.value.reason;
      log.warn('No se pudo enviar copia de correo de orden al admin', {
        orderId,
        kind,
        reason: adminReason,
      });
    }

    if (!customerResult.sent) {
      await release(orderId, kind);
      await recordOrderEmailDiagnostics(orderId, {
        lastEmailError: customerResult.reason ?? 'Error desconocido al enviar correo',
        lastEmailErrorAt: now(),
      });
      log.warn('Correo de orden no enviado al cliente', {
        orderId,
        kind,
        to: destinatario,
        reason: customerResult.reason,
      });
      return;
    }

    await recordOrderEmailDiagnostics(orderId, {
      lastEmailError: null,
      lastEmailSentAt: now(),
      lastEmailMessageId: customerResult.messageId ?? null,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[Email Error] orderId: ${orderId} kind: ${kind} error: ${reason}`);
    log.warn('Fallo al preparar el correo de la orden', {
      orderId,
      kind,
      error: reason,
    });
    await release(orderId, kind);
    await recordOrderEmailDiagnostics(orderId, {
      lastEmailError: reason,
      lastEmailErrorAt: now(),
    });
  }
}
