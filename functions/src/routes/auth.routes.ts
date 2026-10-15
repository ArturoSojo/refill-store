import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { users } from '../config/firebase';
import { asyncHandler, clientIp, ok, parseBody } from '../lib/http';
import { log } from '../lib/logger';
import { maskEmail, normalizePhone } from '../lib/phone';
import { rateLimit } from '../middleware/rateLimit';
import { sendPasswordReset } from '../services/passwordReset';

export const authRouter = Router();

const resolvePhoneSchema = z.object({
  phone: z.string().trim().min(5).max(30),
});

const resolvePhoneIp = rateLimit({
  name: 'resolve_phone_ip',
  max: 30,
  windowSeconds: 900,
  keyResolver: (req) => clientIp(req) ?? 'anon',
  message: 'Demasiadas consultas de teléfono. Espera unos minutos.',
});

authRouter.post(
  '/resolve-phone',
  resolvePhoneIp,
  asyncHandler(async (req, res) => {
    const { phone } = parseBody(req, resolvePhoneSchema);
    const normalized = normalizePhone(phone);
    if (!normalized) {
      ok(res, { exists: false, email: null, maskedEmail: null });
      return;
    }

    let snap = await users().where('phone', '==', normalized).limit(1).get();

    if (snap.empty && normalized.startsWith('+58')) {
      const local = '0' + normalized.slice(3);
      snap = await users().where('phone', '==', local).limit(1).get();
    }

    if (snap.empty) {
      ok(res, { exists: false, email: null, maskedEmail: null });
      return;
    }

    const userData = snap.docs[0].data();
    const email = userData.email || null;
    if (!email) {
      ok(res, { exists: false, email: null, maskedEmail: null });
      return;
    }

    ok(res, {
      exists: true,
      email,
      maskedEmail: maskEmail(email),
    });
  })
);

const requestSchema = z.object({
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(30).optional(),
  identifier: z.string().trim().max(254).optional(),
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
    const raw = typeof req.body?.email === 'string'
      ? req.body.email
      : typeof req.body?.identifier === 'string'
        ? req.body.identifier
        : '';
    const key = raw.trim().toLowerCase();
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
  },
  message: 'Ya se enviaron varios enlaces a ese correo. Revisa tu bandeja o intenta más tarde.',
});

authRouter.post(
  '/password-reset',
  byIp,
  byEmail,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, requestSchema);
    let targetEmail: string | null = null;

    const input = (body.identifier || body.email || '').trim();

    if (input.includes('@')) {
      targetEmail = input;
    } else {
      const phoneInput = (body.phone || input).trim();
      const normalized = normalizePhone(phoneInput);
      if (normalized) {
        let snap = await users().where('phone', '==', normalized).limit(1).get();
        if (snap.empty && normalized.startsWith('+58')) {
          const local = '0' + normalized.slice(3);
          snap = await users().where('phone', '==', local).limit(1).get();
        }
        if (!snap.empty) {
          targetEmail = snap.docs[0].data().email || null;
        }
      }
    }

    if (targetEmail) {
      try {
        await sendPasswordReset(targetEmail, body.client, req.get('origin'));
      } catch (error) {
        log.warn('Solicitud de restablecimiento no completada', {
          reason: error instanceof Error ? error.message : 'error desconocido',
        });
      }
    }

    ok(res, {
      message: 'Si la cuenta existe, recibirás instrucciones para restablecer la contraseña.',
      maskedEmail: targetEmail ? maskEmail(targetEmail) : null,
    });
  })
);
