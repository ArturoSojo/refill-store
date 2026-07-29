/**
 * Autenticación y autorización.
 *
 * El frontend manda el ID token de Firebase en `Authorization: Bearer <token>`.
 * El rol vive en los custom claims del token, no en Firestore: así no se puede
 * escalar privilegios escribiendo en el propio documento de usuario.
 */
import type { Request, Response, NextFunction } from 'express';
import { auth } from '../config/firebase';
import { forbidden, unauthenticated } from '../lib/errors';
import { log } from '../lib/logger';
import type { UserRole } from '../types/models';

export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  photoURL: string | null;
  role: UserRole;
  isAdmin: boolean;
  isStaff: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim() || null;
  }
  return null;
}

async function resolveUser(token: string): Promise<AuthUser> {
  // `checkRevoked = true` hace que un usuario baneado (cuyas sesiones
  // revocamos) pierda el acceso de inmediato, no cuando expire el token.
  const decoded = await auth.verifyIdToken(token, true);
  const isAdmin = decoded.admin === true;
  const isStaff = isAdmin || decoded.staff === true;

  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    emailVerified: decoded.email_verified === true,
    displayName: (decoded.name as string | undefined) ?? null,
    photoURL: (decoded.picture as string | undefined) ?? null,
    role: isAdmin ? 'admin' : isStaff ? 'staff' : 'user',
    isAdmin,
    isStaff,
  };
}

/** Adjunta `req.user` si hay token válido; nunca falla. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next();

  try {
    req.user = await resolveUser(token);
  } catch (error) {
    log.debug('Token opcional inválido, se continúa como anónimo', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return next();
}

/** Exige sesión iniciada. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next(unauthenticated('Inicia sesión con Google para continuar.'));

  try {
    req.user = await resolveUser(token);
    return next();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('revoked') || message.includes('disabled')) {
      return next(unauthenticated('Tu sesión fue cerrada. Vuelve a iniciar sesión.'));
    }
    return next(unauthenticated('Tu sesión expiró. Vuelve a iniciar sesión.'));
  }
}

/** Exige rol staff o admin. */
export function requireStaff(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthenticated());
  if (!req.user.isStaff) return next(forbidden('Necesitas permisos de staff.'));
  return next();
}

/** Exige rol admin. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthenticated());
  if (!req.user.isAdmin) return next(forbidden('Necesitas permisos de administrador.'));
  return next();
}

/** Acceso seguro a `req.user` en handlers que ya pasaron por `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
