import { auth } from '../config/firebase';
import { log } from '../lib/logger';
import type { AppConfig } from '../types/models';
import { getConfig } from './settings';
import { send } from './email';

const MAIN_ORIGIN = 'https://recargasrefillstore.com';
const APPROVED_WEB_ORIGINS = new Set([
  MAIN_ORIGIN,
  'https://www.recargasrefillstore.com',
  'https://refill-store-ve.netlify.app',
]);
const SUPPORT_EMAIL = 'layankrach@gmail.com';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function continueUrl(client: 'app' | 'web', requestOrigin?: string): string {
  const origin =
    client === 'app'
      ? MAIN_ORIGIN
      : requestOrigin && APPROVED_WEB_ORIGINS.has(requestOrigin)
        ? requestOrigin
        : MAIN_ORIGIN;
  const url = new URL('/entrar', origin);
  url.searchParams.set('restablecimiento', '1');
  if (client === 'app') url.searchParams.set('origen', 'app');
  return url.toString();
}

async function customActionLink(email: string, continueTo: string): Promise<string> {
  // No se pasa continueUrl al Admin SDK: así no dependemos de que Firebase
  // permita guardar/editar su plantilla ni de su lista de URLs de continuación.
  const firebaseLink = new URL(await auth.generatePasswordResetLink(email));
  const oobCode = firebaseLink.searchParams.get('oobCode');
  const apiKey = firebaseLink.searchParams.get('apiKey');
  if (!oobCode || !apiKey) throw new Error('Firebase devolvió un enlace de restablecimiento incompleto.');

  // El código sigue siendo de Firebase; sólo cambiamos la página que lo presenta.
  const action = new URL('/auth/action', MAIN_ORIGIN);
  action.searchParams.set('mode', 'resetPassword');
  action.searchParams.set('oobCode', oobCode);
  action.searchParams.set('apiKey', apiKey);
  action.searchParams.set('lang', 'es');
  action.searchParams.set('continueUrl', continueTo);
  return action.toString();
}

function render(email: string, link: string, config: AppConfig) {
  const brand = escapeHtml(config.storeName || 'Refill Store');
  const safeEmail = escapeHtml(email);
  const safeLink = escapeHtml(link);
  const safeSupport = escapeHtml(SUPPORT_EMAIL);
  const subject = 'Restablece tu contraseña de Refill Store';
  const text = [
    'Hola,',
    '',
    `Recibimos una solicitud para restablecer la contraseña de tu cuenta de ${config.storeName} asociada a ${email}.`,
    '',
    'Para crear una contraseña nueva, abre este enlace seguro:',
    link,
    '',
    'Si no solicitaste este cambio, ignora este correo. Tu contraseña seguirá igual.',
    '',
    `Contacto: ${SUPPORT_EMAIL}`,
    '',
    `Equipo de ${config.storeName}`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;color:#1f2430">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px;background:#f3f4f6">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
        <tr><td style="padding:22px 28px;background:#101019;color:#fff;font-size:20px;font-weight:700">${brand}</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 14px;font-size:24px">Restablece tu contraseña</h1>
          <p style="font-size:15px;line-height:1.6;color:#4b5563">Hola,</p>
          <p style="font-size:15px;line-height:1.6;color:#4b5563">Recibimos una solicitud para restablecer la contraseña de tu cuenta de ${brand} asociada a <strong>${safeEmail}</strong>.</p>
          <p style="font-size:15px;line-height:1.6;color:#4b5563">Para crear una contraseña nueva, toca el botón:</p>
          <p style="margin:24px 0;text-align:center"><a href="${safeLink}" style="display:inline-block;padding:14px 22px;border-radius:10px;background:#e2373b;color:#fff;text-decoration:none;font-weight:700">Restablecer contraseña</a></p>
          <p style="font-size:13px;line-height:1.6;color:#6b7280">Si el botón no abre, copia este enlace en tu navegador:<br><a href="${safeLink}" style="color:#c52d35;word-break:break-all">${safeLink}</a></p>
          <p style="font-size:13px;line-height:1.6;color:#6b7280">Si no solicitaste este cambio, ignora este correo. Tu contraseña seguirá igual.</p>
          <p style="font-size:13px;line-height:1.6;color:#6b7280">Contacto: <a href="mailto:${safeSupport}" style="color:#c52d35">${safeSupport}</a></p>
          <p style="margin:22px 0 0;font-size:13px;color:#6b7280">Equipo de ${brand}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, text, html };
}

/**
 * Emite un enlace Firebase válido y lo entrega en el correo transaccional propio.
 * La función siempre se consume desde un endpoint con respuesta genérica para
 * no confirmar si una dirección está registrada.
 */
export async function sendPasswordReset(email: string, client: 'app' | 'web', origin?: string) {
  const config = await getConfig();
  const continueTo = continueUrl(client, origin);
  const link = await customActionLink(email, continueTo);
  const result = await send({ to: email, ...render(email, link, config) }, { essential: true });
  if (!result.sent) {
    log.warn('No se pudo entregar correo de restablecimiento', { reason: result.reason });
  }
}
