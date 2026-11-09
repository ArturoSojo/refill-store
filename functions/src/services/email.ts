/**
 * Envío de correo al cliente vía Resend SMTP (`smtp.resend.com`).
 *
 * Todo el trato con `nodemailer` vive AQUÍ. El resto del código llama a `send()`
 * y no sabe por dónde sale.
 *
 * Ninguna función lanza: que un correo no salga no puede tumbar una compra que
 * por lo demás terminó bien.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { RESEND_API_KEY } from '../config/env';
import { log } from '../lib/logger';
import { getConfig } from './settings';
import type { AppConfig } from '../types/models';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Versión en texto plano. Su ausencia penaliza en los filtros de spam. */
  text: string;
  /** Remitente personalizado (por defecto Refill Store <ventas@recargasrefillstore.com>). */
  from?: string;
  /** Dirección a la que llegan las respuestas (por defecto soporte@recargasrefillstore.com). */
  replyTo?: string;
}

/**
 * El transporte se guarda entre invocaciones.
 *
 * Crear uno por correo abriría una conexión TLS nueva cada vez; reutilizarlo
 * aprovecha que las instancias de Cloud Functions se reciclan.
 */
let cached: { transporter: Transporter; pass: string } | null = null;

export const SALES_FROM = 'Refill Store <ventas@recargasrefillstore.com>';
export const SUPPORT_FROM = 'Refill Store <soporte@recargasrefillstore.com>';
export const ADMIN_EMAIL = 'soporterefillstore@gmail.com';
export const DEFAULT_REPLY_TO = 'soporte@recargasrefillstore.com';

/**
 * Garantiza que NINGÚN correo salga con @gmail.com, onboarding@resend.dev
 * ni ningún dominio distinto a @recargasrefillstore.com.
 */
export function resolveVerifiedFrom(requestedFrom?: string | null): string {
  const raw = (requestedFrom ?? '').trim();
  if (!raw) return SALES_FROM;

  const lower = raw.toLowerCase();
  if (lower.includes('soporte@recargasrefillstore.com')) {
    return SUPPORT_FROM;
  }
  if (lower.includes('ventas@recargasrefillstore.com')) {
    return SALES_FROM;
  }
  // Cualquier otro remitente (ej. soporterefillstore@gmail.com u onboarding@resend.dev)
  // se fuerza siempre a ventas@recargasrefillstore.com.
  return SALES_FROM;
}

function getResendApiKey(): string {
  try {
    const val = RESEND_API_KEY.value();
    if (val && val.trim().length > 0) return val.trim();
  } catch {
    // Fallback a process.env en caso de entorno local
  }
  const envKey = (process.env.RESEND_API_KEY || process.env.SMTP_PASS || '').trim();
  return envKey;
}

function getTransporter(): Transporter | null {
  const pass = getResendApiKey();
  if (!pass) return null;

  if (cached && cached.pass === pass) return cached.transporter;

  const transporter = nodemailer.createTransport({
    host: 'smtp.resend.com',
    port: 465,
    secure: true,
    auth: { user: 'resend', pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  cached = { transporter, pass };
  return transporter;
}

export function isEmailConfigured(): boolean {
  return Boolean(getResendApiKey());
}

export interface SendResult {
  sent: boolean;
  reason: string | null;
  messageId?: string | null;
}

/** Envía un correo. Nunca lanza. */
export async function send(
  message: EmailMessage,
  options: { essential?: boolean } = {}
): Promise<SendResult> {
  const from = resolveVerifiedFrom(message.from);
  const replyTo = (message.replyTo ?? '').trim() || DEFAULT_REPLY_TO;
  const to = (message.to ?? '').trim();

  let config: AppConfig;
  try {
    config = await getConfig();
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'sin configuración';
    console.error(`[Email Error] to: ${to} from: ${from} error: ${reason}`);
    return { sent: false, reason, messageId: null };
  }

  // Restablecer acceso no depende del interruptor de correos comerciales del panel.
  if (!options.essential && config.email?.enabled === false) {
    return { sent: false, reason: 'desactivado en el panel', messageId: null };
  }
  if (!to) {
    return { sent: false, reason: 'el destinatario no tiene correo', messageId: null };
  }

  let transporter = getTransporter();
  if (!transporter) {
    console.error(`[Email Error] to: ${to} from: ${from} error: falta RESEND_API_KEY`);
    return { sent: false, reason: 'falta RESEND_API_KEY', messageId: null };
  }

  const mailOptions = {
    from,
    replyTo,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const info = await transporter.sendMail(mailOptions);
      const messageId = info?.messageId ?? null;

      console.log(`[Email Sent] to: ${to} from: ${from} messageId: ${messageId}`);
      log.info('Correo enviado', {
        to,
        from,
        subject: message.subject,
        messageId,
      });
      return { sent: true, reason: null, messageId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      cached = null;

      if (attempt === 1) {
        const fresh = getTransporter();
        if (fresh) {
          transporter = fresh;
          continue;
        }
      }

      console.error(`[Email Error] to: ${to} from: ${from} error: ${reason}`);
      log.error('No se pudo enviar el correo', {
        to,
        from,
        subject: message.subject,
        reason,
      });

      return { sent: false, reason, messageId: null };
    }
  }

  return { sent: false, reason: 'error desconocido', messageId: null };
}

/** Comprueba que Resend acepte las credenciales, para el panel. */
export async function verifyConnection(): Promise<{ ok: boolean; message: string | null }> {
  const transporter = getTransporter();

  if (!transporter) {
    return { ok: false, message: 'Falta el secreto RESEND_API_KEY.' };
  }

  try {
    await transporter.verify();
    return { ok: true, message: null };
  } catch (error) {
    cached = null;
    return {
      ok: false,
      message:
        error instanceof Error
          ? `Resend rechazó la conexión: ${error.message}`
          : 'Resend rechazó la conexión.',
    };
  }
}
