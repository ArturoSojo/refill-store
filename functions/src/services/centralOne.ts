/**
 * Integración con Central One API v1 para la validación de ID de jugador en tiempo real.
 *
 * Manual de integración y consideraciones críticas:
 * 1. Base URL: https://portal.centraloneglobal.com/api/v1
 * 2. Límite estricto de 30 consultas cada 60 segundos por cuenta en POST /player/validate.
 *    Para proteger la cuota, las cuentas válidas se almacenan en caché (Firestore: playerIdCache)
 *    durante 30 días.
 * 3. Timeout estricto de 10 segundos por llamada.
 * 4. Manejo de estados:
 *    - 'valid': Cuenta confirmada, retorna el apodo del jugador y guarda en caché.
 *    - 'invalid': El ID no existe en el juego o región.
 *    - 'unverified' / 429 / 5xx / timeout: No frena la venta, se degrada elegantemente.
 *
 * Además es el cliente de todo lo demás que se le pide a Central One (catálogo,
 * saldo, pedidos, códigos y webhooks). Reglas que este módulo hace cumplir:
 *
 *  A. **Un pedido es uno solo.** `POST /orders` lleva `Idempotency-Key`; con la
 *     misma llave Central One devuelve el pedido original sin cobrar dos veces.
 *     Un 5xx, 429 o 409 de llave NO es «no se compró»: sale como `ambiguous`
 *     (ver `isAmbiguousCreateFailure`) y el despacho repite con la MISMA llave.
 *     Una llave nueva sólo procede cuando `getOrder` confirma el pedido cerrado
 *     sin entregar.
 *  B. **El éxito sale del estado de TODAS las líneas**, nunca de que exista un
 *     id. Un estado desconocido es «en curso» y se sigue consultando.
 *  C. **Los códigos nunca se loguean ni se guardan en `raw`** (`stripCodes`):
 *     sólo salen de `getOrderCodes` hacia `deliveredCodes`.
 *  D. **Importes con 4 decimales** (`parseAmount`), la precisión con la que cobra.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { centralOneApiKey, centralOneBaseUrl } from '../config/env';
import { now, playerIdCache } from '../config/firebase';
import { log, stripCodes } from '../lib/logger';

export interface SupportedGameConfig {
  gameSlug: string;
  name: string;
  productId: string;
  targetFields: string[];
  requiresServer: boolean;
  buildPayload: (playerId: string, serverId?: string | null) => Record<string, string>;
}

export const CENTRAL_ONE_SUPPORTED_GAMES: Record<string, SupportedGameConfig> = {
  'free-fire': {
    gameSlug: 'free-fire',
    name: 'Free Fire',
    productId: 'e7d8be5d-de17-4731-a3a0-9c6554c5ca78',
    targetFields: ['player_id'],
    requiresServer: false,
    buildPayload: (playerId: string) => ({ player_id: playerId.trim() }),
  },
  'blood-strike': {
    gameSlug: 'blood-strike',
    name: 'Blood Strike',
    productId: 'c98ff6be-e087-4cdc-80a2-9a784e0e6700',
    targetFields: ['game_user_id'],
    requiresServer: false,
    buildPayload: (playerId: string) => ({ game_user_id: playerId.trim() }),
  },
  'mobile-legends': {
    gameSlug: 'mobile-legends',
    name: 'Mobile Legends',
    productId: 'e4f28fe6-7031-429a-9396-7df14ad7bc68',
    targetFields: ['player_id', 'server_id'],
    requiresServer: true,
    buildPayload: (playerId: string, serverId?: string | null) => ({
      player_id: playerId.trim(),
      server_id: (serverId ?? '').trim(),
    }),
  },
  'pubg-mobile': {
    gameSlug: 'pubg-mobile',
    name: 'PUBG Mobile',
    productId: '8bedca14-2c9e-4aeb-a8ea-cd414246abe0',
    targetFields: ['game_user_id'],
    requiresServer: false,
    buildPayload: (playerId: string) => ({ game_user_id: playerId.trim() }),
  },
  'arena-breakout': {
    gameSlug: 'arena-breakout',
    name: 'Arena Breakout',
    productId: '4717ed5f-1a53-402d-b300-eca115c4b93a',
    targetFields: ['game_user_id'],
    requiresServer: false,
    buildPayload: (playerId: string) => ({ game_user_id: playerId.trim() }),
  },
};

/** Normaliza diferentes variantes de slugs usados en la tienda hacia la clave oficial. */
export function normalizeGameSlug(rawSlug: string): string | null {
  const s = (rawSlug || '').trim().toLowerCase();
  if (
    s === 'free-fire' ||
    s === 'freefire' ||
    s === 'freefire-id' ||
    s.includes('free-fire') ||
    s.includes('freefire')
  ) {
    return 'free-fire';
  }
  if (
    s === 'blood-strike' ||
    s === 'bloodstrike' ||
    s.includes('blood-strike') ||
    s.includes('bloodstrike')
  ) {
    return 'blood-strike';
  }
  if (
    s === 'mobile-legends' ||
    s === 'mobilelegends' ||
    s === 'mlbb' ||
    s.includes('mobile-legends') ||
    s.includes('mobile_legends')
  ) {
    return 'mobile-legends';
  }
  if (
    s === 'pubg-mobile' ||
    s === 'pubg_mobile' ||
    s === 'pubg' ||
    (s.includes('pubg') && s.includes('mobile'))
  ) {
    return 'pubg-mobile';
  }
  if (
    !s.includes('infinite') &&
    (s === 'arena-breakout' ||
      s === 'arena_breakout' ||
      s === 'arenabreakout' ||
      (s.includes('arena') && s.includes('breakout')))
  ) {
    return 'arena-breakout';
  }
  return null;
}

export function isSupportedGame(rawSlug: string): boolean {
  return normalizeGameSlug(rawSlug) !== null;
}

/**
 * Construye el target_payload adecuado según el juego para Central One API v1:
 * - Free Fire: { player_id }
 * - Blood Strike / PUBG / Arena Breakout: { game_user_id }
 * - Mobile Legends: { player_id, server_id }
 */
export function buildCentralOneTargetPayload(
  gameSlug: string,
  playerId: string,
  serverId?: string | null,
  playerFields?: Record<string, string>
): Record<string, string> {
  const norm = normalizeGameSlug(gameSlug) || gameSlug.toLowerCase();
  const rawId = (
    playerFields?.game_user_id ||
    playerFields?.player_id ||
    playerId ||
    ''
  ).trim();

  if (
    norm === 'blood-strike' ||
    norm.includes('blood-strike') ||
    norm.includes('bloodstrike') ||
    norm.includes('arena-breakout') ||
    norm.includes('pubg')
  ) {
    return { game_user_id: rawId };
  }

  if (norm === 'mobile-legends' || norm.includes('mobile-legends') || norm.includes('mlbb')) {
    const rawServer = (
      playerFields?.server_id ||
      playerFields?.zone_id ||
      serverId ||
      ''
    ).trim();
    return { player_id: rawId, server_id: rawServer };
  }

  // Free Fire y otros por defecto
  return { player_id: rawId };
}

export function buildCacheKey(
  gameSlug: string,
  playerId: string,
  serverId?: string | null
): string {
  const cleanGame = (gameSlug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const cleanPlayer = (playerId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const cleanServer = serverId
    ? serverId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_')
    : '';
  return cleanServer ? `${cleanGame}_${cleanPlayer}_${cleanServer}` : `${cleanGame}_${cleanPlayer}`;
}

export interface ValidatePlayerParams {
  gameSlug: string;
  playerId: string;
  serverId?: string | null;
}

export type PlayerValidationStatus = 'valid' | 'invalid' | 'unverified';

export interface PlayerValidationResult {
  status: PlayerValidationStatus;
  playerName: string | null;
  message?: string;
  reason?: string;
  cached?: boolean;
  supported: boolean;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/**
 * Valida la existencia de un ID de jugador en Central One con caché inteligente de 30 días.
 */
export async function validatePlayerId(
  params: ValidatePlayerParams
): Promise<PlayerValidationResult> {
  const normalizedSlug = normalizeGameSlug(params.gameSlug);
  if (!normalizedSlug || !CENTRAL_ONE_SUPPORTED_GAMES[normalizedSlug]) {
    return {
      status: 'unverified',
      playerName: null,
      reason: 'not_supported',
      message: 'Este juego no soporta comprobación previa de ID.',
      supported: false,
    };
  }

  const gameConfig = CENTRAL_ONE_SUPPORTED_GAMES[normalizedSlug];
  const playerId = (params.playerId || '').trim();
  const serverId = (params.serverId || '').trim() || null;

  if (!playerId) {
    return {
      status: 'invalid',
      playerName: null,
      message: 'Debes ingresar un ID de jugador para verificar.',
      supported: true,
    };
  }

  if (gameConfig.requiresServer && !serverId) {
    return {
      status: 'invalid',
      playerName: null,
      message: 'Debes ingresar tu Zone ID / Servidor para verificar.',
      supported: true,
    };
  }

  const cacheKey = buildCacheKey(gameConfig.gameSlug, playerId, serverId);

  // 1. Verificación en caché de Firestore
  try {
    const cacheDoc = await playerIdCache().doc(cacheKey).get();
    if (cacheDoc.exists) {
      const data = cacheDoc.data();
      if (data && data.status === 'valid') {
        let cachedAtMs = 0;
        if (data.cachedAt && typeof data.cachedAt.toMillis === 'function') {
          cachedAtMs = data.cachedAt.toMillis();
        } else if (data.cachedAt) {
          cachedAtMs = new Date(data.cachedAt).getTime();
        }

        if (cachedAtMs > 0 && Date.now() - cachedAtMs < THIRTY_DAYS_MS) {
          log.info('Player ID validado desde caché de Central One', {
            game: gameConfig.gameSlug,
            playerId,
            playerName: data.playerName,
          });
          return {
            status: 'valid',
            playerName: data.playerName || null,
            cached: true,
            supported: true,
          };
        }
      }
    }
  } catch (err) {
    log.warn('Error al consultar caché de playerIdCache', { error: String(err) });
  }

  // 2. Consulta a la API de Central One
  const apiKey = centralOneApiKey();
  if (!apiKey) {
    log.warn('Central One API Key no configurada; retornando unverified');
    return {
      status: 'unverified',
      playerName: null,
      reason: 'not_configured',
      message:
        'No fue posible verificar el nombre en este momento. Asegúrate de que el ID sea correcto.',
      supported: true,
    };
  }

  const targetPayload = gameConfig.buildPayload(playerId, serverId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${centralOneBaseUrl()}/player/validate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_id: gameConfig.productId,
        target_payload: targetPayload,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      if (response.status === 429) {
        log.warn('Límite de Central One alcanzado (30 req/min); degradando a unverified');
        return {
          status: 'unverified',
          playerName: null,
          reason: 'rate_limited',
          message:
            'No fue posible verificar el nombre en este momento. Asegúrate de que el ID sea correcto.',
          supported: true,
        };
      }

      log.warn('Central One respondió error HTTP', {
        status: response.status,
        game: gameConfig.gameSlug,
      });
      return {
        status: 'unverified',
        playerName: null,
        reason: `http_${response.status}`,
        message:
          'No fue posible verificar el nombre en este momento. Asegúrate de que el ID sea correcto.',
        supported: true,
      };
    }

    const data = (await response.json()) as {
      success?: boolean;
      status?: string;
      player?: { name?: string | null };
      reason?: string;
    };

    if (data.status === 'valid') {
      const playerName =
        data.player?.name && typeof data.player.name === 'string' && data.player.name.trim()
          ? data.player.name.trim()
          : null;

      // Guardar en caché sin bloquear si falla la escritura
      playerIdCache()
        .doc(cacheKey)
        .set({
          gameSlug: gameConfig.gameSlug,
          playerId,
          serverId: serverId || null,
          playerName,
          status: 'valid',
          cachedAt: now(),
          updatedAt: now(),
        })
        .catch((err) => {
          log.warn('Fallo al escribir en playerIdCache', { error: String(err) });
        });

      return {
        status: 'valid',
        playerName,
        cached: false,
        supported: true,
      };
    }

    if (data.status === 'invalid') {
      return {
        status: 'invalid',
        playerName: null,
        message: 'El ID ingresado no existe en este juego. Verifica tus datos.',
        supported: true,
      };
    }

    return {
      status: 'unverified',
      playerName: null,
      reason: data.reason || 'unverified',
      message:
        'No fue posible verificar el nombre en este momento. Asegúrate de que el ID sea correcto.',
      supported: true,
    };
  } catch (error) {
    clearTimeout(timer);
    const reason = error instanceof Error ? error.name : 'network_error';
    log.warn('Fallo de red o timeout consultando Central One validate', {
      reason,
      error: String(error),
    });
    return {
      status: 'unverified',
      playerName: null,
      reason,
      message:
        'No fue posible verificar el nombre en este momento. Asegúrate de que el ID sea correcto.',
      supported: true,
    };
  }
}


export function isCentralOneConfigured(): boolean {
  return Boolean(centralOneApiKey());
}

export interface CentralOneFailureInfo {
  code?: string | null;
  message?: string | null;
  message_es?: string | null;
  action?: string | null;
}

export function formatCentralOneFailure(failure?: CentralOneFailureInfo | null): string {
  if (!failure) return 'Error desconocido en Central One.';
  const code = (failure.code || '').toLowerCase();
  const action = (failure.action || '').toLowerCase();

  if (code === 'not_eligible' || action === 'do_not_retry') {
    return 'La cuenta del jugador no es elegible para este nivel (ya fue reclamado anteriormente o no cumple el requisito).';
  }
  if (code === 'invalid_player') {
    return 'El ID de jugador es inválido para este juego o región.';
  }
  if (code === 'out_of_stock') {
    return 'Producto agotado temporalmente en el proveedor.';
  }
  if (code === 'provider_unavailable') {
    return 'Proveedor en mantenimiento o temporalmente no disponible.';
  }
  if (code === 'price_changed') {
    return 'El precio del producto cambió antes de completarse la orden.';
  }
  if (code === 'insufficient_balance') {
    return 'Saldo insuficiente en la cuenta mayorista del proveedor.';
  }
  return (
    failure.message_es ||
    failure.message ||
    `Error reportado por Central One: ${code || 'fallo'}`
  );
}

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

/**
 * «12.3400» → 12.34. `null` si no es un importe válido.
 *
 * Central One manda los importes como texto con 4 decimales, que es la
 * precisión con la que cobra: se redondea ahí y no a 2, o el costo guardado
 * no cuadraría con lo que de verdad descuenta del saldo.
 */
export function parseAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

/**
 * Arma `target_payload` con exactamente las claves que pide el producto
 * (`target_fields` del catálogo, congeladas en la orden).
 *
 * Cada clave sale de `values[clave]` (los campos que llenó el comprador, que en
 * los juegos de Central One se llaman igual que en el proveedor). Si falta, se
 * cae al ID principal para la primera clave y al secundario (Zone ID) para la
 * segunda: así una orden de un juego con campos antiguos (`playerId`) también
 * llega completa. Los vacíos se omiten: Central One rechaza la línea con un
 * mensaje claro en vez de recibir un dato inventado.
 */
export function buildTargetPayloadFromFields(
  targetFields: string[],
  values: Record<string, string>,
  fallback: { playerId?: string | null; playerId2?: string | null }
): Record<string, string> {
  const payload: Record<string, string> = {};
  const isIdKey = (k: string) => k === 'player_id' || k === 'game_user_id' || k === 'user_id';

  targetFields.forEach((key, index) => {
    let raw: string | null | undefined = values?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      if (isIdKey(key)) {
        raw = fallback.playerId ?? values?.game_user_id ?? values?.player_id ?? values?.playerId ?? null;
      } else if (index === 0) {
        raw = fallback.playerId;
      } else if (index === 1) {
        raw = fallback.playerId2;
      } else {
        raw = null;
      }
    }
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (value) payload[key] = value;
  });
  return payload;
}

/**
 * `RF-8K3M2Q-1` o `RF-8K3M2Q-1-r2` → `RF-8K3M2Q`. `null` si la llave no es nuestra.
 *
 * El despacho usa como `Idempotency-Key` el código de la orden más el número de
 * llamada (y `-rN` cuando rota la llave tras un fallo confirmado). Los avisos
 * del webhook traen esa llave, así que de ella sale la orden sin depender del
 * índice `providerOrders` (que no existe si el POST nunca llegó a responder).
 */
export function orderCodeFromIdempotencyKey(key: string): string | null {
  const match = /^(RF-[A-Z0-9]{6})(?:-\d+)?(?:-r\d+)?$/i.exec((key ?? '').trim());
  return match ? match[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Tipos de la API (catálogo, cuenta y webhooks)
// ---------------------------------------------------------------------------

export interface CoTargetOption {
  value: string;
  label: string;
}

export interface CoTargetField {
  key: string;
  label: string;
  type: 'text' | 'select' | string;
  options: CoTargetOption[] | null;
}

export interface CoCatalogItem {
  product_id: string;
  sku: string;
  name: string;
  category: 'gaming_topup' | 'gift_card' | string;
  product_type: string;
  market: string;
  region: string;
  currency: string;
  /** Texto con 4 decimales («12.3400»). */
  reseller_price: string;
  status: string;
  updated_at: string;
  product_family_id: string;
  product_family_name: string;
  requires_target: boolean;
  target_fields: string[];
  target_schema: CoTargetField[];
  in_stock: boolean;
  /** `null` = cantidad no informada (no es cero). */
  available_stock: number | null;
  price_updated_at: string | null;
}

export interface CoCoverage {
  games: Array<{ game: string; regions: string[]; requires_server: boolean }>;
  products: Array<{ product_id: string; name: string; region: string; game: string }>;
}

export interface CoBalance {
  availableUsd: number;
  heldUsd: number;
  totalUsd: number;
  currency: string;
}

/** Endpoint registrado en el portal de Central One (sin el secreto). */
export interface CoWebhookInfo {
  exists: boolean;
  url: string | null;
  events: string[];
  status: string | null;
  includeCodes: boolean | null;
}

export interface CoWebhookDelivery {
  id: string;
  event: string;
  orderReference: string | null;
  status: string;
  attempts: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
}

/** Fallo uniforme de las lecturas de cuenta/catálogo. Nunca lanzan. */
export interface CoFailure {
  ok: false;
  /** `error.code` del proveedor en minúsculas, `http_N`, `network_error`, `timeout` o `missing_config`. */
  code: string;
  message: string;
  /** `0` = no hubo respuesta (red, timeout o sin llave). */
  httpStatus: number;
}

// ---------------------------------------------------------------------------
// Núcleo HTTP de las lecturas nuevas
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Lee el cuerpo como JSON sin lanzar. Se prefiere `text()` porque un proxy
 * puede devolver HTML; `json()` queda para dobles de prueba que sólo lo traen.
 */
async function readJson(response: Response): Promise<Record<string, any> | null> {
  try {
    if (typeof (response as { text?: unknown }).text === 'function') {
      const raw = await response.text();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
    }
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function describeHttpError(httpStatus: number, code: string, providerMessage: string | null): string {
  const suffix = providerMessage ? ` (${code}: ${providerMessage})` : ` (${code})`;
  if (code === 'insufficient_balance') return 'Saldo insuficiente en Central One. Recarga la cuenta para seguir despachando.';
  if (httpStatus === 401 || httpStatus === 403 || code === 'invalid_api_key' || code === 'insufficient_scope') {
    return `Central One rechazó la llave (inválida, revocada o sin el permiso necesario)${suffix}.`;
  }
  if (httpStatus === 404) return `Central One no reconoce ese recurso${suffix}.`;
  if (httpStatus === 429) return 'Central One está limitando las peticiones. Reintenta en unos segundos.';
  if (httpStatus >= 500) return `Central One respondió con un error interno o está en mantenimiento${suffix}.`;
  return `Central One respondió con un error${suffix}.`;
}

interface CoRequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** Reintentos ante red caída o 5xx. Sólo lecturas o POST sin efecto de cobro. */
  retries?: number;
}

/**
 * Llamada genérica para las lecturas de cuenta, catálogo, códigos y webhooks.
 * Nunca lanza y nunca loguea el cuerpo (puede traer códigos o precios).
 *
 * `POST /orders` NO pasa por aquí: tiene su propia política de reintento con
 * la misma `Idempotency-Key` y su propio formato de resultado.
 */
async function coRequest<T = Record<string, any>>(
  method: 'GET' | 'POST',
  path: string,
  options: CoRequestOptions = {}
): Promise<{ ok: true; httpStatus: number; data: T } | CoFailure> {
  const apiKey = centralOneApiKey();
  if (!apiKey) {
    return {
      ok: false,
      code: 'missing_config',
      message: 'CENTRAL_ONE_API_KEY no está configurada.',
      httpStatus: 0,
    };
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const url = `${centralOneBaseUrl().replace(/\/+$/, '')}${path}${suffix}`;
  const retries = options.retries ?? 0;
  let waitedRateLimit = false;

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await readJson(response);
      const httpStatus = response.status;

      if (response.ok) return { ok: true, httpStatus, data: (data ?? {}) as T };

      if (httpStatus >= 500 && attempt < retries) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      // Ventanas fijas de 60 s: una lectura espera una vez; un POST no, porque
      // quien lo pidió (panel) puede reintentar a mano.
      if (httpStatus === 429 && method === 'GET' && !waitedRateLimit) {
        waitedRateLimit = true;
        log.warn('Central One limitó las peticiones; se espera la ventana', { path });
        await sleep(15_000);
        continue;
      }

      const errObj = (data?.error ?? null) as { code?: unknown; message?: unknown; request_id?: unknown } | null;
      const code = (text(errObj?.code) ?? `http_${httpStatus}`).toLowerCase();
      log.warn('Central One respondió con error', {
        method,
        path,
        httpStatus,
        code,
        requestId: text(errObj?.request_id),
      });
      return { ok: false, code, message: describeHttpError(httpStatus, code, text(errObj?.message)), httpStatus };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = (err as Error)?.name === 'AbortError';
      if (attempt < retries) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      log.warn('Fallo de red o timeout consultando Central One', { method, path, timeout: isAbort });
      return {
        ok: false,
        code: isAbort ? 'timeout' : 'network_error',
        message: isAbort
          ? 'Central One no respondió a tiempo.'
          : 'No se pudo contactar a Central One (red caída).',
        httpStatus: 0,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Cuenta y catálogo
// ---------------------------------------------------------------------------

/** Umbral de saldo bajo para alertas en Central One ($35.00 USD). */
export const CENTRAL_ONE_LOW_BALANCE_THRESHOLD_USD = 35.0;

/** `GET /balance`: saldo disponible y retenido por pedidos en curso. */
export async function getBalance(): Promise<{ ok: true; balance: CoBalance } | CoFailure> {
  const result = await coRequest('GET', '/balance', { timeoutMs: 15_000, retries: 1 });
  if (!result.ok) return result;
  // La cuenta llega en la raíz; se acepta también envuelta en `balance` por si
  // el proveedor cambia la forma, antes que mostrar un saldo de 0 falso.
  const source = (result.data?.balance && typeof result.data.balance === 'object'
    ? result.data.balance
    : result.data) as Record<string, unknown>;
  const availableUsd = parseAmount(source?.available_balance);
  if (availableUsd === null) {
    return {
      ok: false,
      code: 'bad_response',
      message: 'Central One devolvió un saldo ilegible.',
      httpStatus: result.httpStatus,
    };
  }
  return {
    ok: true,
    balance: {
      availableUsd,
      heldUsd: parseAmount(source?.held_balance) ?? 0,
      totalUsd: parseAmount(source?.total_balance) ?? availableUsd,
      currency: text(source?.currency) ?? 'USD',
    },
  };
}

/**
 * `GET /catalog`: catálogo completo de la cuenta en una sola respuesta (unos
 * 5 MB, sin paginar), sólo con lo habilitado y al precio de revendedor. De ahí
 * el timeout de 60 s y un único reintento: la sync corre en un trigger de 9 min.
 */
export async function getCatalog(): Promise<
  { ok: true; items: CoCatalogItem[] } | { ok: false; code: string; message: string; httpStatus: number }
> {
  const result = await coRequest<{ items?: unknown }>('GET', '/catalog', { timeoutMs: 60_000, retries: 1 });
  if (!result.ok) return result;
  const items = Array.isArray(result.data?.items) ? (result.data.items as unknown[]) : null;
  if (!items) {
    return {
      ok: false,
      code: 'bad_response',
      message: 'Central One devolvió un catálogo sin `items`.',
      httpStatus: result.httpStatus,
    };
  }
  return {
    ok: true,
    items: items.filter((item): item is CoCatalogItem => Boolean(item) && typeof item === 'object'),
  };
}

/**
 * `GET /player/validate/coverage`: productos cuya comprobación de cuenta da un
 * `valid`/`invalid` fiable. Es lo que decide `validatesPlayerId` de un juego.
 */
export async function getCoverage(): Promise<
  { ok: true; productIds: Set<string> } | { ok: false; message: string }
> {
  const result = await coRequest<Partial<CoCoverage>>('GET', '/player/validate/coverage', {
    timeoutMs: 20_000,
    retries: 1,
  });
  if (!result.ok) return { ok: false, message: result.message };
  const products = Array.isArray(result.data?.products) ? result.data.products : [];
  const productIds = new Set<string>();
  for (const product of products) {
    const id = text(product?.product_id);
    if (id) productIds.add(id);
  }
  return { ok: true, productIds };
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

/** Estado de `createOrder`. `ambiguous` = el pedido pudo entrar: misma llave. */
export type CentralOneCreateOrderStatus =
  | 'created'
  | 'confirmed'
  | 'reserved'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'ambiguous'
  | 'network_error'
  | (string & {});

export interface CentralOneCreateOrderInput {
  catalogItemId: string;
  quantity: number;
  targetPayload: Record<string, string>;
  idempotencyKey: string;
  note?: string;
}

export interface CentralOneCreateOrderResult {
  success: boolean;
  httpStatus: number;
  orderId: string | null;
  referenceCode: string | null;
  /**
   * `failed` = rechazo definitivo (el pedido NO existe: se puede comprar con
   * otra llave). `ambiguous` / `network_error` = no se sabe si entró: sólo se
   * puede repetir con la MISMA llave. Ver `isAmbiguousCreateFailure`.
   */
  status: CentralOneCreateOrderStatus | null;
  totalSaleAmount: number | null;
  currency: string | null;
  errorMessage: string | null;
  failureCode: string | null;
  failureAction: string | null;
  raw: Record<string, unknown>;
}

/**
 * ¿La respuesta HTTP de un POST /orders deja la duda de si el pedido entró?
 *
 * Un 5xx, un 429 o un 409 de llave (otra petición con la misma llave en vuelo,
 * o la llave usada con otro cuerpo) NO dicen «no se compró». Tratarlos como
 * fallo definitivo hacía que el reintento rotara la llave y comprara otra vez.
 * Sólo la falta de saldo o de inventario es un 409 que confirma que no entró.
 */
function isAmbiguousHttp(httpStatus: number, code: string): boolean {
  if (code === 'insufficient_balance' || code === 'insufficient_stock') return false;
  if (code === 'idempotency_key_reused') return true;
  return httpStatus === 0 || httpStatus === 429 || httpStatus === 409 || httpStatus >= 500;
}

/**
 * `true` si el fallo de `createOrder` no descarta que el pedido exista en
 * Central One. Con `true` el despacho NUNCA rota la llave: repite con la misma
 * para recuperar el pedido original (Central One no cobra dos veces).
 */
export function isAmbiguousCreateFailure(r: CentralOneCreateOrderResult): boolean {
  if (r.success) return false;
  const code = (r.failureCode ?? '').toLowerCase();
  // Sin llave no salió ninguna petición: no hay nada que pudiera haber entrado.
  if (code === 'missing_config') return false;
  if (r.status === 'ambiguous' || r.status === 'network_error') return true;
  if (code === 'network_error' || code === 'timeout') return true;
  return isAmbiguousHttp(r.httpStatus, code);
}

const CREATE_TIMEOUT_MS = 12_000;

/**
 * `POST /orders` de una línea. Nunca lanza.
 *
 * Red caída o 5xx se reintentan UNA vez aquí con la misma llave (Central One
 * devuelve el pedido original sin cobrar otra vez). Si aun así no hay
 * respuesta, o vuelve un 5xx, un 429 o un 409 de llave, el resultado es
 * `ambiguous`/`network_error`: el despacho lo deja en curso y lo resuelve
 * repitiendo con la misma llave. `insufficient_balance` es `failed` con ese
 * `failureCode` para que el despacho lo pause en vez de reembolsar.
 */
export async function createOrder(
  input: CentralOneCreateOrderInput
): Promise<CentralOneCreateOrderResult> {
  const apiKey = centralOneApiKey();
  if (!apiKey) {
    return {
      success: false,
      httpStatus: 500,
      orderId: null,
      referenceCode: null,
      status: null,
      totalSaleAmount: null,
      currency: null,
      errorMessage: 'CENTRAL_ONE_API_KEY no está configurada.',
      failureCode: 'missing_config',
      failureAction: 'fix_and_retry',
      raw: {},
    };
  }

  const url = `${centralOneBaseUrl()}/orders`;
  const line: Record<string, unknown> = {
    catalog_item_id: input.catalogItemId,
    quantity: input.quantity || 1,
  };
  // Gift cards: sin datos del jugador no se manda `target_payload` vacío.
  if (input.targetPayload && Object.keys(input.targetPayload).length > 0) {
    line.target_payload = input.targetPayload;
  }
  const body = {
    items: [line],
    note: input.note?.slice(0, 500) || undefined,
  };

  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const data = (await response.json().catch(() => ({}))) as Record<string, any>;
      const httpStatus = response.status;

      if (!response.ok) {
        if (httpStatus >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(700);
          continue;
        }
        const errObj = data.error || data;
        const code = String(errObj.code || `http_${httpStatus}`).toLowerCase();
        const message = errObj.message || 'Error en POST /orders';
        const ambiguous = isAmbiguousHttp(httpStatus, code);

        let formattedError = message;
        if (code === 'insufficient_balance') {
          formattedError = 'Saldo insuficiente en la cuenta mayorista de Central One.';
        } else if (code === 'insufficient_stock') {
          formattedError = 'No hay stock disponible en el proveedor Central One.';
        } else if (httpStatus === 429) {
          formattedError =
            'Límite de solicitudes alcanzado en Central One (rate limited); se reintentará con la misma llave.';
        } else if (ambiguous) {
          formattedError = `Central One no confirmó el pedido (HTTP ${httpStatus}, ${code}); pudo haber entrado y se confirmará con la misma llave.`;
        }

        log.warn('Central One rechazó o no confirmó POST /orders', {
          idempotencyKey: input.idempotencyKey,
          httpStatus,
          code,
          ambiguous,
          requestId: text(errObj.request_id),
        });

        return {
          success: false,
          httpStatus,
          orderId: null,
          referenceCode: null,
          status: ambiguous ? 'ambiguous' : 'failed',
          totalSaleAmount: null,
          currency: null,
          errorMessage: formattedError,
          failureCode: code,
          failureAction: errObj.action || null,
          raw: stripCodes(data),
        };
      }

      const orderData = data.order || {};
      const orderId = orderData.id || null;
      const referenceCode = orderData.reference_code || null;
      const status = String(orderData.status || 'confirmed').toLowerCase();

      return {
        success: true,
        httpStatus,
        orderId,
        referenceCode,
        status,
        totalSaleAmount: parseAmount(orderData.total_sale_amount),
        currency: orderData.currency || 'USD',
        errorMessage: null,
        failureCode: null,
        failureAction: null,
        raw: stripCodes(data),
      };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(700);
        continue;
      }
      const isAbort = (err as Error)?.name === 'AbortError';
      const msg = isAbort
        ? 'Timeout de red contactando Central One POST /orders'
        : (err as Error)?.message || String(err);

      return {
        success: false,
        httpStatus: isAbort ? 504 : 500,
        orderId: null,
        referenceCode: null,
        status: 'network_error',
        totalSaleAmount: null,
        currency: null,
        errorMessage: msg,
        failureCode: isAbort ? 'timeout' : 'network_error',
        failureAction: 'retry_later',
        raw: { error: String(err) },
      };
    }
  }
}

export interface CentralOneOrderDetailResult {
  found: boolean;
  httpStatus: number;
  orderId: string;
  referenceCode: string | null;
  orderStatus: string | null;
  /**
   * Estado representativo de las líneas: la que falló si el pedido cerró sin
   * entregar, la primera en curso si sigue abierto, `completed` si se entregó.
   */
  lineStatus: string | null;
  totalSalePrice: number | null;
  /** Todas las líneas `completed`. */
  isSuccess: boolean;
  /** Ni éxito ni fallo cerrado. Un estado desconocido cuenta como en curso. */
  isPending: boolean;
  /** Alguna línea `failed`/`cancelled`/`refunded` y ninguna en curso. */
  isFailed: boolean;
  /** Suma de `delivered_count` de las líneas: >0 = hay códigos que leer. */
  deliveredCount: number;
  failureCode: string | null;
  failureAction: string | null;
  failureMessage: string | null;
  /** Respuesta sin códigos (`stripCodes`). */
  raw: Record<string, unknown>;
}

const SUCCESS_LINE = new Set(['completed']);
const FAILURE_LINE = new Set(['failed', 'cancelled', 'canceled', 'refunded']);
const SUCCESS_ORDER = new Set(['completed']);
const FAILURE_ORDER = new Set(['failed', 'cancelled', 'canceled', 'refunded']);

export interface CentralOneOrderInterpretation {
  orderStatus: string;
  lineStatus: string;
  referenceCode: string | null;
  totalSalePrice: number | null;
  isSuccess: boolean;
  isPending: boolean;
  isFailed: boolean;
  deliveredCount: number;
  failureCode: string | null;
  failureAction: string | null;
  failureMessage: string | null;
}

/**
 * Interpreta el `order` de `GET /orders/{id}` (o de un aviso). Función pura.
 *
 * Mira TODAS las líneas, no sólo la primera: el éxito exige que todas estén
 * `completed`; el fallo, que alguna haya cerrado sin entregar y ninguna siga
 * en curso. Cualquier otro estado (incluido uno que no conocemos) es «en
 * curso»: se vuelve a consultar en vez de darlo por perdido y reembolsar.
 * Sin líneas, decide el estado del pedido.
 */
export function interpretCentralOneOrder(order: Record<string, any>): CentralOneOrderInterpretation {
  const lines: Array<Record<string, any>> = Array.isArray(order?.items)
    ? order.items.filter((line: unknown) => line && typeof line === 'object')
    : [];
  const orderStatus = String(order?.status ?? '').toLowerCase();
  const lineStatuses = lines.map((line) => String(line.status ?? '').toLowerCase());

  let isSuccess: boolean;
  let isFailed: boolean;
  if (lines.length > 0) {
    const anyOpen = lineStatuses.some((s) => !SUCCESS_LINE.has(s) && !FAILURE_LINE.has(s));
    isSuccess = lineStatuses.every((s) => SUCCESS_LINE.has(s));
    isFailed = !anyOpen && lineStatuses.some((s) => FAILURE_LINE.has(s));
  } else {
    isSuccess = SUCCESS_ORDER.has(orderStatus);
    isFailed = FAILURE_ORDER.has(orderStatus);
  }
  const isPending = !isSuccess && !isFailed;

  const failedLine = lines.find((line) => FAILURE_LINE.has(String(line.status ?? '').toLowerCase()));
  const openStatus = lineStatuses.find((s) => !SUCCESS_LINE.has(s) && !FAILURE_LINE.has(s));
  const lineStatus = isSuccess
    ? 'completed'
    : isFailed
      ? String(failedLine?.status ?? orderStatus ?? 'failed').toLowerCase() || 'failed'
      : openStatus || orderStatus || 'processing';

  const deliveredCount = lines.reduce((sum, line) => {
    const n = Number(line.delivered_count ?? 0);
    return sum + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  const failure = isFailed ? failedLine?.failure || order?.failure || null : null;
  const totalSalePrice =
    lines.length > 0 && lines.some((line) => line.total_sale_price !== undefined && line.total_sale_price !== null)
      ? Math.round(lines.reduce((sum, line) => sum + (parseAmount(line.total_sale_price) ?? 0), 0) * 10_000) / 10_000
      : parseAmount(order?.total_sale_amount);

  return {
    orderStatus,
    lineStatus,
    referenceCode: text(order?.reference_code),
    totalSalePrice,
    isSuccess,
    isPending,
    isFailed,
    deliveredCount,
    failureCode: isFailed ? text(failure?.code) ?? lineStatus : null,
    failureAction: text(failure?.action),
    failureMessage: isFailed
      ? failure
        ? formatCentralOneFailure(failure)
        : 'Central One no pudo entregar el pedido.'
      : null,
  };
}

export async function getOrder(
  orderId: string
): Promise<CentralOneOrderDetailResult> {
  const apiKey = centralOneApiKey();
  if (!apiKey) {
    return {
      found: false,
      httpStatus: 500,
      orderId,
      referenceCode: null,
      orderStatus: null,
      lineStatus: null,
      totalSalePrice: null,
      isSuccess: false,
      isPending: false,
      isFailed: false,
      deliveredCount: 0,
      failureCode: 'missing_config',
      failureAction: null,
      failureMessage: 'CENTRAL_ONE_API_KEY no está configurada.',
      raw: {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const url = `${centralOneBaseUrl()}/orders/${encodeURIComponent(orderId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const data = (await response.json().catch(() => ({}))) as Record<string, any>;
    const httpStatus = response.status;
    const raw = stripCodes(data);

    if (httpStatus === 404) {
      return {
        found: false,
        httpStatus: 404,
        orderId,
        referenceCode: null,
        orderStatus: null,
        lineStatus: null,
        totalSalePrice: null,
        isSuccess: false,
        isPending: false,
        isFailed: false,
        deliveredCount: 0,
        failureCode: 'not_found',
        failureAction: null,
        failureMessage: 'Orden no encontrada en Central One.',
        raw,
      };
    }

    if (!response.ok) {
      return {
        found: false,
        httpStatus,
        orderId,
        referenceCode: null,
        orderStatus: null,
        lineStatus: null,
        totalSalePrice: null,
        isSuccess: false,
        isPending: false,
        isFailed: false,
        deliveredCount: 0,
        failureCode: data.error?.code || `http_${httpStatus}`,
        failureAction: null,
        failureMessage: data.error?.message || 'Error en GET /orders/{id}',
        raw,
      };
    }

    const parsed = interpretCentralOneOrder(data.order || {});

    return {
      found: true,
      httpStatus: 200,
      orderId,
      referenceCode: parsed.referenceCode,
      orderStatus: parsed.orderStatus,
      lineStatus: parsed.lineStatus,
      totalSalePrice: parsed.totalSalePrice,
      isSuccess: parsed.isSuccess,
      isPending: parsed.isPending,
      isFailed: parsed.isFailed,
      deliveredCount: parsed.deliveredCount,
      failureCode: parsed.failureCode,
      failureAction: parsed.failureAction,
      failureMessage: parsed.failureMessage,
      raw,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      found: false,
      httpStatus: (err as Error)?.name === 'AbortError' ? 504 : 500,
      orderId,
      referenceCode: null,
      orderStatus: null,
      lineStatus: null,
      totalSalePrice: null,
      isSuccess: false,
      isPending: false,
      isFailed: false,
      deliveredCount: 0,
      failureCode: 'network_error',
      failureAction: null,
      failureMessage: (err as Error)?.message || String(err),
      raw: { error: String(err) },
    };
  }
}

/**
 * `GET /orders/{id}/codes`: códigos de un pedido entregado (permiso
 * `codes:read`). Nunca se loguean ni se guardan en `providerResponse`: sólo
 * viajan en el resultado para que el despacho los ponga en `deliveredCodes`.
 */
export async function getOrderCodes(
  orderId: string
): Promise<
  | { ok: true; codes: string[]; items: { label: string; code: string }[] }
  | { ok: false; code: string; message: string; httpStatus: number }
> {
  const result = await coRequest<{ order?: { items?: Array<Record<string, any>> } }>(
    'GET',
    `/orders/${encodeURIComponent(orderId)}/codes`,
    { timeoutMs: 15_000, retries: 1 }
  );
  if (!result.ok) {
    if (result.httpStatus === 401 || result.httpStatus === 403) {
      return {
        ...result,
        message:
          'Central One entregó el pedido pero la llave no tiene el permiso codes:read para leer los códigos.',
      };
    }
    return result;
  }

  const items: { label: string; code: string }[] = [];
  for (const line of result.data?.order?.items ?? []) {
    const label = text(line?.product_name) ?? '';
    const codes = Array.isArray(line?.codes) ? line.codes : [];
    for (const entry of codes) {
      // Llega como texto; se acepta también `{ code }` por si el portal
      // devuelve objetos (PIN + serie), sin perder el código.
      const value =
        entry && typeof entry === 'object'
          ? text((entry as Record<string, unknown>).code)
          : text(entry);
      const trimmed = value?.trim();
      if (trimmed) items.push({ label, code: trimmed });
    }
  }
  return { ok: true, codes: items.map((item) => item.code), items };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Cuántos segundos de diferencia se aceptan en `X-CentralOne-Timestamp`. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== wanted) continue;
    return text(Array.isArray(value) ? value[0] : value);
  }
  return null;
}

function signatureMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifica un aviso de Central One: `X-CentralOne-Signature` =
 * `sha256=` + HMAC-SHA256 en hex de `"{timestamp}.{cuerpo crudo}"`, con el
 * timestamp a menos de 5 minutos (evita que un aviso capturado se reenvíe
 * después). Acepta también `X-CentralOne-Signature-Previous` durante una
 * rotación del secreto. Compara en tiempo constante. Función pura salvo el reloj.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): { ok: true } | { ok: false; reason: 'no_body' | 'no_signature' | 'stale' | 'bad_signature' } {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  if (!body || body.length === 0) return { ok: false, reason: 'no_body' };
  const timestamp = header(headers, 'x-centralone-timestamp');
  const signature = header(headers, 'x-centralone-signature');
  const previous = header(headers, 'x-centralone-signature-previous');
  if (!timestamp || !signature) return { ok: false, reason: 'no_signature' };
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' };
  }
  const expected =
    'sha256=' +
    createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), body]))
      .digest('hex');
  return signatureMatches(expected, signature) || signatureMatches(expected, previous)
    ? { ok: true }
    : { ok: false, reason: 'bad_signature' };
}

/**
 * `GET /webhooks`: el endpoint registrado en el portal (sin el secreto). Un
 * 404 significa que aún no hay ninguno registrado, no un error de la cuenta.
 */
export async function getWebhook(): Promise<{ ok: true; webhook: CoWebhookInfo } | CoFailure> {
  const result = await coRequest<{ webhook?: Record<string, unknown> }>('GET', '/webhooks', {
    timeoutMs: 15_000,
  });
  if (!result.ok) {
    if (result.httpStatus === 404) {
      return { ok: true, webhook: { exists: false, url: null, events: [], status: null, includeCodes: null } };
    }
    return result;
  }
  const hook = (result.data?.webhook ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    webhook: {
      // El portal responde en español (`existe`, `incluir_codigos`); se aceptan
      // ambas formas.
      exists: hook.existe === true || hook.exists === true || Boolean(text(hook.url)),
      url: text(hook.url),
      events: Array.isArray(hook.events) ? hook.events.map(String) : [],
      status: text(hook.status),
      includeCodes:
        typeof hook.incluir_codigos === 'boolean'
          ? hook.incluir_codigos
          : typeof hook.include_codes === 'boolean'
            ? hook.include_codes
            : null,
    },
  };
}

/** `GET /webhooks/deliveries`: últimas entregas de avisos y su resultado. */
export async function listWebhookDeliveries(
  limit = 10
): Promise<{ ok: true; deliveries: CoWebhookDelivery[] } | CoFailure> {
  const result = await coRequest<{ deliveries?: Array<Record<string, unknown>> }>(
    'GET',
    '/webhooks/deliveries',
    { query: { limit: Math.max(1, Math.min(100, Math.floor(limit) || 10)) }, timeoutMs: 15_000 }
  );
  if (!result.ok) return result;
  const deliveries = Array.isArray(result.data?.deliveries) ? result.data.deliveries : [];
  return {
    ok: true,
    deliveries: deliveries.map((item) => ({
      id: String(item.id ?? ''),
      event: String(item.event ?? ''),
      orderReference: text(item.order_reference),
      status: String(item.status ?? ''),
      attempts: Number(item.attempts ?? 0),
      lastHttpStatus:
        item.last_http_status === null || item.last_http_status === undefined
          ? null
          : Number(item.last_http_status),
      lastError: text(item.last_error),
      nextAttemptAt: text(item.next_attempt_at),
      deliveredAt: text(item.delivered_at),
      createdAt: text(item.created_at),
    })),
  };
}

/** `POST /webhooks/test`: encola un `webhook.test` hacia la URL registrada (máx. 5 por hora). */
export async function testWebhook(): Promise<{ ok: true; message: string } | CoFailure> {
  const result = await coRequest<Record<string, unknown>>('POST', '/webhooks/test', { timeoutMs: 15_000 });
  if (!result.ok) return result;
  return {
    ok: true,
    message: text(result.data?.message) ?? 'Central One encoló un aviso de prueba hacia la URL registrada.',
  };
}
