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
const SUPPORT_EMAIL = 'recargasrefillstore@gmail.com';

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
<body style="margin:0;background:#0b0f19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#e5e7eb">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px;background:#0b0f19">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#1f2937;border:1px solid #374151;border-radius:16px;overflow:hidden">
        <tr><td style="padding:22px 28px;background:#111827;color:#fff;font-size:22px;font-weight:700;text-align:center;border-bottom:1px solid #374151">${brand}</td></tr>
        <tr><td style="padding:32px 28px">
          <h1 style="margin:0 0 16px;font-size:24px;color:#fff;text-align:center">Restablece tu contraseña</h1>
          <p style="font-size:15px;line-height:1.6;color:#d1d5db">Hola,</p>
          <p style="font-size:15px;line-height:1.6;color:#d1d5db">Recibimos una solicitud para restablecer la contraseña de tu cuenta de ${brand} asociada a <strong style="color:#fff">${safeEmail}</strong>.</p>
          <p style="font-size:15px;line-height:1.6;color:#d1d5db">Para crear una contraseña nueva, toca el botón:</p>
          <p style="margin:32px 0;text-align:center"><a href="${safeLink}" style="display:inline-block;padding:14px 28px;border-radius:8px;background:#e2373b;color:#fff;text-decoration:none;font-weight:600;font-size:16px">Restablecer contraseña</a></p>
          <p style="font-size:13px;line-height:1.6;color:#9ca3af">Si el botón no abre, copia este enlace en tu navegador:<br><a href="${safeLink}" style="color:#ef4444;word-break:break-all">${safeLink}</a></p>
          <p style="font-size:13px;line-height:1.6;color:#9ca3af">Si no solicitaste este cambio, ignora este correo. Tu contraseña seguirá igual.</p>
          <p style="font-size:13px;line-height:1.6;color:#9ca3af">Contacto: <a href="mailto:${safeSupport}" style="color:#ef4444">${safeSupport}</a></p>
        </td></tr>
        <tr><td style="padding:20px 28px;background:#111827;text-align:center;border-top:1px solid #374151">
          <p style="margin:0;font-size:12px;color:#9ca3af">Este es un correo automático de seguridad.</p>
          <p style="margin:4px 0 0;font-size:12px;color:#9ca3af"><a href="https://recargasrefillstore.com" style="color:#9ca3af;text-decoration:none">recargasrefillstore.com</a></p>
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
