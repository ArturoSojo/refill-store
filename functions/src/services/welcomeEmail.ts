import { log } from '../lib/logger';
import type { AppConfig } from '../types/models';
import { getConfig } from './settings';
import { send } from './email';

const MAIN_ORIGIN = 'https://recargasrefillstore.com';
const SUPPORT_EMAIL = 'soporterefillstore@gmail.com';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function render(email: string, name: string | null | undefined, config: AppConfig) {
  const brand = escapeHtml(config.storeName || 'Refill Store');
  const safeName = escapeHtml(name?.trim() || 'Jugador');
  const safeSupport = escapeHtml(SUPPORT_EMAIL);
  const subject = `¡Te damos la bienvenida a ${config.storeName || 'Refill Store'}!`;

  const text = [
    `¡Hola, ${name?.trim() || 'Jugador'}!`,
    '',
    `Tu cuenta en ${config.storeName || 'Refill Store'} ha sido creada con éxito.`,
    '',
    'A partir de ahora podrás:',
    '• Recargar diamantes, pases y juegos favoritos en segundos (Free Fire, Mobile Legends, Roblox, etc.).',
    '• Pagar automáticamente en Bolívares (Pago Móvil) o Binance Pay 24/7.',
    '• Acumular puntos y subir de nivel para obtener descuentos automáticos en todas tus compras.',
    '',
    'Entra a la tienda y haz tu primera recarga:',
    MAIN_ORIGIN,
    '',
    `Si tienes alguna duda o necesitas ayuda, escríbenos a ${SUPPORT_EMAIL}.`,
    '',
    `Equipo de ${config.storeName || 'Refill Store'}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#0b0f19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#e5e7eb">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px;background:#0b0f19">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#1f2937;border:1px solid #374151;border-radius:16px;overflow:hidden">
        <tr><td style="padding:22px 28px;background:#111827;color:#fff;font-size:22px;font-weight:700;text-align:center;border-bottom:1px solid #374151"><img src="https://recargasrefillstore.com/brand/emblem-128.png" alt="Refill Store" width="36" height="36" style="vertical-align:middle;margin-right:10px;border-radius:8px;display:inline-block;" /><span style="vertical-align:middle">${brand}</span></td></tr>
        <tr><td style="padding:32px 28px">
          <div style="text-align:center;margin-bottom:16px;">
            <span style="display:inline-block;background:#e2373b;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.6px;padding:6px 14px;border-radius:999px;">¡BIENVENIDO A BORDO!</span>
          </div>
          <h1 style="margin:0 0 16px;font-size:24px;color:#fff;text-align:center">¡Tu cuenta está lista!</h1>
          <p style="font-size:15px;line-height:1.6;color:#d1d5db">Hola <strong style="color:#fff">${safeName}</strong>,</p>
          <p style="font-size:15px;line-height:1.6;color:#d1d5db">Gracias por unirte a ${brand}. Tu cuenta ha sido activada y ya puedes disfrutar de recargas rápidas, seguras y al mejor precio.</p>
          
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;background:#111827;border-radius:12px;border:1px solid #374151;padding:16px">
            <tr>
              <td style="padding:8px 12px;font-size:14px;color:#e5e7eb;line-height:1.5">
                ⚡ <strong>Acreditación en segundos:</strong> Directo a tu ID de jugador 24/7 sin esperas.
              </td>
            </tr>
            <tr>
              <td style="padding:8px 12px;font-size:14px;color:#e5e7eb;line-height:1.5">
                💳 <strong>Pagos cómodos:</strong> Bolívares por Pago Móvil y dólares por Binance Pay.
              </td>
            </tr>
            <tr>
              <td style="padding:8px 12px;font-size:14px;color:#e5e7eb;line-height:1.5">
                🎯 <strong>Sistema de niveles:</strong> Compra, acumula puntos y desbloquea descuentos automáticos.
              </td>
            </tr>
          </table>

          <p style="margin:32px 0;text-align:center"><a href="${MAIN_ORIGIN}" style="display:inline-block;padding:14px 32px;border-radius:8px;background:#e2373b;color:#fff;text-decoration:none;font-weight:600;font-size:16px">Empezar a recargar</a></p>
          <p style="font-size:13px;line-height:1.6;color:#9ca3af">Si necesitas ayuda con alguna orden o tienes preguntas sobre cómo recargar, puedes escribirnos a <a href="mailto:${safeSupport}" style="color:#ef4444">${safeSupport}</a>.</p>
        </td></tr>
        <tr><td style="padding:20px 28px;background:#111827;text-align:center;border-top:1px solid #374151">
          <p style="margin:0;font-size:12px;color:#9ca3af">Refill Store · Plataforma de recargas automáticas</p>
          <p style="margin:4px 0 0;font-size:12px;color:#9ca3af"><a href="${MAIN_ORIGIN}" style="color:#9ca3af;text-decoration:none">recargasrefillstore.com</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

/**
 * Envía el correo de bienvenida al nuevo cliente registrado.
 * Nunca lanza excepciones para no interrumpir el flujo de autenticación o creación de perfil.
 */
export async function sendWelcomeEmail(email: string, name?: string | null): Promise<void> {
  try {
    const config = await getConfig();
    if (config.email?.enabled === false) return;

    const rendered = render(email, name, config);
    const result = await send({ to: email, ...rendered });
    if (!result.sent) {
      log.warn('No se pudo entregar correo de bienvenida', { email, reason: result.reason });
    } else {
      log.info('Correo de bienvenida enviado', { email });
    }
  } catch (error) {
    log.warn('Error al procesar correo de bienvenida', {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
