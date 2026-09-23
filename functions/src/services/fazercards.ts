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
  /** Códigos que el proveedor entregó en compras de gift cards o keys. */
  codes: string[] | null;
}

export interface FazerCategory {
  categoryId: string;
  name: string;
  note: string | null;
  imageUrl: string | null;
  region: string | null;
  platform: string | null;
}

export interface FazerOffer {
  offerId: string;
  name: string;
  priceUsd: number;
  stock: number | null;
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

function extractCodes(value: Raw): string[] {
  const order = orderFrom(value);
  const out: string[] = [];
  for (const container of [order.codes, order.cards, order.keys, order.items, order.delivered]) {
    if (!Array.isArray(container)) continue;
    for (const item of container) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim());
      else if (item && typeof item === 'object') {
        const row = item as Raw;
        const code = str(row.code ?? row.key ?? row.pin ?? row.value ?? row.card ?? row.gift_code ?? row.voucher);
        if (code) out.push(code);
      }
    }
  }
  return [...new Set(out)];
}

function redactCodes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCodes);
  if (!value || typeof value !== 'object') return value;
  const out: Raw = {};
  for (const [key, child] of Object.entries(value as Raw)) {
    if (/^(codes?|cards?|keys?|delivered)$/i.test(key)) continue;
    out[key] = redactCodes(child);
  }
  return out;
}

function parse(raw: Raw | null, httpStatus: number, fallback = ''): FazerResult {
  const root = raw ?? {};
  const order = orderFrom(root);
  const codes = extractCodes(root);
  const id = str(order.id ?? order.order_id ?? root.order_id ?? root.orderId);
  const status = str(order.status ?? order.state ?? root.status ?? root.state);
  const normalized = status?.trim().toLowerCase() ?? '';
  const ok = root.ok !== false && order.ok !== false && httpStatus >= 200 && httpStatus < 300;
  const success = ok && (successStatuses.has(normalized) || codes.length > 0);
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
    raw: (raw ? redactCodes(raw) : null) as Raw | null,
    codes: codes.length > 0 ? codes : null,
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

/** Entrega una gift card o una game key. El proveedor devuelve los códigos en
 * la misma orden; el flujo conserva su Idempotency-Key estable. */
export async function createStockOrder(input: {
  family: 'gift_card' | 'game_key';
  categoryId: number | string;
  offerId: number | string;
  quantity: number;
  idempotencyKey: string;
}): Promise<FazerResult> {
  const isGiftCard = input.family === 'gift_card';
  const result = await call(isGiftCard ? '/giftcards/order' : '/gamekeys/order', {
    method: 'POST',
    body: isGiftCard
      ? { category_id: String(input.categoryId), card_id: String(input.offerId), quantity: input.quantity }
      : { game_id: String(input.categoryId), key_id: String(input.offerId), quantity: input.quantity },
    idempotencyKey: input.idempotencyKey,
  });
  log.info('Respuesta de FazerCards', {
    family: input.family,
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

function pickArray(raw: Raw): Raw[] {
  const data = raw.data && typeof raw.data === 'object' ? (raw.data as Raw) : null;
  const candidates = [raw.items, data?.items, raw.categories, data?.categories, raw.data];
  const items = candidates.find(Array.isArray);
  return Array.isArray(items) ? items.filter((item): item is Raw => Boolean(item) && typeof item === 'object') : [];
}

async function listCatalog(path: string): Promise<{ ok: boolean; items: Raw[]; message: string | null }> {
  const all: Raw[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await call(`${path}${separator}limit=400&include_ui=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (result.httpStatus < 200 || result.httpStatus >= 300) return { ok: false, items: all, message: result.message };
    const raw = result.raw ?? {};
    all.push(...pickArray(raw));
    const meta = (raw.meta ?? (raw.data as Raw | undefined)?.meta) as Raw | undefined;
    const next = str(meta?.next_cursor ?? meta?.nextCursor);
    if (!next || meta?.has_more === false) break;
    cursor = next;
  }
  return { ok: true, items: all, message: null };
}

function catalogCategory(raw: Raw, kind: 'topup' | 'gift_card' | 'game_key'): FazerCategory {
  return {
    categoryId: str(raw.category_id ?? raw.game_id ?? raw.id) ?? '',
    name: str(raw.name ?? raw.title) ?? '',
    note: str(raw.note ?? raw.description),
    imageUrl: str(raw.imageurl ?? raw.image_url ?? raw.image),
    region: str(raw.region),
    platform: kind === 'game_key' ? str(raw.platform) : null,
  };
}

function catalogOffers(raw: Raw, keys: string[]): FazerOffer[] {
  const data = raw.data && typeof raw.data === 'object' ? (raw.data as Raw) : null;
  const candidates = [raw.offers, raw.cards, raw.keys, data?.offers, data?.cards, data?.keys];
  const rows = candidates.find(Array.isArray);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Raw => Boolean(row) && typeof row === 'object')
    .map((row) => {
      const offerId = str(keys.map((key) => row[key]).find((value) => value !== undefined)) ?? '';
      const price = Number(row.price_usd ?? row.price ?? row.cost_usd);
      const stockValue = Number(row.stock);
      return {
        offerId,
        name: str(row.name ?? row.title) ?? offerId,
        priceUsd: Number.isFinite(price) ? price : NaN,
        stock: Number.isFinite(stockValue) ? Math.max(0, stockValue) : null,
      };
    })
    .filter((offer) => Boolean(offer.offerId) && Number.isFinite(offer.priceUsd));
}

export async function listFazerCategories(kind: 'topup' | 'gift_card' | 'game_key') {
  const path = kind === 'topup' ? '/topups' : kind === 'gift_card' ? '/giftcards' : '/gamekeys';
  const result = await listCatalog(path);
  return { ...result, items: result.items.map((item) => catalogCategory(item, kind)).filter((item) => item.categoryId) };
}

export async function getFazerOffers(kind: 'topup' | 'gift_card' | 'game_key', categoryId: string) {
  const path =
    kind === 'topup'
      ? `/topups/offers?category_id=${encodeURIComponent(categoryId)}&include_ui=1`
      : kind === 'gift_card'
        ? `/giftcards/cards?category_id=${encodeURIComponent(categoryId)}&include_ui=1`
        : `/gamekeys/keys?game_id=${encodeURIComponent(categoryId)}&include_ui=1`;
  const result = await call(path);
  const keys = kind === 'topup' ? ['offer_id', 'id'] : kind === 'gift_card' ? ['card_id', 'id'] : ['key_id', 'id'];
  const raw = result.raw ?? {};
  const data = raw.data && typeof raw.data === 'object' ? (raw.data as Raw) : null;
  const fieldRows = raw.fields ?? data?.fields;
  return {
    ok: result.httpStatus >= 200 && result.httpStatus < 300,
    offers: catalogOffers(raw, keys),
    fields: Array.isArray(fieldRows)
      ? fieldRows.filter((field): field is Raw => Boolean(field) && typeof field === 'object')
      : [],
    name: str(raw.name ?? raw.GameName ?? data?.name ?? data?.GameName),
    note: str(raw.note ?? data?.note),
    imageUrl: str(raw.imageurl ?? raw.image_url ?? data?.imageurl ?? data?.image_url),
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
