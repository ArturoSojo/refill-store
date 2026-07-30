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
  /** `package_id` del catálogo del proveedor. */
  packageId: number;
  playerId: string;
}

export interface InefableOrderResult {
  success: boolean;
  providerOrderId: string | null;
  providerStatus: string | null;
  /** Nick del jugador que devuelve el proveedor, si lo resuelve. */
  playerName: string | null;
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

/** Estados con los que el proveedor confirma la entrega. */
const SUCCESS_STATUSES = ['exitosa', 'exitoso', 'success', 'completed', 'ok', 'aprobada'];

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
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      package_id: input.packageId,
      player_id: input.playerId,
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

  // El éxito se decide SÓLO por el estado explícito del proveedor.
  //
  // Antes se daba por buena la respuesta si traía `order_id`, y eso es un error
  // caro: una recarga fallida TAMBIÉN devuelve `order_id` (se comprobó con un
  // ID de jugador inválido: `status: "fallida"` con `order_id: 73977`). Con
  // aquella lógica, un fallo del proveedor que respondiera 200 se habría
  // marcado como entregado y el cliente se habría quedado sin sus diamantes.
  const statusLooksGood = status ? SUCCESS_STATUSES.includes(status.toLowerCase()) : false;
  const success = response.ok && body?.ok !== false && statusLooksGood;

  const message =
    toStringOrNull(body?.error) ??
    toStringOrNull(body?.message) ??
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
