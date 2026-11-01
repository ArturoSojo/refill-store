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
 */
import { centralOneApiKey, centralOneBaseUrl } from '../config/env';
import { now, playerIdCache } from '../config/firebase';
import { log } from '../lib/logger';

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
  status: string | null;
  totalSaleAmount: number | null;
  currency: string | null;
  errorMessage: string | null;
  failureCode: string | null;
  failureAction: string | null;
  raw: Record<string, unknown>;
}

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const url = `${centralOneBaseUrl()}/orders`;
    const body = {
      items: [
        {
          catalog_item_id: input.catalogItemId,
          quantity: input.quantity || 1,
          target_payload: input.targetPayload,
        },
      ],
      note: input.note?.slice(0, 500) || undefined,
    };

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
      const errObj = data.error || data;
      const code = errObj.code || `http_${httpStatus}`;
      const message = errObj.message || 'Error en POST /orders';

      let formattedError = message;
      if (httpStatus === 409 && code === 'insufficient_balance') {
        formattedError = 'Saldo insuficiente en la cuenta mayorista de Central One.';
      } else if (httpStatus === 409 && code === 'insufficient_stock') {
        formattedError = 'No hay stock disponible en el proveedor Central One.';
      } else if (httpStatus === 429) {
        formattedError = 'Límite de solicitudes alcanzado en Central One (rate limited).';
      }

      return {
        success: false,
        httpStatus,
        orderId: null,
        referenceCode: null,
        status: 'failed',
        totalSaleAmount: null,
        currency: null,
        errorMessage: formattedError,
        failureCode: code,
        failureAction: errObj.action || null,
        raw: data,
      };
    }

    const orderData = data.order || {};
    const orderId = orderData.id || null;
    const referenceCode = orderData.reference_code || null;
    const status = (orderData.status || 'confirmed').toLowerCase();
    const totalSaleAmount = orderData.total_sale_amount
      ? parseFloat(orderData.total_sale_amount)
      : null;

    return {
      success: true,
      httpStatus,
      orderId,
      referenceCode,
      status,
      totalSaleAmount,
      currency: orderData.currency || 'USD',
      errorMessage: null,
      failureCode: null,
      failureAction: null,
      raw: data,
    };
  } catch (err) {
    clearTimeout(timer);
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

export interface CentralOneOrderDetailResult {
  found: boolean;
  httpStatus: number;
  orderId: string;
  referenceCode: string | null;
  orderStatus: string | null;
  lineStatus: string | null;
  totalSalePrice: number | null;
  isSuccess: boolean;
  isPending: boolean;
  isFailed: boolean;
  failureCode: string | null;
  failureAction: string | null;
  failureMessage: string | null;
  raw: Record<string, unknown>;
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
        failureCode: 'not_found',
        failureAction: null,
        failureMessage: 'Orden no encontrada en Central One.',
        raw: data,
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
        failureCode: data.error?.code || `http_${httpStatus}`,
        failureAction: null,
        failureMessage: data.error?.message || 'Error en GET /orders/{id}',
        raw: data,
      };
    }

    const order = data.order || {};
    const orderStatus = (order.status || '').toLowerCase();
    const referenceCode = order.reference_code || null;
    const firstItem = Array.isArray(order.items) && order.items.length > 0 ? order.items[0] : null;
    const lineStatus = (firstItem?.status || orderStatus).toLowerCase();

    const failure = firstItem?.failure || order.failure || null;
    const failureCode = failure?.code || null;
    const failureAction = failure?.action || null;
    const failureMessage = failure ? formatCentralOneFailure(failure) : null;

    const totalSalePrice = firstItem?.total_sale_price
      ? parseFloat(firstItem.total_sale_price)
      : order.total_sale_amount
        ? parseFloat(order.total_sale_amount)
        : null;

    const isSuccess = lineStatus === 'completed' || orderStatus === 'completed';
    const isFailed =
      lineStatus === 'failed' ||
      lineStatus === 'cancelled' ||
      lineStatus === 'refunded' ||
      orderStatus === 'failed' ||
      orderStatus === 'cancelled';
    const isPending =
      !isSuccess &&
      !isFailed &&
      ['created', 'confirmed', 'processing', 'reserved', 'pending'].includes(
        lineStatus || orderStatus
      );

    return {
      found: true,
      httpStatus: 200,
      orderId,
      referenceCode,
      orderStatus,
      lineStatus,
      totalSalePrice,
      isSuccess,
      isPending,
      isFailed,
      failureCode,
      failureAction,
      failureMessage,
      raw: data,
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
      failureCode: 'network_error',
      failureAction: null,
      failureMessage: (err as Error)?.message || String(err),
      raw: { error: String(err) },
    };
  }
}
