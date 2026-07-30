/**
 * Integración con Inefable Revendedores — despacho de recargas automáticas.
 *
 * Endpoint real (verificado contra la API en producción):
 *   POST {base}/api/v1/recharge
 *   Headers: Authorization: Bearer INEFABLE_API_KEY, Content-Type: application/json
 *   Body:    { package_id: 1, player_id: "3363122817" }
 *
 * OJO: el documento técnico indicaba `POST /api/v1/order` con `product_id`.
 * Ninguna de las dos cosas es correcta: esa ruta devuelve un 404 HTML de Flask
 * y el campo se llama `package_id`, igual que en `/api/v1/products`. Se dejó
 * `inefableRechargePath` configurable por si el proveedor vuelve a moverlo.
 *
 * Respuesta (misma forma en éxito y en fallo):
 *   {
 *     ok: true|false,
 *     status: "exitosa"|"fallida",
 *     order_id: 73977,
 *     player_name: "Nick del jugador",
 *     reference_no: "...",
 *     remaining_balance: 23.39,
 *     error: "..."          // sólo cuando falla
 *   }
 *
 * Los combos se resuelven como varias llamadas encadenadas: para 830+83 💎 se
 * envía primero `package_id: 3`, se confirma que la respuesta sea exitosa y
 * recién entonces se envía `package_id: 2`. Si la segunda falla, la primera ya
 * llegó al jugador: por eso cada llamada se registra por separado en la orden y
 * el reintento del panel sólo repite las llamadas que quedaron en error.
 */
import { INEFABLE_API_KEY, inefableBaseUrl, inefableRechargePath } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { log } from '../lib/logger';
import { providerError } from '../lib/errors';

export interface InefableOrderInput {
  /**
   * `game_id` del catálogo (Free Fire ID = -1, Blood Strike = 15).
   *
   * Va en el campo `product_id` y NO es opcional en la práctica: los
   * `package_id` se repiten entre juegos, y sin él el proveedor empareja el
   * paquete con otro juego. Omitirlo era la causa del error «Please insert Zone
   * ID into input2»: el paquete 1 caía en un juego que pide Zone ID.
   */
  gameId: number;
  /** `package_id` del catálogo del proveedor. */
  packageId: number;
  playerId: string;
  /**
   * Identificador propio y ESTABLE de esta llamada.
   *
   * El proveedor lo usa para deduplicar: si la petición se corta por timeout y
   * se reintenta con el mismo valor, devuelve el resultado de la original en
   * lugar de cobrar otra recarga. Si la original falló, sí ejecuta una nueva.
   */
  externalOrderId: string;
}

export interface InefableOrderResult {
  success: boolean;
  providerOrderId: string | null;
  providerStatus: string | null;
  /** Nick del jugador que devuelve el proveedor, si lo resuelve. */
  playerName: string | null;
  /** Referencia del proveedor: es lo que se cita al reclamar una entrega. */
  providerReference: string | null;
  /** Saldo que le queda a la cuenta de revendedor tras la operación. */
  remainingBalance: number | null;
  message: string;
  /** Cuerpo de la respuesta, ya saneado, para poder diagnosticar. */
  raw: Record<string, unknown> | null;
  httpStatus: number;
  /** `true` si tiene sentido reintentar (red caída, 5xx, límite de tasa). */
  retryable: boolean;
}

interface InefableRawResponse {
  ok?: boolean;
  status?: string;
  error?: string;
  message?: string;
  order_id?: string | number;
  player_name?: string;
  reference_no?: string;
  remaining_balance?: number;
  [key: string]: unknown;
}

/**
 * Vocabulario de estados del proveedor.
 *
 * Una recarga entregada de verdad responde `status: "completada"` —no
 * "exitosa", como sugería el documento—. Confiar sólo en una lista de palabras
 * es frágil: si el proveedor usa un término nuevo, una recarga YA ENTREGADA se
 * marcaría como fallida y el reintento del panel la cobraría por segunda vez.
 *
 * Por eso el criterio principal es el booleano `ok` que devuelve la API, y las
 * listas de abajo sólo sirven para descartar estados intermedios o de fallo.
 */
const SUCCESS_STATUSES = [
  'completada',
  'completado',
  'exitosa',
  'exitoso',
  'success',
  'completed',
  'ok',
  'aprobada',
  'entregada',
];

const FAILURE_STATUSES = [
  'fallida',
  'fallido',
  'failed',
  'error',
  'cancelada',
  'cancelado',
  'rechazada',
  'rejected',
];

/** Estados en los que el proveedor aún no confirmó la entrega. */
const PENDING_STATUSES = [
  'pendiente',
  'pending',
  'procesando',
  'processing',
  'en proceso',
  'en_proceso',
  'queued',
];

function toStringOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

/** Envía una recarga individual al proveedor. */
export async function createOrder(input: InefableOrderInput): Promise<InefableOrderResult> {
  const apiKey = INEFABLE_API_KEY.value();
  if (!apiKey) {
    throw providerError('El despacho automático no está configurado.');
  }

  const url = `${inefableBaseUrl().replace(/\/+$/, '')}${inefableRechargePath()}`;

  const response = await fetchJson<InefableRawResponse>(url, {
    method: 'POST',
    headers: {
      // El proveedor documenta `X-API-Key` como cabecera propia y acepta además
      // el `Bearer` estándar. Se mandan las dos.
      'X-API-Key': apiKey,
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      product_id: input.gameId,
      package_id: input.packageId,
      player_id: input.playerId,
      external_order_id: input.externalOrderId,
    },
    // El proveedor tarda 2-3 s en responder; se deja margen holgado.
    timeoutMs: 45_000,
    // Sin reintentos automáticos: una recarga duplicada cuesta dinero real. El
    // reintento es una decisión explícita del panel de administración.
    retries: 0,
  });

  const body = response.data ?? null;
  const status = toStringOrNull(body?.status);
  const providerOrderId = toStringOrNull(body?.order_id);

  // Nunca se infiere el éxito de la presencia de `order_id`: una recarga
  // fallida TAMBIÉN lo devuelve (comprobado con un ID inválido: `fallida` con
  // `order_id: 73977`). Se usa el booleano `ok`, descartando además los estados
  // de fallo y los intermedios.
  const normalized = status?.toLowerCase() ?? '';
  const isFailure = FAILURE_STATUSES.includes(normalized);
  const isPending = PENDING_STATUSES.includes(normalized);
  const success = response.ok && body?.ok === true && !isFailure && !isPending;

  // Un estado desconocido con `ok: true` se acepta como entregado (es lo seguro
  // frente a un doble cobro), pero se deja constancia para poder añadirlo a la
  // lista si el proveedor cambia el vocabulario.
  if (success && normalized && !SUCCESS_STATUSES.includes(normalized)) {
    log.warn('Estado de entrega no reconocido en Inefable', { status, packageId: input.packageId });
  }

  // Códigos documentados por el proveedor. Traducirlos evita que el equipo
  // tenga que adivinar: «saldo insuficiente» y «paquete inactivo» se arreglan
  // de formas muy distintas.
  const HTTP_REASONS: Record<number, string> = {
    401: 'La API key del proveedor es inválida o fue revocada.',
    402: 'Saldo insuficiente en la cuenta del proveedor. Recárgala para seguir despachando.',
    404: 'El proveedor no reconoce ese paquete (package_id inexistente o inactivo).',
    429: 'El proveedor está limitando las peticiones. Reintenta en unos segundos.',
  };

  const message =
    toStringOrNull(body?.error) ??
    toStringOrNull(body?.message) ??
    HTTP_REASONS[response.status] ??
    (success
      ? 'Recarga enviada al proveedor.'
      : // Sin cuerpo JSON no hay nada que citar: se informa el código HTTP, que
        // es lo único que permite distinguir una ruta equivocada (404) de una
        // caída del proveedor (5xx).
        `El proveedor respondió HTTP ${response.status} sin un mensaje reconocible.`);

  log.info('Respuesta de Inefable', {
    httpStatus: response.status,
    packageId: input.packageId,
    playerId: `***${input.playerId.slice(-4)}`,
    success,
    providerStatus: status,
    body: body ?? response.raw.slice(0, 400),
  });

  return {
    success,
    providerOrderId,
    providerStatus: status,
    playerName: toStringOrNull(body?.player_name),
    providerReference: toStringOrNull(body?.reference_no),
    remainingBalance:
      typeof body?.remaining_balance === 'number' ? body.remaining_balance : null,
    message,
    raw: (body as Record<string, unknown>) ?? { nonJsonBody: response.raw.slice(0, 500) },
    httpStatus: response.status,
    // Un 4xx suele ser «ID inválido» o «paquete inexistente»: reintentar no
    // arregla nada. Red caída, 5xx o 429 sí valen la pena.
    retryable: response.status === 0 || response.status >= 500 || response.status === 429,
  };
}

export function isInefableConfigured(): boolean {
  return Boolean(INEFABLE_API_KEY.value());
}

export interface InefableOrderStatus {
  /** `false` si el proveedor nunca llegó a crear la recarga. */
  found: boolean;
  status: string | null;
  providerOrderId: string | null;
  providerReference: string | null;
  error: string | null;
}

/**
 * Consulta una recarga por NUESTRO identificador.
 *
 * Es la forma segura de resolver un timeout: el proveedor advierte que
 * reintentar a ciegas puede cobrar dos veces, y que lo correcto es preguntar
 * primero si la orden existe y en qué estado quedó.
 */
export async function getOrderStatus(externalOrderId: string): Promise<InefableOrderStatus> {
  const apiKey = INEFABLE_API_KEY.value();
  if (!apiKey) return { found: false, status: null, providerOrderId: null, providerReference: null, error: 'Sin API key.' };

  const url =
    `${inefableBaseUrl().replace(/\/+$/, '')}/api/v1/order-status` +
    `?external_order_id=${encodeURIComponent(externalOrderId)}`;

  const response = await fetchJson<{
    found?: boolean;
    order?: { status?: string; id?: string | number; reference_no?: string; error?: string };
    status?: string;
    order_id?: string | number;
    reference_no?: string;
    error?: string;
  }>(url, {
    method: 'GET',
    headers: { 'X-API-Key': apiKey, Authorization: `Bearer ${apiKey}` },
    timeoutMs: 20_000,
    retries: 1,
  });

  const order = response.data?.order ?? response.data ?? null;

  return {
    found: response.ok && response.data?.found !== false && Boolean(order),
    status: toStringOrNull(order?.status),
    providerOrderId: toStringOrNull(
      (order as { id?: unknown; order_id?: unknown })?.id ??
        (order as { order_id?: unknown })?.order_id
    ),
    providerReference: toStringOrNull((order as { reference_no?: unknown })?.reference_no),
    error: toStringOrNull((order as { error?: unknown })?.error),
  };
}

/** Saldo de la cuenta de revendedor, para vigilarlo desde el panel. */
export async function getBalance(): Promise<{
  ok: boolean;
  balanceUsd: number | null;
  accountName: string | null;
  message: string | null;
}> {
  const apiKey = INEFABLE_API_KEY.value();
  if (!apiKey) return { ok: false, balanceUsd: null, accountName: null, message: 'Sin API key.' };

  const response = await fetchJson<{
    ok?: boolean;
    account_name?: string;
    user?: { balance?: number };
  }>(`${inefableBaseUrl().replace(/\/+$/, '')}/api/v1/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 15_000,
    retries: 1,
  });

  return {
    ok: response.ok,
    balanceUsd: typeof response.data?.user?.balance === 'number' ? response.data.user.balance : null,
    accountName: response.data?.account_name ?? null,
    message: response.ok ? null : `HTTP ${response.status}`,
  };
}
