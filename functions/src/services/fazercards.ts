/**
 * Adaptador de FazerCards para las recargas de Refill Store.
 *
 * Cada pedido lleva una Idempotency-Key estable: si la red se corta, nunca se
 * vuelve a cobrar a ciegas. Un estado desconocido se conserva como `processing`
 * hasta que el webhook o la consulta de estado lo confirme.
 */
import { FAZERCARDS_API_KEY, fazerBaseUrl } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { log } from '../lib/logger';

type Raw = Record<string, unknown>;

export interface FazerResult {
  success: boolean;
  processing: boolean;
  providerOrderId: string | null;
  providerStatus: string | null;
  playerName: string | null;
  providerReference: string | null;
  remainingBalance: number | null;
  message: string;
  httpStatus: number;
  retryable: boolean;
  raw: Raw | null;
}

const successStatuses = new Set(['completed', 'complete', 'delivered', 'success', 'done', 'fulfilled', 'ok']);
const failureStatuses = new Set(['failed', 'error', 'rejected', 'cancelled', 'canceled', 'refunded', 'declined', 'expired']);
const pendingStatuses = new Set(['processing', 'pending', 'created', 'queued', 'in_progress', 'accepted', 'new', 'waiting']);

const str = (value: unknown): string | null =>
  value === undefined || value === null || value === '' ? null : String(value);

function orderFrom(raw: Raw): Raw {
  const data = raw.data && typeof raw.data === 'object' ? (raw.data as Raw) : null;
  const order = raw.order ?? data?.order ?? data ?? raw;
  return order && typeof order === 'object' ? (order as Raw) : raw;
}

function parse(raw: Raw | null, httpStatus: number, fallback = ''): FazerResult {
  const root = raw ?? {};
  const order = orderFrom(root);
  const id = str(order.id ?? order.order_id ?? root.order_id ?? root.orderId);
  const status = str(order.status ?? order.state ?? root.status ?? root.state);
  const normalized = status?.trim().toLowerCase() ?? '';
  const ok = root.ok !== false && order.ok !== false && httpStatus >= 200 && httpStatus < 300;
  const success = ok && successStatuses.has(normalized);
  const failure = !ok || failureStatuses.has(normalized);
  const processing = !failure && !success && (pendingStatuses.has(normalized) || Boolean(id) || httpStatus === 202);
  const player = order.player && typeof order.player === 'object' ? (order.player as Raw) : {};

  return {
    success,
    processing,
    providerOrderId: id,
    providerStatus: status,
    playerName: str(order.player_name ?? order.playerName ?? player.name ?? player.nickname),
    providerReference: str(order.reference_no ?? order.reference ?? root.reference_no),
    remainingBalance: null,
    message:
      (str(root.error ?? order.error ?? root.message ?? order.message) ?? fallback) ||
      (success ? 'Recarga entregada por FazerCards.' : processing ? 'Recarga aceptada por FazerCards.' : `FazerCards respondió HTTP ${httpStatus}.`),
    httpStatus,
    retryable: httpStatus === 0 || httpStatus >= 500 || httpStatus === 429,
    raw,
  };
}

function key(): string | null {
  const value = FAZERCARDS_API_KEY.value().trim();
  return value && !['PENDIENTE', 'CAMBIAME', 'TODO'].includes(value.toUpperCase()) ? value : null;
}

async function call(path: string, options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; idempotencyKey?: string } = {}) {
  const apiKey = key();
  if (!apiKey) return parse(null, 0, 'Falta configurar FazerCards.');
  const response = await fetchJson<Raw>(`${fazerBaseUrl().replace(/\/+$/, '')}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'X-API-Key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: options.body,
    timeoutMs: options.method === 'POST' ? 30_000 : 15_000,
    // Una recarga jamás se reintenta automáticamente.
    retries: options.method === 'POST' ? 0 : 1,
  });
  return parse(response.data, response.status, response.raw.slice(0, 300));
}

export function isFazerCardsConfigured(): boolean {
  return key() !== null;
}

export async function createTopup(input: {
  categoryId: number | string;
  offerId: number | string;
  fields: Record<string, string>;
  idempotencyKey: string;
}): Promise<FazerResult> {
  const result = await call('/topups/order', {
    method: 'POST',
    body: { category_id: String(input.categoryId), offer_id: String(input.offerId), fields: input.fields },
    idempotencyKey: input.idempotencyKey,
  });
  log.info('Respuesta de FazerCards', {
    categoryId: input.categoryId,
    offerId: input.offerId,
    httpStatus: result.httpStatus,
    success: result.success,
    processing: result.processing,
    providerOrderId: result.providerOrderId,
  });
  return result;
}

export function getOrder(providerOrderId: string): Promise<FazerResult> {
  return call(`/orders/${encodeURIComponent(providerOrderId)}`);
}

/**
 * Catálogo de una categoría, sólo para que el administrador configure ofertas
 * reales. Nunca crea una recarga ni consume saldo.
 */
export async function getTopupOffers(categoryId: string): Promise<{ ok: boolean; offers: Raw[]; message: string | null }> {
  const result = await call(`/topups/offers?category_id=${encodeURIComponent(categoryId)}&include_ui=1`);
  const data = result.raw ?? {};
  const nested = data.data && typeof data.data === 'object' ? (data.data as Raw) : null;
  const candidates = [data.offers, nested?.offers, nested?.items, data.items, nested, data];
  const offers = candidates.find(Array.isArray);
  return {
    ok: result.httpStatus >= 200 && result.httpStatus < 300,
    offers: Array.isArray(offers) ? (offers.filter((item): item is Raw => Boolean(item) && typeof item === 'object') as Raw[]) : [],
    message: result.httpStatus >= 200 && result.httpStatus < 300 ? null : result.message,
  };
}

export async function getBalance(): Promise<{ ok: boolean; balanceUsd: number | null; accountName: string | null; message: string | null }> {
  const result = await call('/balance');
  const data = result.raw ?? {};
  const balance = Number(data.balance ?? (data.data as Raw | undefined)?.balance);
  return {
    ok: result.httpStatus >= 200 && result.httpStatus < 300,
    balanceUsd: Number.isFinite(balance) ? balance : null,
    accountName: str(data.account_name ?? (data.user as Raw | undefined)?.email),
    message: result.httpStatus >= 200 && result.httpStatus < 300 ? null : result.message,
  };
}

export async function setWebhook(url: string): Promise<{ ok: boolean; secret: string | null; message: string }> {
  const result = await call('/account/webhook', { method: 'PUT', body: { url, enabled: true } });
  const data = result.raw ?? {};
  const nested = data.data && typeof data.data === 'object' ? (data.data as Raw) : null;
  const hook = (data.webhook ?? nested?.webhook ?? nested ?? data) as Raw;
  return { ok: result.httpStatus >= 200 && result.httpStatus < 300, secret: str(hook?.secret), message: result.message };
}
