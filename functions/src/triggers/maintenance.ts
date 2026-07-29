/** Tareas de limpieza que corren en las funciones programadas. */
import { db, rateLimits, now } from '../config/firebase';
import { log } from '../lib/logger';

/**
 * Borra los contadores de rate limit ya vencidos.
 *
 * Si activas una política de TTL de Firestore sobre el campo `expiresAt` de
 * `rateLimits`, esto deja de ser necesario. Mientras tanto evita que la
 * colección crezca sin control.
 */
export async function cleanupRateLimits(limit = 400): Promise<number> {
  const snap = await rateLimits().where('expiresAt', '<', now()).limit(limit).get();
  if (snap.empty) return 0;

  const batch = db.batch();
  snap.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  log.debug('Contadores de rate limit eliminados', { count: snap.size });
  return snap.size;
}
