/**
 * Correo amable para que vuelvan los clientes que dejaron de recargar.
 *
 * Una vez al día se revisa a quien hizo su última recarga hace entre 5 y 14
 * días y se le escribe UNA sola vez por periodo de inactividad: si vuelve a
 * recargar y luego se enfría otra vez, recibirá un nuevo correo. La ventana
 * superior evita, además, escribirle de golpe a toda la base dormida el día que
 * se activa la función y mantiene la consulta pequeña.
 */
import { users, now, Timestamp } from '../config/firebase';
import { log } from '../lib/logger';
import type { AppConfig, UserProfile } from '../types/models';
import { getConfig } from './settings';
import { send } from './email';

const MAIN_ORIGIN = 'https://recargasrefillstore.com';
const SUPPORT_EMAIL = 'soporterefillstore@gmail.com';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Días sin recargar a partir de los cuales se escribe. */
export const WINBACK_AFTER_DAYS = 5;
/** Pasado este tiempo ya no se insiste: la persona dejó de ser «reciente». */
export const WINBACK_MAX_DAYS = 14;
/** Tope por ejecución: Gmail permite 500 al día y el resto de correos también cuenta. */
const MAX_PER_RUN = 120;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first || 'jugador';
}

export function renderWinbackEmail(
  name: string | null | undefined,
  daysAway: number,
  config: Pick<AppConfig, 'storeName'>
) {
  const store = config.storeName || 'Refill Store';
  const brand = escapeHtml(store);
  const hello = escapeHtml(firstName(name));
  const supportMail = escapeHtml(SUPPORT_EMAIL);
  const accountUrl = `${MAIN_ORIGIN}/cuenta`;
  const subject = `${firstName(name)}, te extrañamos en ${store} 🎮`;

  const text = [
    `¡Hola, ${firstName(name)}!`,
    '',
    `Hace ${daysAway} días que no te vemos por ${store} y queríamos saludarte.`,
    '',
    'Tu próxima recarga te está esperando:',
    '• Llega a tu cuenta en segundos, las 24 horas.',
    '• Pagas por Pago Móvil, solo con el número de referencia (sin capturas).',
    '• Con cada compra sumas puntos y subes de nivel para tener descuentos.',
    '',
    `Vuelve cuando quieras: ${MAIN_ORIGIN}`,
    '',
    `Si necesitas ayuda, escríbenos a ${SUPPORT_EMAIL}. Con gusto te echamos una mano.`,
    '',
    `Si prefieres no recibir estos mensajes, puedes desactivarlos en Mi cuenta: ${accountUrl}`,
    '',
    `Un abrazo,`,
    `Equipo de ${store}`,
  ].join('\n');

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#0b0f19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#e5e7eb">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:28px 12px;background:#0b0f19">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#1f2937;border:1px solid #374151;border-radius:16px;overflow:hidden">
        <tr><td style="padding:22px 28px;background:#111827;color:#fff;font-size:22px;font-weight:700;text-align:center;border-bottom:1px solid #374151"><img src="${MAIN_ORIGIN}/brand/emblem-128.png" alt="Refill Store" width="36" height="36" style="vertical-align:middle;margin-right:10px;border-radius:8px;display:inline-block;" /><span style="vertical-align:middle">${brand}</span></td></tr>
        <tr><td style="padding:32px 28px">
          <div style="text-align:center;margin-bottom:16px;">
            <span style="display:inline-block;background:#e2373b;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:.6px;padding:6px 14px;border-radius:999px;">¡TE EXTRAÑAMOS!</span>
          </div>
          <h1 style="margin:0 0 16px;font-size:24px;color:#fff;text-align:center">¿Una recarga para volver al juego?</h1>
          <p style="font-size:15px;line-height:1.6;color:#d1d5db">Hola <strong style="color:#fff">${hello}</strong>,</p>
          <p style="font-size:15px;line-height:1.6;color:#d1d5db">Hace ${daysAway} días que no te vemos por ${brand} y queríamos saludarte. Tu próxima recarga te está esperando.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;background:#111827;border-radius:12px;border:1px solid #374151;padding:16px">
            <tr><td style="padding:8px 12px;font-size:14px;color:#e5e7eb;line-height:1.5">⚡ <strong>En segundos:</strong> tu recarga llega directo a tu cuenta, 24/7.</td></tr>
            <tr><td style="padding:8px 12px;font-size:14px;color:#e5e7eb;line-height:1.5">💳 <strong>Pago Móvil fácil:</strong> solo con el número de referencia, sin subir capturas.</td></tr>
            <tr><td style="padding:8px 12px;font-size:14px;color:#e5e7eb;line-height:1.5">🎯 <strong>Más por tu compra:</strong> suma puntos y sube de nivel para tener descuentos.</td></tr>
          </table>

          <p style="margin:32px 0;text-align:center"><a href="${MAIN_ORIGIN}" style="display:inline-block;padding:14px 32px;border-radius:8px;background:#e2373b;color:#fff;text-decoration:none;font-weight:600;font-size:16px">Volver a recargar</a></p>
          <p style="font-size:13px;line-height:1.6;color:#9ca3af">¿Necesitas ayuda con algo? Escríbenos a <a href="mailto:${supportMail}" style="color:#ef4444">${supportMail}</a>, con gusto te echamos una mano.</p>
        </td></tr>
        <tr><td style="padding:20px 28px;background:#111827;text-align:center;border-top:1px solid #374151">
          <p style="margin:0;font-size:12px;color:#9ca3af">Refill Store · Plataforma de recargas automáticas</p>
          <p style="margin:6px 0 0;font-size:11px;color:#6b7280">Si prefieres no recibir estos mensajes, desactívalos en <a href="${accountUrl}" style="color:#9ca3af">Mi cuenta</a>.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

function millis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  const seconds = (value as { _seconds?: number; seconds?: number } | null)?.seconds ??
    (value as { _seconds?: number } | null)?._seconds;
  return typeof seconds === 'number' ? seconds * 1000 : null;
}

export interface WinbackResult {
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Envía los correos de «te extrañamos». Nunca lanza; devuelve el resumen.
 * `winbackSentAt` en el usuario evita repetir el correo en el mismo periodo.
 */
export async function runWinbackEmails(): Promise<WinbackResult> {
  const result: WinbackResult = { candidates: 0, sent: 0, skipped: 0, failed: 0 };

  try {
    const config = await getConfig();
    if (config.email?.enabled === false) return result;

    const nowMs = now().toMillis();
    const newest = Timestamp.fromMillis(nowMs - WINBACK_AFTER_DAYS * DAY_MS);
    const oldest = Timestamp.fromMillis(nowMs - WINBACK_MAX_DAYS * DAY_MS);

    const snap = await users()
      .where('stats.lastOrderAt', '<=', newest)
      .where('stats.lastOrderAt', '>=', oldest)
      .orderBy('stats.lastOrderAt', 'desc')
      .limit(400)
      .get();

    result.candidates = snap.size;

    for (const doc of snap.docs) {
      if (result.sent >= MAX_PER_RUN) break;

      const profile = doc.data() as Partial<UserProfile> & { winbackSentAt?: unknown };
      const lastOrderMs = millis(profile.stats?.lastOrderAt);
      const sentMs = millis(profile.winbackSentAt);

      const skip =
        !profile.email ||
        profile.banned === true ||
        profile.preferences?.notifyEmail === false ||
        doc.id.startsWith('whatsapp:') ||
        lastOrderMs === null ||
        // Ya se le escribió durante esta misma inactividad.
        (sentMs !== null && sentMs > lastOrderMs);

      if (skip) {
        result.skipped += 1;
        continue;
      }

      const daysAway = Math.max(WINBACK_AFTER_DAYS, Math.floor((nowMs - lastOrderMs!) / DAY_MS));
      const rendered = renderWinbackEmail(profile.displayName, daysAway, config);
      const sent = await send({ to: profile.email!, ...rendered });

      if (sent.sent) {
        await doc.ref.set({ winbackSentAt: now() }, { merge: true });
        result.sent += 1;
      } else {
        result.failed += 1;
        // Sin credenciales o con el correo apagado, insistir con el resto es inútil.
        if (sent.reason?.includes('GMAIL_APP_PASSWORD') || sent.reason?.includes('desactivado')) break;
      }
    }

    log.info('Correos de reactivación procesados', { ...result });
  } catch (error) {
    log.error('Falló el envío de correos de reactivación', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

