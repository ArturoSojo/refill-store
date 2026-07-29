/**
 * Límite de peticiones con ventana fija, respaldado por Firestore.
 *
 * Cloud Functions escala a muchas instancias, así que un contador en memoria no
 * sirve: se comparte el estado en `rateLimits/{clave}`. La transacción garantiza
 * que dos instancias concurrentes no se pisen el contador.
 *
 * Se aplica sobre todo a `verify`, que es el endpoint que golpea a Pabilo y el
 * que un atacante intentaría usar para probar referencias ajenas por fuerza bruta.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { db, rateLimits, Timestamp } from '../config/firebase';
import { rateLimited } from '../lib/errors';
import { clientIp } from '../lib/http';
import { log } from '../lib/logger';

export interface RateLimitOptions {
  /** Identificador del límite; entra en la clave del documento. */
  name: string;
  /** Peticiones permitidas dentro de la ventana. */
  max: number;
  windowSeconds: number;
  /** Por defecto: uid si hay sesión, si no la IP. */
  keyResolver?: (req: Request) => string;
  message?: string;
}

function defaultKey(req: Request): string {
  return req.user?.uid ?? clientIp(req) ?? 'anon';
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { name, max, windowSeconds, keyResolver = defaultKey, message } = options;

  return async (req: Request, _res: Response, next: NextFunction) => {
    const rawKey = keyResolver(req);
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const docId = `${name}__${rawKey.replace(/[^\w.-]/g, '_')}__${bucket}`;
    const ref = rateLimits().doc(docId);

    try {
      const allowed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const count = snap.exists ? ((snap.data()?.count as number) ?? 0) : 0;

        if (count >= max) return false;

        tx.set(
          ref,
          {
            count: count + 1,
            name,
            key: rawKey,
            // TTL de Firestore puede limpiar estos documentos automáticamente
            // si configuras la política sobre el campo `expiresAt`.
            expiresAt: Timestamp.fromMillis((bucket + 2) * windowSeconds * 1000),
          },
          { merge: true }
        );
        return true;
      });

      if (!allowed) {
        return next(rateLimited(message));
      }
      return next();
    } catch (error) {
      // Si Firestore falla no bloqueamos la compra: se registra y se sigue.
      log.warn('No se pudo aplicar el rate limit', {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
      return next();
    }
  };
}
