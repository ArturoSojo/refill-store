/**
 * Avisos al equipo cuando algo necesita a una persona.
 *
 * Hasta ahora un despacho fallido sólo dejaba rastro en la orden: había que
 * entrar al panel y mirarlo para enterarse. Este módulo empuja el aviso por
 * fuera de la web.
 *
 * Tres canales, y ninguno depende de los otros:
 *
 *  1. **Bandeja del panel** (`adminAlerts`). Siempre se escribe, aunque los
 *     canales externos fallen. Es la única fuente que no puede caerse.
 *  2. **Telegram.** El canal de empuje real: llega al móvil en segundos, es
 *     gratis y no exige un número de empresa. Necesita el secreto
 *     `TELEGRAM_BOT_TOKEN` y el chat destino en la configuración.
 *  3. **Webhook.** Un `POST` con el aviso en JSON. Es lo que permite enrutar el
 *     mismo evento a correo o WhatsApp desde Make, Zapier o n8n sin volver a
 *     tocar este código ni añadir credenciales SMTP aquí.
 *
 * Ninguna función de este módulo lanza: un aviso perdido nunca debe tumbar una
 * compra que por lo demás salió bien.
 */
import { adminAlerts, now } from '../config/firebase';
import { TELEGRAM_BOT_TOKEN } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { paginate, type Page } from '../lib/pagination';
import { log } from '../lib/logger';
import { getConfig } from './settings';
import type { AdminAlert, AppConfig } from '../types/models';

export interface AlertInput {
  kind: AdminAlert['kind'];
  title: string;
  body: string;
  severity?: AdminAlert['severity'];
  /** Ruta interna del panel: `/admin/ordenes/abc123`. */
  link?: string | null;
  data?: Record<string, unknown> | null;
}

const SEVERITY_ICON: Record<AdminAlert['severity'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

/** Decide si este tipo de aviso está activado en la configuración. */
function isEnabled(kind: AdminAlert['kind'], config: AppConfig): boolean {
  const alerts = config.alerts;
  if (!alerts?.enabled) return false;

  switch (kind) {
    case 'dispatch_failed':
      return alerts.notifyOnDispatchFailed !== false;
    case 'manual_order':
      return alerts.notifyOnManualOrder !== false;
    case 'new_ticket':
    case 'ticket_reply':
      return alerts.notifyOnNewTicket !== false;
    case 'payment_rejected':
      return alerts.notifyOnPaymentRejected === true;
    default:
      // `low_balance`, `provider_down` y `test` son siempre relevantes.
      return true;
  }
}

/**
 * `true` si el secreto contiene un token de bot de verdad.
 *
 * El secreto tiene que existir para poder desplegar, así que mientras no haya
 * bot se guarda un marcador. Un token real es `<id>:<clave>`; cualquier otra
 * cosa se trata como «sin configurar» en lugar de intentar el envío y anotar un
 * fallo en cada aviso.
 */
function hasTelegramToken(token: string): boolean {
  return token.includes(':') && token.length > 20;
}

async function sendTelegram(
  text: string,
  chatId: string
): Promise<AdminAlert['delivery']['telegram']> {
  const token = TELEGRAM_BOT_TOKEN.value();
  if (!hasTelegramToken(token ?? '') || !chatId) return 'skipped';

  try {
    const response = await fetchJson<{ ok?: boolean; description?: string }>(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
        timeoutMs: 10_000,
        retries: 1,
      }
    );

    if (!response.ok || response.data?.ok === false) {
      log.warn('Telegram rechazó el aviso', {
        status: response.status,
        description: response.data?.description,
      });
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    log.warn('No se pudo avisar por Telegram', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

async function sendWebhook(
  payload: Record<string, unknown>,
  url: string
): Promise<AdminAlert['delivery']['webhook']> {
  if (!url) return 'skipped';

  try {
    const response = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      timeoutMs: 10_000,
      retries: 1,
    });
    return response.ok ? 'sent' : 'failed';
  } catch (error) {
    log.warn('No se pudo avisar por webhook', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

/** Emite un aviso por todos los canales configurados. Nunca lanza. */
export async function alert(input: AlertInput): Promise<void> {
  try {
    const config = await getConfig();
    const severity = input.severity ?? 'warning';

    if (!isEnabled(input.kind, config)) {
      // Aunque el canal externo esté apagado, el aviso queda en la bandeja: es
      // el historial que el equipo consulta cuando algo se le pasó.
      await adminAlerts().add({
        kind: input.kind,
        severity,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        data: input.data ?? null,
        read: false,
        readAt: null,
        delivery: { telegram: 'skipped', webhook: 'skipped' },
        createdAt: now(),
      });
      return;
    }

    const webhookUrl = config.alerts.webhookUrl ?? '';
    const text = [
      `${SEVERITY_ICON[severity]} <b>${input.title}</b>`,
      input.body,
      input.link ? `\n${config.storeName} · ${input.link}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const [telegram, webhook] = await Promise.all([
      sendTelegram(text, config.alerts.telegramChatId ?? ''),
      sendWebhook(
        {
          kind: input.kind,
          severity,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
          data: input.data ?? null,
          store: config.storeName,
          at: new Date().toISOString(),
        },
        webhookUrl
      ),
    ]);

    await adminAlerts().add({
      kind: input.kind,
      severity,
      title: input.title,
      body: input.body,
      link: input.link ?? null,
      data: input.data ?? null,
      read: false,
      readAt: null,
      delivery: { telegram, webhook },
      createdAt: now(),
    });
  } catch (error) {
    log.warn('No se pudo emitir el aviso al equipo', {
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Avisa si el saldo del proveedor quedó por debajo del umbral.
 *
 * Se llama con el `remaining_balance` que devuelve cada despacho, así que el
 * aviso llega en la misma compra que agotó el saldo y no cuando ya empezaron a
 * fallar las siguientes.
 */
export async function checkProviderBalance(remainingBalance: number | null): Promise<void> {
  if (remainingBalance === null) return;

  try {
    const config = await getConfig();
    const threshold = config.alerts?.lowBalanceThresholdUsd ?? 0;
    if (threshold <= 0 || remainingBalance > threshold) return;

    await alert({
      kind: 'low_balance',
      severity: remainingBalance <= 0 ? 'critical' : 'warning',
      title: 'Saldo bajo en el proveedor',
      body:
        `Quedan $${remainingBalance.toFixed(2)} en la cuenta de Inefable ` +
        `(umbral: $${threshold.toFixed(2)}). Recárgala o las próximas recargas fallarán.`,
      link: '/admin',
      data: { remainingBalance, threshold },
    });
  } catch {
    // `alert` ya registra sus propios fallos.
  }
}

export interface TelegramChat {
  id: string;
  name: string;
  type: string;
}

/**
 * Descubre a qué chats puede escribir el bot.
 *
 * Telegram no ofrece «dame mi chat_id»: el único camino es que alguien le
 * escriba al bot y leer `getUpdates`. Automatizarlo evita el paso más molesto
 * del montaje —buscar el número a mano en una URL de la API— y evita también
 * pegar un chat equivocado, que falla en silencio.
 */
export async function detectTelegramChats(): Promise<{
  ok: boolean;
  botName: string | null;
  chats: TelegramChat[];
  message: string | null;
}> {
  const token = TELEGRAM_BOT_TOKEN.value() ?? '';
  if (!hasTelegramToken(token)) {
    return {
      ok: false,
      botName: null,
      chats: [],
      message: 'Falta el secreto TELEGRAM_BOT_TOKEN.',
    };
  }

  const [me, updates] = await Promise.all([
    fetchJson<{ ok?: boolean; result?: { username?: string } }>(
      `https://api.telegram.org/bot${token}/getMe`,
      { method: 'GET', timeoutMs: 10_000, retries: 1 }
    ),
    fetchJson<{
      ok?: boolean;
      result?: Array<Record<string, { chat?: { id?: number; title?: string; first_name?: string; last_name?: string; type?: string } }>>;
    }>(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'GET',
      timeoutMs: 10_000,
      retries: 1,
    }),
  ]);

  if (!me.ok || me.data?.ok !== true) {
    return { ok: false, botName: null, chats: [], message: 'Telegram rechazó el token del bot.' };
  }

  const botName = me.data.result?.username ? `@${me.data.result.username}` : null;
  const found = new Map<string, TelegramChat>();

  for (const update of updates.data?.result ?? []) {
    // El chat puede venir en `message`, `channel_post`, `my_chat_member`…: se
    // recorre el update entero en vez de adivinar el nombre del campo.
    for (const value of Object.values(update)) {
      const chat = value?.chat;
      if (!chat?.id) continue;

      found.set(String(chat.id), {
        id: String(chat.id),
        name:
          chat.title ??
          [chat.first_name, chat.last_name].filter(Boolean).join(' ') ??
          String(chat.id),
        type: chat.type ?? 'private',
      });
    }
  }

  return {
    ok: true,
    botName,
    chats: [...found.values()],
    message:
      found.size === 0
        ? `Nadie le ha escrito al bot todavía. Abre ${botName ?? 'el bot'} en Telegram, envíale /start y vuelve a intentarlo.`
        : null,
  };
}

export async function listAlerts(
  options: { limit?: number; cursor?: string; onlyUnread?: boolean } = {}
): Promise<Page<AdminAlert>> {
  const base = options.onlyUnread ? adminAlerts().where('read', '==', false) : adminAlerts();

  return paginate(
    base,
    {
      orderBy: 'createdAt',
      limit: options.limit ?? 30,
      cursor: options.cursor,
      withTotal: true,
    },
    (id, data) => ({ id, ...data }) as AdminAlert
  );
}

export async function countUnread(): Promise<number> {
  const snap = await adminAlerts().where('read', '==', false).count().get();
  return snap.data().count;
}

export async function markAllRead(): Promise<number> {
  const snap = await adminAlerts().where('read', '==', false).limit(400).get();
  if (snap.empty) return 0;

  const batch = snap.docs[0].ref.firestore.batch();
  const timestamp = now();
  snap.docs.forEach((doc) => batch.update(doc.ref, { read: true, readAt: timestamp }));
  await batch.commit();
  return snap.size;
}

export async function markRead(id: string): Promise<void> {
  await adminAlerts().doc(id).set({ read: true, readAt: now() }, { merge: true });
}
