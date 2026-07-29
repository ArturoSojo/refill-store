/**
 * Rutas de arranque, para dejar la tienda operativa la primera vez.
 *
 * Están protegidas por `SETUP_TOKEN` (un secreto de Secret Manager). Si el
 * secreto no está definido, estas rutas quedan cerradas.
 *
 *   firebase functions:secrets:set SETUP_TOKEN
 *   curl -X POST https://<host>/api/setup/bootstrap \
 *        -H "Content-Type: application/json" \
 *        -d '{"token":"<SETUP_TOKEN>","email":"tucorreo@gmail.com"}'
 *
 * Una vez tengas tu primer administrador, borra el secreto:
 *   firebase functions:secrets:destroy SETUP_TOKEN
 */
import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../config/firebase';
import { SETUP_TOKEN } from '../config/env';
import { asyncHandler, clientIp, ok, parseBody } from '../lib/http';
import { forbidden, notFound } from '../lib/errors';
import { rateLimit } from '../middleware/rateLimit';
import * as usersService from '../services/users';
import * as audit from '../services/audit';
import { ensureConfig } from '../services/settings';
import { seedCatalog } from '../seed/catalog.seed';

export const setupRouter = Router();

// Ventana estrecha: estas rutas conceden privilegios de administrador.
setupRouter.use(
  rateLimit({
    name: 'setup',
    max: 8,
    windowSeconds: 600,
    keyResolver: (req) => clientIp(req) ?? 'anon',
    message: 'Demasiados intentos de configuración inicial.',
  })
);

function assertSetupToken(token: string) {
  const expected = SETUP_TOKEN.value();
  if (!expected) {
    throw forbidden('La configuración inicial está deshabilitada (SETUP_TOKEN no definido).');
  }
  if (token !== expected) {
    throw forbidden('Token de configuración inválido.');
  }
}

const bootstrapSchema = z.object({
  token: z.string().min(8),
  email: z.string().email(),
  /**
   * Si se envía, la cuenta se crea (o se le fija esa contraseña) para poder
   * entrar con correo y contraseña sin depender de Google.
   */
  password: z.string().min(8).max(72).optional(),
  displayName: z.string().trim().max(60).optional(),
  seed: z.boolean().default(true),
});

/**
 * Deja la tienda lista: crea `config/app`, siembra el catálogo del documento
 * técnico y convierte en administrador a la cuenta indicada.
 *
 * Si se pasa `password`, la cuenta se crea aunque no exista todavía. Si no,
 * la cuenta debe existir ya (basta con haber entrado una vez con Google).
 */
setupRouter.post(
  '/bootstrap',
  asyncHandler(async (req, res) => {
    const body = parseBody(req, bootstrapSchema);
    assertSetupToken(body.token);

    await ensureConfig();

    let userRecord;
    let created = false;

    try {
      userRecord = await auth.getUserByEmail(body.email);

      // La cuenta ya existía: si mandaron contraseña, se le asigna para que
      // también pueda entrar sin Google.
      if (body.password) {
        userRecord = await auth.updateUser(userRecord.uid, {
          password: body.password,
          emailVerified: true,
        });
      }
    } catch {
      if (!body.password) {
        throw notFound(
          `No existe una cuenta con ${body.email}. Inicia sesión con Google en la web una vez, o vuelve a ejecutar esto pasando también una contraseña.`
        );
      }

      userRecord = await auth.createUser({
        email: body.email,
        password: body.password,
        displayName: body.displayName ?? 'Administrador',
        emailVerified: true,
      });
      created = true;
    }

    await usersService.setRole(userRecord.uid, 'admin');
    await usersService.ensureProfile({
      uid: userRecord.uid,
      email: userRecord.email ?? body.email,
      emailVerified: true,
      displayName: userRecord.displayName ?? body.displayName ?? 'Administrador',
      photoURL: userRecord.photoURL ?? null,
      role: 'admin',
      isAdmin: true,
      isStaff: true,
    });

    const seedResult = body.seed ? await seedCatalog() : null;

    await audit.record({
      action: audit.ACTIONS.SETUP_ADMIN_GRANTED,
      actorUid: userRecord.uid,
      actorEmail: body.email,
      targetType: 'user',
      targetId: userRecord.uid,
      summary: `Configuración inicial: ${body.email} es administrador${created ? ' (cuenta creada)' : ''}.`,
      ip: clientIp(req),
    });

    ok(res, {
      admin: { uid: userRecord.uid, email: body.email, created },
      seed: seedResult,
      message: created
        ? 'Cuenta de administrador creada. Ya puedes entrar con ese correo y contraseña.'
        : 'Listo. Cierra sesión y vuelve a entrar para que tu token recoja el rol de administrador.',
    });
  })
);

/** Sólo siembra el catálogo, sin tocar roles. */
setupRouter.post(
  '/seed',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({ token: z.string().min(8), overwritePrices: z.boolean().default(false) })
    );
    assertSetupToken(body.token);

    await ensureConfig();
    ok(res, await seedCatalog({ overwritePrices: body.overwritePrices }));
  })
);
