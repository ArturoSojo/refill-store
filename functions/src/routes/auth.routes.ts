import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, clientIp, ok, parseBody } from '../lib/http';
import { log } from '../lib/logger';
import { rateLimit } from '../middleware/rateLimit';
import { sendPasswordReset } from '../services/passwordReset';

export const authRouter = Router();

const requestSchema = z.object({
  email: z.string().trim().email().max(254),
  client: z.enum(['app', 'web']).default('web'),
});

const byIp = rateLimit({
  name: 'password_reset_ip',
  max: 10,
  windowSeconds: 900,
  keyResolver: (req) => clientIp(req) ?? 'anon',
  message: 'Se hicieron muchas solicitudes. Espera un rato e intenta de nuevo.',
});

const byEmail = rateLimit({
  name: 'password_reset_email',
  max: 3,
  windowSeconds: 3600,
  keyResolver: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return createHash('sha256').update(email).digest('hex').slice(0, 32);
  },
  message: 'Ya se enviaron varios enlaces a ese correo. Revisa tu bandeja o intenta más tarde.',
});

authRouter.post(
  '/password-reset',
  byIp,
  byEmail,
  asyncHandler(async (req, res) => {
    const { email, client } = parseBody(req, requestSchema);

    try {
      await sendPasswordReset(email, client, req.get('origin'));
    } catch (error) {
      // Misma respuesta para correo inexistente, fallo de entrega o error de Firebase.
      log.warn('Solicitud de restablecimiento no completada', {
        reason: error instanceof Error ? error.message : 'error desconocido',
      });
    }

    ok(res, {
      message: 'Si el correo está asociado a una cuenta, recibirás instrucciones para restablecer la contraseña.',
    });
  })
);
