/**
 * Envío de correo al cliente.
 *
 * Sale por el SMTP de la propia cuenta de Gmail de la tienda. Con esta escala
 * —el día más movido fueron 21 órdenes— el tope de 500 correos diarios de Gmail
 * sobra, y es la única forma de tener buena entrega sin dominio propio: el
 * correo se origina de verdad en Google, con su firma DKIM. Un tercero enviando
 * «en nombre de» una dirección `@gmail.com` rompe la alineación DMARC y acaba
 * en Spam.
 *
 * Todo el trato con `nodemailer` vive AQUÍ. El resto del código llama a `send()`
 * y no sabe por dónde sale; cuando haya dominio propio y convenga pasar a Brevo
 * o Resend, se cambia este archivo y nada más.
 *
 * Ninguna función lanza: que un correo no salga no puede tumbar una compra que
 * por lo demás terminó bien.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { GMAIL_APP_PASSWORD } from '../config/env';
import { log } from '../lib/logger';
import { getConfig } from './settings';
import type { AppConfig } from '../types/models';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Versión en texto plano. Su ausencia penaliza en los filtros de spam. */
  text: string;
}

/**
 * El transporte se guarda entre invocaciones.
 *
 * Crear uno por correo abriría una conexión TLS nueva cada vez; reutilizarlo
 * aprovecha que las instancias de Cloud Functions se reciclan.
 */
let cached: { transporter: Transporter; user: string } | null = null;

function getTransporter(user: string): Transporter | null {
  const pass = GMAIL_APP_PASSWORD.value();
  if (!pass || !user) return null;

  if (cached && cached.user === user) return cached.transporter;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  cached = { transporter, user };
  return transporter;
}

export function isEmailConfigured(): boolean {
  return Boolean(GMAIL_APP_PASSWORD.value());
}

export interface SendResult {
  sent: boolean;
  reason: string | null;
}

/** Envía un correo. Nunca lanza. */
export async function send(message: EmailMessage): Promise<SendResult> {
  let config: AppConfig;
  try {
    config = await getConfig();
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : 'sin configuración' };
  }

  if (config.email?.enabled === false) return { sent: false, reason: 'desactivado en el panel' };
  if (!message.to) return { sent: false, reason: 'el destinatario no tiene correo' };

  const from = config.email?.fromAddress ?? '';
  const transporter = getTransporter(from);
  if (!transporter) return { sent: false, reason: 'falta GMAIL_APP_PASSWORD o el remitente' };

  try {
    await transporter.sendMail({
      from: `"${config.email.fromName || config.storeName}" <${from}>`,
      replyTo: config.email.replyTo || from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    log.info('Correo enviado', { to: maskEmail(message.to), subject: message.subject });
    return { sent: true, reason: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    // Un fallo de credenciales corta TODOS los correos, no sólo este: conviene
    // que se distinga en los registros de un rebote puntual.
    log.error('No se pudo enviar el correo', {
      to: maskEmail(message.to),
      subject: message.subject,
      reason,
    });

    // El transporte pudo quedar en mal estado; se descarta para que el próximo
    // envío lo reconstruya.
    cached = null;
    return { sent: false, reason };
  }
}

/** `juan@gmail.com` → `ju***@gmail.com`. Para no volcar correos en los registros. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

/** Comprueba que Gmail acepte las credenciales, para el panel. */
export async function verifyConnection(): Promise<{ ok: boolean; message: string | null }> {
  const config = await getConfig();
  const transporter = getTransporter(config.email?.fromAddress ?? '');

  if (!transporter) {
    return { ok: false, message: 'Falta el secreto GMAIL_APP_PASSWORD o la cuenta remitente.' };
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
          ? `Gmail rechazó la conexión: ${error.message}`
          : 'Gmail rechazó la conexión.',
    };
  }
}
