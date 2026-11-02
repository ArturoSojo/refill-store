/**
 * Avisos que nos manda el proveedor cuando cambia el estado de una orden.
 *
 * Sustituye a esperar: antes se consultaba cada dos minutos si una recarga
 * aceptada (HTTP 202) ya había terminado. Con esto el proveedor avisa en
 * cuanto la cierra.
 *
 * Dos decisiones de seguridad, porque esta ruta es pública y mueve dinero:
 *
 *  1. **El aviso es sólo un disparador.** Nunca se cree lo que dice el cuerpo:
 *     se le vuelve a preguntar al proveedor por su API autenticada cuál es el
 *     estado real. Así, aunque alguien falsificara un aviso, lo único que
 *     conseguiría es que consultemos. No puede marcar una recarga como
 *     entregada.
 *  2. **Se valida la firma igualmente.** `X-Webhook-Signature` es un
 *     HMAC-SHA256 en hexadecimal del cuerpo crudo. Si el secreto está
 *     configurado y la firma no cuadra, se descarta sin mirar nada más.
 *
 * La ruta lleva además un fragmento aleatorio para que un escáner que dé con
 * el dominio no nos haga trabajar.
 *
 * Central One (`POST /centralone`) sigue la misma idea con su propio esquema:
 * firma obligatoria (sin secreto responde 503), candado contra avisos
 * repetidos en `providerWebhookEvents` y los `order.*` sólo disparan la
 * consulta autenticada. Sus avisos de catálogo sí se aplican directo: sólo
 * pueden cambiar costo, stock y precio con margen de ofertas que ya existen.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  FAZERCARDS_WEBHOOK_SECRET,
  FAZERCARDS_WEBHOOK_TOKEN,
  INEFABLE_WEBHOOK_SECRET,
  INEFABLE_WEBHOOK_TOKEN,
  centralOneWebhookSecret,
} from '../config/env';
import {
  db,
  games,
  now,
  privateCentralOneConfigDoc,
  products,
  providerWebhookEvents,
  Timestamp,
} from '../config/firebase';
import { asyncHandler } from '../lib/http';
import { log } from '../lib/logger';
import { applyMargin, round } from '../lib/money';
import * as adminAlerts from '../services/adminAlerts';
import * as centralOne from '../services/centralOne';
import {
  resolveCentralOneWebhookOrder,
  resolveFazerProcessingOrder,
  resolveProcessingOrder,
} from '../services/dispatch';
import { getConfig } from '../services/settings';
import { handleTelegramSupportWebhook } from '../services/telegramSupportBot';
import type { Product } from '../types/models';


export const webhooksRouter = Router();

/** Compara sin filtrar el tiempo de respuesta, que delataría la firma correcta. */
function equals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** El secreto del proveedor sólo se ve una vez; hasta entonces hay un marcador. */
const PLACEHOLDERS = ['', 'PENDIENTE', 'CAMBIAME', 'TODO'];

function signatureIsValid(rawBody: Buffer | undefined, header: string | undefined): boolean {
  const secret = INEFABLE_WEBHOOK_SECRET.value().trim();

  // Sin secreto configurado no se puede validar. No se rechaza: el aviso sólo
  // dispara una consulta autenticada, así que sigue siendo seguro. Queda el
  // registro para no olvidar que falta configurarlo.
  if (PLACEHOLDERS.includes(secret.toUpperCase())) {
    log.warn('Webhook de Inefable sin secreto de firma configurado');
    return true;
  }
  if (!rawBody || !header) return false;

  const esperada = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Algunos proveedores prefijan el algoritmo; se admite por si lo cambian.
  const recibida = header.trim().replace(/^sha256=/i, '').toLowerCase();

  return equals(esperada, recibida);
}

function fazerSignatureIsValid(
  rawBody: Buffer | undefined,
  headers: Record<string, string | string[] | undefined>
): boolean {
  const secret = FAZERCARDS_WEBHOOK_SECRET.value().trim();
  if (PLACEHOLDERS.includes(secret.toUpperCase())) return false;
  if (!rawBody) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const names = [
    'x-signature',
    'x-webhook-signature',
    'x-hub-signature-256',
    'x-fazer-signature',
    'x-fazercards-signature',
    'x-fzr-signature',
    'signature',
  ];
  return names.some((name) => {
    const value = headers[name];
    const received = (Array.isArray(value) ? value[0] : value)?.trim().replace(/^(sha256|hmac-sha256)=?/i, '').toLowerCase();
    if (!received) return false;
    const hex = /^[0-9a-f]{64}$/i.test(received) ? received : Buffer.from(received, 'base64').toString('hex');
    return equals(expected, hex);
  });
}

interface InefableWebhookBody {
  event?: string;
  event_type?: string;
  order?: {
    id?: number | string;
    status?: string;
    external_order_id?: string;
    error?: string;
  };
}

interface FazerWebhookBody {
  event?: string;
  type?: string;
  order_id?: string | number;
  orderId?: string | number;
  order?: { id?: string | number; order_id?: string | number; status?: string };
  data?: { id?: string | number; order_id?: string | number; order?: { id?: string | number }; status?: string };
}

webhooksRouter.post(
  '/fazercards/:token',
  asyncHandler(async (req, res) => {
    const responder = (resultado: string) => res.status(200).json({ ok: true, resultado });
    const token = FAZERCARDS_WEBHOOK_TOKEN.value().trim();
    if (PLACEHOLDERS.includes(token.toUpperCase()) || req.params.token !== token) {
      log.warn('Webhook de FazerCards con token inválido');
      return responder('token inválido');
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!fazerSignatureIsValid(rawBody, req.headers)) {
      log.warn('Webhook de FazerCards con firma inválida');
      return responder('firma inválida');
    }

    const body = (req.body ?? {}) as FazerWebhookBody;
    if (body.event === 'webhook.test' || body.type === 'webhook.test') {
      // Deja una evidencia verificable de que token + HMAC pasaron, sin guardar
      // el payload ni secretos del proveedor.
      log.info('Webhook de prueba de FazerCards validado');
      return responder('test');
    }
    const providerOrderId = body.order?.id ?? body.order?.order_id ?? body.order_id ?? body.orderId ?? body.data?.order?.id ?? body.data?.order_id ?? body.data?.id;
    if (providerOrderId === undefined || providerOrderId === null) return responder('sin id de pedido');

    log.info('Webhook de FazerCards recibido', { providerOrderId: String(providerOrderId) });
    return responder(await resolveFazerProcessingOrder(String(providerOrderId)));
  })
);

webhooksRouter.post(
  ['/inefable', '/inefable/:token'],
  asyncHandler(async (req, res) => {
    // Siempre 200, y cuanto antes: si el proveedor recibe un error o tarda,
    // reintenta, y un aviso repetido no aporta nada. Lo que haya que arreglar
    // se ve en los registros, no devolviéndole un fallo a él.
    const responder = (resultado: string) => res.status(200).json({ ok: true, resultado });

    const token = INEFABLE_WEBHOOK_TOKEN.value();
    if (req.params.token && token && req.params.token !== token) {
      log.warn('Webhook de Inefable con token inválido');
      return responder('token inválido');
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const firma = req.header('X-Webhook-Signature') ?? undefined;
    if (!signatureIsValid(rawBody, firma)) {
      log.warn('Webhook de Inefable con firma inválida');
      return responder('firma inválida');
    }

    const body = (req.body ?? {}) as InefableWebhookBody;
    const externalOrderId = body.order?.external_order_id?.trim();

    log.info('Webhook de Inefable recibido', {
      event: body.event_type ?? body.event ?? null,
      externalOrderId: externalOrderId ?? null,
      providerStatus: body.order?.status ?? null,
      providerOrderId: body.order?.id ?? null,
    });

    if (!externalOrderId) return responder('sin external_order_id');

    // Aquí NO se usa el estado del cuerpo: se resuelve preguntándole al
    // proveedor, que es lo que hace que un aviso falsificado sea inofensivo.
    const resultado = await resolveProcessingOrder(externalOrderId);
    return responder(resultado);
  })
);

// ---------------------------------------------------------------------------
// Central One
// ---------------------------------------------------------------------------

/**
 * URL que se registra en el portal de Central One (Integración → Webhooks).
 * Hosting reescribe `/api/**` a la función `api`, que monta este router en
 * `/api/webhooks`.
 */
export const CENTRAL_ONE_WEBHOOK_URL = 'https://recargasrefillstore.com/api/webhooks/centralone';

/** Tiempo máximo de trabajo antes de responder: Central One corta a los 10 s. */
const CENTRAL_ONE_BUDGET_MS = 8_000;
/** Los avisos ya vistos se guardan una semana (TTL de `expireAt`). */
const EVENT_TTL_MS = 7 * 86_400_000;
/** `privateConfig/centralOne.lastWebhookAt` se escribe como mucho una vez por minuto. */
const LAST_WEBHOOK_EVERY_MS = 60_000;
/** Un `balance.low` por hora y por instancia basta: el resto es ruido en Telegram. */
const BALANCE_ALERT_EVERY_MS = 60 * 60_000;
/** Límite de valores de un `where(…, 'in', …)`. */
const IN_CHUNK = 30;

interface CoWebhookOrder {
  id?: string | number;
  reference_code?: string;
  idempotency_key?: string;
  status?: string;
}

/** Producto citado por `product.price_changed` / `product.stock_changed`. */
export interface CoProductChange {
  product_id?: string;
  reseller_price?: string | number | null;
  in_stock?: boolean | null;
  available_stock?: number | null;
  in_catalog?: boolean | null;
}

export interface CoWebhookBody {
  event_id?: string;
  event?: string;
  sequence?: number;
  occurred_at?: string;
  order?: CoWebhookOrder;
  products?: CoProductChange[];
  balance?: { available?: string | number; threshold?: string | number };
}

let lastWebhookStampMs = 0;
let lastBalanceAlertMs = 0;

/** Anota la hora del último aviso válido (la muestra el panel). Nunca lanza. */
async function stampLastWebhook(): Promise<void> {
  if (Date.now() - lastWebhookStampMs < LAST_WEBHOOK_EVERY_MS) return;
  lastWebhookStampMs = Date.now();
  try {
    await privateCentralOneConfigDoc().set({ lastWebhookAt: now() }, { merge: true });
  } catch (error) {
    log.warn('No se pudo anotar la hora del último webhook de Central One', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `event_id` válido como id de documento de Firestore (sin `/`, acotado). */
export function webhookEventDocId(eventId: string): string {
  return eventId.trim().replace(/\//g, '_').slice(0, 200);
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

/**
 * Anota el aviso. `false` si ya se había recibido (Central One reintenta hasta
 * ver un 2xx, y puede mandar dos copias a la vez). Si Firestore falla por otra
 * cosa se procesa igual: repetir un aviso es inofensivo (sólo dispara una
 * consulta), perderlo no.
 */
async function rememberEvent(eventId: string, event: string | null): Promise<boolean> {
  try {
    await providerWebhookEvents()
      .doc(webhookEventDocId(eventId))
      .create({
        provider: 'centralone',
        event,
        receivedAt: now(),
        // Para la política TTL de Firestore (limpieza a los 7 días).
        expireAt: Timestamp.fromMillis(Date.now() + EVENT_TTL_MS),
      });
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    log.warn('No se pudo anotar el aviso del webhook de Central One', {
      eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * Nombre e id del aviso. Manda el cuerpo, que es lo firmado; las cabeceras
 * `X-CentralOne-Event(-Id)` son copias que no entran en la firma. Si el cuerpo
 * no trae alguno, se toma el de la cabecera. Sólo es `mismatch` (alguien las
 * cambió en el camino) cuando cuerpo y cabecera traen valor y no coinciden.
 * Función pura.
 */
export function resolveEventIdentity(
  body: { event?: unknown; event_id?: unknown },
  headers: { event?: string | null; eventId?: string | null }
): { event: string | null; eventId: string | null; mismatch: boolean } {
  const clean = (value: unknown) => (typeof value === 'string' ? value.trim() : '') || null;
  const bodyEvent = clean(body.event);
  const bodyEventId = clean(body.event_id);
  const headerEvent = clean(headers.event);
  const headerEventId = clean(headers.eventId);
  const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  return {
    event: bodyEvent ?? headerEvent,
    eventId: bodyEventId ?? headerEventId,
    mismatch: differs(bodyEvent, headerEvent) || differs(bodyEventId, headerEventId),
  };
}

/**
 * Stock de la tienda según el aviso: `in_stock: false` = agotado (0);
 * `available_stock` numérico = esa cantidad; `in_stock: true` sin cantidad =
 * ilimitado (`null`). `undefined` si el aviso no dice nada del stock (las
 * mismas reglas que la sincronización). Función pura.
 */
export function stockFromChange(change: CoProductChange): number | null | undefined {
  if (change.in_stock === false) return 0;
  if (typeof change.available_stock === 'number' && Number.isFinite(change.available_stock)) {
    return Math.max(0, Math.floor(change.available_stock));
  }
  if (change.in_stock === true) return null;
  return undefined;
}

export type CoProductState = Pick<
  Product,
  'costUsd' | 'priceUsd' | 'stock' | 'active' | 'providerRemoved' | 'adminDisabled' | 'priceLocked'
>;

/**
 * Parche de una oferta de Central One ante un aviso de cambio. Función pura.
 *
 * Las mismas reglas que la sincronización (D3):
 *  - El costo se sigue siempre.
 *  - El precio se recalcula con el margen de la tienda, salvo que el admin lo
 *    haya fijado (`priceLocked`); aun fijado, si el costo nuevo lo supera se
 *    recalcula para no vender a pérdida.
 *  - `in_catalog: false` la oculta como retirada.
 *  - Agotada (stock 0) se apaga. Sólo se vuelve a encender si estaba apagada
 *    POR agotada (stock 0 antes), no la apagó el admin y no está retirada: un
 *    aviso no sabe si la oferta sigue `active` en el proveedor, así que una
 *    oferta apagada por otro motivo la reactiva únicamente la sync completa.
 */
export function productPatchFromChange(
  product: CoProductState,
  change: CoProductChange,
  freshPrice: (costUsd: number) => number
): { patch: Partial<Product>; lossGuard: boolean } {
  const patch: Partial<Product> = {};
  let lossGuard = false;

  const cost = centralOne.parseAmount(change.reseller_price);
  if (cost !== null && cost > 0) {
    if (round(cost, 4) !== round(product.costUsd ?? 0, 4)) patch.costUsd = round(cost, 4);
    const locked = product.priceLocked === true;
    if (!locked || product.priceUsd <= 0 || cost > product.priceUsd) {
      lossGuard = locked && product.priceUsd > 0 && cost > product.priceUsd;
      const next = freshPrice(cost);
      if (round(next, 2) !== round(product.priceUsd, 2)) patch.priceUsd = next;
    }
  }

  const stock = stockFromChange(change);
  if (stock !== undefined && stock !== product.stock) patch.stock = stock;

  if (change.in_catalog === false) {
    if (product.active) patch.active = false;
    if (!product.providerRemoved) patch.providerRemoved = true;
  } else if (stock === 0) {
    if (product.active) patch.active = false;
  } else if (
    stock !== undefined &&
    product.stock === 0 &&
    !product.active &&
    product.adminDisabled !== true &&
    product.providerRemoved !== true
  ) {
    patch.active = true;
  }

  return { patch, lossGuard };
}

/** Milisegundos de una fecha (ISO o `Timestamp`); `null` si no se entiende. */
function eventMillis(value: unknown): number | null {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  return null;
}

/**
 * ¿El aviso es más viejo que el último ya aplicado a la oferta? Central One no
 * garantiza el orden de entrega: un `price_changed` atrasado no debe pisar uno
 * más nuevo. Sin alguna de las dos fechas no se puede comparar y se aplica.
 * Función pura.
 */
export function isStaleProductEvent(lastAppliedAt: unknown, occurredAt: unknown): boolean {
  const last = eventMillis(lastAppliedAt);
  const current = eventMillis(occurredAt);
  return last !== null && current !== null && current < last;
}

/**
 * Parte del aviso que todavía se puede aplicar a una oferta. Función pura.
 *
 * Precio y stock llevan relojes separados (`providerPriceEventAt`,
 * `providerStockEventAt`): con uno solo, un `stock_changed` más nuevo hacía
 * descartar entero un `price_changed` que llegó tarde y la subida de costo se
 * perdía hasta la siguiente sync. Además, nada anterior a la última escritura
 * de la sync (`providerSyncedAt`, que se toma ANTES de leer el catálogo) se
 * aplica: la sync ya trajo un estado más nuevo y el aviso atrasado lo pisaría.
 */
export function freshProductChange(
  change: CoProductChange,
  clocks: { priceEventAt?: unknown; stockEventAt?: unknown; syncedAt?: unknown },
  occurredAt: unknown
): { change: CoProductChange; price: 'fresh' | 'stale' | 'absent'; stock: 'fresh' | 'stale' | 'absent' } {
  const hasPrice = change.reseller_price !== undefined && change.reseller_price !== null;
  const hasStock =
    (change.in_stock !== undefined && change.in_stock !== null) ||
    (change.available_stock !== undefined && change.available_stock !== null) ||
    (change.in_catalog !== undefined && change.in_catalog !== null);
  const olderThanSync = isStaleProductEvent(clocks.syncedAt, occurredAt);
  const price = !hasPrice
    ? 'absent'
    : olderThanSync || isStaleProductEvent(clocks.priceEventAt, occurredAt)
      ? 'stale'
      : 'fresh';
  const stock = !hasStock
    ? 'absent'
    : olderThanSync || isStaleProductEvent(clocks.stockEventAt, occurredAt)
      ? 'stale'
      : 'fresh';
  const fresh: CoProductChange = { product_id: change.product_id };
  if (price === 'fresh') fresh.reseller_price = change.reseller_price;
  if (stock === 'fresh') {
    if (change.in_stock !== undefined) fresh.in_stock = change.in_stock;
    if (change.available_stock !== undefined) fresh.available_stock = change.available_stock;
    if (change.in_catalog !== undefined) fresh.in_catalog = change.in_catalog;
  }
  return { change: fresh, price, stock };
}

/**
 * Extra de Free Fire que la sync añadió a un juego de Inefable (D10). No se
 * actualiza desde aquí (el juego y el precio son del admin), pero un cambio de
 * Central One que lo deja a pérdida o fuera de venta se avisa.
 */
function isFreeFireExtra(data: FirebaseFirestore.DocumentData): boolean {
  return data.provider === 'centralone' && data.centralOneExtra === true;
}

/** Un aviso por extra y por instancia cada hora: los cambios de precio llegan en ráfagas. */
const EXTRA_ALERT_EVERY_MS = 60 * 60_000;
const lastExtraAlertMs = new Map<string, number>();

/**
 * ¿El cambio deja un extra de Free Fire vendiéndose a pérdida o sin que
 * Central One lo entregue? Devuelve el motivo, o `null`. Función pura.
 */
export function extraChangeProblem(
  extra: { priceUsd: number; active: boolean; calls?: Array<{ packageId?: unknown }> },
  change: CoProductChange
): string | null {
  if (!extra.active) return null;
  const cost = centralOne.parseAmount(change.reseller_price);
  // Un extra de varias llamadas (el combo de nivel) no se puede comparar con el
  // costo de una sola oferta.
  const single = (extra.calls?.length ?? 1) <= 1;
  if (single && cost !== null && cost > 0 && cost >= extra.priceUsd) {
    return `Central One cobra $${cost.toFixed(2)} y se vende a $${extra.priceUsd.toFixed(2)}`;
  }
  if (change.in_catalog === false) return 'Central One lo retiró de su catálogo';
  if (change.in_stock === false || change.available_stock === 0) return 'Central One lo tiene agotado';
  return null;
}

/**
 * Oferta de la sincronización de Central One (`co-…`). Los extras de Free Fire
 * en juegos de Inefable y los productos sembrados no se tocan desde aquí.
 */
function isSyncedCentralOneProduct(id: string, data: FirebaseFirestore.DocumentData): boolean {
  return (
    data.provider === 'centralone' &&
    id.startsWith('co-') &&
    typeof data.gameId === 'string' &&
    data.gameId.startsWith('co-') &&
    Boolean(data.providerSyncedAt)
  );
}

/**
 * Recalcula `productCount` y `minPriceUsd` de los juegos tocados: la tienda
 * los muestra en la tarjeta del juego y si no quedarían viejos hasta la
 * siguiente sync.
 */
async function refreshGameSummaries(gameIds: string[]): Promise<void> {
  for (const gameId of gameIds) {
    const snap = await products().where('gameId', '==', gameId).get();
    const prices = snap.docs
      .map((doc) => doc.data())
      .filter((data) => data.active === true)
      .map((data) => Number(data.priceUsd))
      .filter((price) => Number.isFinite(price) && price > 0);
    await games()
      .doc(gameId)
      .set(
        {
          productCount: prices.length,
          minPriceUsd: prices.length ? round(Math.min(...prices), 2) : null,
          updatedAt: now(),
        },
        { merge: true }
      );
  }
}

/** Avisa (como mucho una vez por hora y extra) de los extras de Free Fire afectados. */
async function alertExtraProblems(problems: Array<{ id: string; gameId: string; problem: string }>): Promise<void> {
  const nowMs = Date.now();
  const due = problems.filter((item) => nowMs - (lastExtraAlertMs.get(item.id) ?? 0) >= EXTRA_ALERT_EVERY_MS);
  if (due.length === 0) return;
  for (const item of due) lastExtraAlertMs.set(item.id, nowMs);
  log.warn('Cambio de Central One en extras de Free Fire que la sync no actualiza', {
    ids: due.map((item) => item.id),
  });
  await adminAlerts.alert({
    kind: 'provider_down',
    severity: 'warning',
    title: 'Revisa extras de Free Fire',
    body: [
      'Central One cambió ofertas que también se venden como extras en los Free Fire de Inefable. Esos productos no se actualizan solos: súbeles el precio o apágalos desde Productos.',
      ...due.map((item) => `• ${item.id} (${item.gameId}): ${item.problem}.`),
    ].join('\n'),
    link: '/admin/productos',
    data: { ids: due.map((item) => item.id) },
  });
}

/** Aplica `product.price_changed` / `product.stock_changed` a las ofertas `co-`. */
async function applyProductChanges(changes: CoProductChange[], occurredAt: string | null): Promise<string> {
  const byId = new Map<string, CoProductChange>();
  for (const change of changes) {
    const id = typeof change?.product_id === 'string' ? change.product_id.trim() : '';
    if (id) byId.set(id, change);
  }
  if (byId.size === 0) return 'sin productos';

  const ids = [...byId.keys()];
  const snaps = await Promise.all(
    Array.from({ length: Math.ceil(ids.length / IN_CHUNK) }, (_, i) =>
      products()
        .where('providerOfferId', 'in', ids.slice(i * IN_CHUNK, (i + 1) * IN_CHUNK))
        .get()
    )
  );

  const config = await getConfig();
  const margin = config.pricing.defaultMarginPercent;
  const roundStep = config.pricing.roundToUsd;
  const freshPrice = (cost: number) => applyMargin(cost, margin, roundStep);
  // Se guarda tal cual llega (ISO) sólo si se entiende como fecha.
  const eventAt = occurredAt && eventMillis(occurredAt) !== null ? occurredAt : null;
  const timestamp = now();
  const touchedGames = new Set<string>();
  let batch = db.batch();
  let pending = 0;
  let updated = 0;
  let stale = 0;

  const extraProblems: Array<{ id: string; gameId: string; problem: string }> = [];

  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const data = doc.data();
      if (!isSyncedCentralOneProduct(doc.id, data)) {
        if (isFreeFireExtra(data)) {
          const change = byId.get(String(data.providerOfferId));
          const problem = change
            ? extraChangeProblem(
                {
                  priceUsd: Number(data.priceUsd ?? 0),
                  active: data.active === true,
                  calls: Array.isArray(data.calls) ? data.calls : [],
                },
                change
              )
            : null;
          if (problem) extraProblems.push({ id: doc.id, gameId: String(data.gameId ?? ''), problem });
        }
        continue;
      }
      const raw = byId.get(String(data.providerOfferId));
      if (!raw) continue;
      const fresh = freshProductChange(
        raw,
        {
          priceEventAt: data.providerPriceEventAt,
          stockEventAt: data.providerStockEventAt,
          syncedAt: data.providerSyncedAt,
        },
        eventAt
      );
      if (fresh.price === 'stale' || fresh.stock === 'stale') stale += 1;
      if (fresh.price !== 'fresh' && fresh.stock !== 'fresh') continue;
      const change = fresh.change;

      const { patch, lossGuard } = productPatchFromChange(
        {
          costUsd: Number(data.costUsd ?? 0),
          priceUsd: Number(data.priceUsd ?? 0),
          stock: data.stock === undefined ? null : (data.stock as number | null),
          active: data.active === true,
          providerRemoved: data.providerRemoved === true,
          adminDisabled: data.adminDisabled === true,
          priceLocked: data.priceLocked === true,
        },
        change,
        freshPrice
      );
      if (lossGuard) {
        log.warn('Central One subió el costo por encima del precio fijado: se recalcula con margen', {
          productId: doc.id,
          costUsd: patch.costUsd ?? data.costUsd,
          lockedPriceUsd: data.priceUsd,
          priceUsd: patch.priceUsd ?? null,
        });
      }

      // Aunque no cambie nada se adelanta el reloj de lo que traía el aviso:
      // uno más viejo que llegue después ya no podrá aplicarse.
      const clocks: Record<string, string> = {};
      if (eventAt !== null) {
        if (fresh.price === 'fresh' && eventMillis(data.providerPriceEventAt) !== eventMillis(eventAt)) {
          clocks.providerPriceEventAt = eventAt;
        }
        if (fresh.stock === 'fresh' && eventMillis(data.providerStockEventAt) !== eventMillis(eventAt)) {
          clocks.providerStockEventAt = eventAt;
        }
      }
      if (Object.keys(patch).length === 0) {
        if (Object.keys(clocks).length === 0) continue;
        batch.set(doc.ref, clocks, { merge: true });
      } else {
        batch.set(doc.ref, { ...patch, ...clocks, updatedAt: timestamp }, { merge: true });
        touchedGames.add(String(data.gameId));
        updated += 1;
      }
      pending += 1;
      if (pending >= 400) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
  }
  if (pending > 0) await batch.commit();

  if (touchedGames.size > 0) await refreshGameSummaries([...touchedGames]);
  await alertExtraProblems(extraProblems);
  if (stale > 0) log.info('Webhook de Central One: avisos de producto atrasados ignorados', { stale, occurredAt });
  return stale > 0 ? `${updated} ofertas actualizadas, ${stale} avisos atrasados` : `${updated} ofertas actualizadas`;
}

/** Procesa un aviso ya verificado y no repetido. Devuelve un resumen para la respuesta. */
async function handleCentralOneEvent(event: string, body: CoWebhookBody): Promise<string> {
  if (event === 'webhook.test') return 'test';

  if (event.startsWith('order.')) {
    // El aviso sólo dispara: el estado real lo decide `GET /orders/{id}` dentro
    // del resolvedor. La llave (`RF-XXXXXX-1`, o `-r2` tras rotar) encuentra la
    // orden aunque el aviso llegue antes de que guardáramos el id de Central
    // One (POST ambiguo); el `order.id` firmado viaja con ella para poder
    // preguntar por ese pedido. El `reference_code` es suyo y no sirve.
    const clean = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null;
    const idempotencyKey = clean(body.order?.idempotency_key);
    const providerOrderId = clean(body.order?.id);
    if (!idempotencyKey && !providerOrderId) return 'sin pedido';
    const outcome = await resolveCentralOneWebhookOrder({ providerOrderId, idempotencyKey });
    if (!outcome.matched) return outcome.result ?? 'orden no encontrada';
    return outcome.result ?? 'resuelta';
  }

  if (event === 'product.price_changed' || event === 'product.stock_changed') {
    const occurredAt = typeof body.occurred_at === 'string' ? body.occurred_at.trim() || null : null;
    return applyProductChanges(Array.isArray(body.products) ? body.products : [], occurredAt);
  }

  if (event === 'balance.low') {
    if (Date.now() - lastBalanceAlertMs < BALANCE_ALERT_EVERY_MS) return 'saldo bajo (ya avisado)';
    lastBalanceAlertMs = Date.now();
    const available = centralOne.parseAmount(body.balance?.available);
    const threshold = centralOne.parseAmount(body.balance?.threshold);
    await adminAlerts.alert({
      kind: 'low_balance',
      severity: available !== null && available <= 0 ? 'critical' : 'warning',
      title: 'Saldo bajo en Central One',
      body:
        available !== null
          ? `Saldo disponible: $${available.toFixed(2)}${
              threshold !== null ? ` (Central One avisa por debajo de $${threshold.toFixed(2)})` : ''
            }. Recárgalo o las próximas recargas no saldrán.`
          : 'Central One avisa que el saldo está bajo. Recárgalo o las próximas recargas no saldrán.',
      link: '/admin/configuracion',
      data: { provider: 'centralone', balanceUsd: available, threshold },
    });
    return 'saldo bajo';
  }

  return 'evento ignorado';
}

export interface CentralOneWebhookInput {
  rawBody: Buffer | string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

/**
 * Todo el webhook de Central One salvo Express: secreto, firma, identidad del
 * aviso, candado contra repetidos y despacho del evento con presupuesto de
 * tiempo. Separado de la ruta para poder probarlo sin servidor.
 *
 *  - 503 sin secreto: Central One reintenta cuando esté cargado y, mientras,
 *    el cron resuelve los pedidos. Aceptar avisos sin firmar sería peor.
 *  - 401 con firma inválida o timestamp viejo.
 *  - 400 si cabecera y cuerpo dicen eventos distintos.
 *  - 200 en todo lo demás, aunque el proceso falle: un reenvío no arregla un
 *    fallo nuestro, y el cron (pedidos) o la sync horaria (catálogo) lo cubren.
 */
export async function processCentralOneWebhook(
  input: CentralOneWebhookInput
): Promise<{ status: number; resultado: string }> {
  const secret = centralOneWebhookSecret();
  if (!secret) {
    log.warn('Webhook de Central One recibido sin CENTRAL_ONE_WEBHOOK_SECRET configurado');
    return { status: 503, resultado: 'webhook no configurado' };
  }

  const verified = centralOne.verifyWebhookSignature(input.rawBody ?? '', input.headers, secret);
  if (!verified.ok) {
    log.warn('Webhook de Central One con firma inválida', { reason: verified.reason });
    return { status: 401, resultado: 'firma inválida' };
  }

  const body = (input.body && typeof input.body === 'object' ? input.body : {}) as CoWebhookBody;
  const headerValue = (name: string) => {
    const value = input.headers[name];
    return (Array.isArray(value) ? value[0] : value) ?? null;
  };
  const headerEvent = headerValue('x-centralone-event');
  const headerEventId = headerValue('x-centralone-event-id');
  const { event, eventId, mismatch } = resolveEventIdentity(body, {
    event: headerEvent,
    eventId: headerEventId,
  });
  if (mismatch) {
    log.warn('Webhook de Central One: las cabeceras no coinciden con el cuerpo firmado', {
      event,
      eventId,
      headerEvent,
      headerEventId,
    });
    return { status: 400, resultado: 'cabeceras inconsistentes' };
  }
  void stampLastWebhook();

  if (eventId && !(await rememberEvent(eventId, event))) {
    return { status: 200, resultado: 'repetido' };
  }

  // Sólo identificadores: el cuerpo puede traer códigos entregados.
  log.info('Webhook de Central One recibido', {
    event,
    eventId,
    sequence: body.sequence ?? null,
    referenceCode: body.order?.reference_code ?? null,
    idempotencyKey: body.order?.idempotency_key ?? null,
    providerStatus: body.order?.status ?? null,
    products: Array.isArray(body.products) ? body.products.length : null,
  });

  if (!event) return { status: 200, resultado: 'sin evento' };

  const work = handleCentralOneEvent(event, body).catch((error: unknown) => {
    log.error('Webhook de Central One: no se pudo procesar el aviso', {
      event,
      eventId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'error al procesar';
  });
  // Central One corta a los 10 s y reintenta: pasado el presupuesto se
  // responde igual y el trabajo sigue lo que la instancia le deje.
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('en proceso'), CENTRAL_ONE_BUDGET_MS);
  });
  const resultado = await Promise.race([work, budget]);
  if (timer) clearTimeout(timer);
  return { status: 200, resultado };
}

/**
 * Webhook de Central One: `POST /webhooks/centralone`
 * (`https://recargasrefillstore.com/api/webhooks/centralone`). La URL no lleva
 * token: la protege la firma HMAC con `CENTRAL_ONE_WEBHOOK_SECRET`.
 */
webhooksRouter.post(
  '/centralone',
  asyncHandler(async (req, res) => {
    const { status, resultado } = await processCentralOneWebhook({
      rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
      headers: req.headers,
      body: req.body,
    });
    res.status(status).json({ ok: status < 300, resultado });
  })
);

/**
 * Webhook para el bot de Telegram de soporte automatizado y administración rápida.
 *
 * CRÍTICO: Debe esperarse (`await`) la resolución completa de `handleTelegramSupportWebhook`
 * ANTES de enviar el 200 OK para evitar que Google Cloud estrangule la CPU y corte las
 * llamadas asíncronas a Firestore / proveedores externos.
 */
webhooksRouter.post(
  ['/telegram/support', '/telegram/support/:token'],
  asyncHandler(async (req, res) => {
    try {
      await handleTelegramSupportWebhook(req.body, req.params.token);
    } catch (err) {
      log.error('Error procesando webhook de Telegram Support Bot', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return res.status(200).json({ ok: true });
  })
);
