/** Notificaciones in-app (`users/{uid}/notifications`). */
import { users, now } from '../config/firebase';
import { log } from '../lib/logger';
import type { UserNotification } from '../types/models';

export interface NotifyInput {
  uid: string;
  title: string;
  body: string;
  type?: UserNotification['type'];
  link?: string | null;
}

/** Nunca lanza: una notificación perdida no debe abortar una compra. */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    await users()
      .doc(input.uid)
      .collection('notifications')
      .add({
        title: input.title,
        body: input.body,
        type: input.type ?? 'system',
        link: input.link ?? null,
        read: false,
        readAt: null,
        createdAt: now(),
      });
  } catch (error) {
    log.warn('No se pudo crear la notificación', {
      uid: input.uid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Envía la misma notificación a varios usuarios (anuncios del panel). */
export async function notifyMany(uids: string[], payload: Omit<NotifyInput, 'uid'>) {
  await Promise.all(uids.map((uid) => notify({ ...payload, uid })));
}

export async function markAllRead(uid: string): Promise<number> {
  const snap = await users()
    .doc(uid)
    .collection('notifications')
    .where('read', '==', false)
    .limit(400)
    .get();

  if (snap.empty) return 0;

  const batch = snap.docs[0].ref.firestore.batch();
  const timestamp = now();
  snap.docs.forEach((doc) => batch.update(doc.ref, { read: true, readAt: timestamp }));
  await batch.commit();
  return snap.size;
}
