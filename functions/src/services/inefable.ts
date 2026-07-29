/**
 * Integración con Inefable Revendedores — despacho de recargas automáticas.
 *
 * Endpoint (según especificaciones):
 *   POST {base}/api/v1/order
 *   Headers: Authorization: Bearer INEFABLE_API_KEY, Content-Type: application/json
 *   Body:    { product_id: 3, player_id: "3363122817" }
 *
 * Los combos se resuelven como varias llamadas encadenadas: para 830+83 💎 se
 * envía primero `product_id: 3`, se confirma que la respuesta sea exitosa y
 * recién entonces se envía `product_id: 2`. Si la segunda falla, la primera ya
 * llegó al jugador: por eso cada llamada se registra por separado en la orden y
 * el reintento del panel sólo repite las llamadas que quedaron en error.
 */
import { INEFABLE_API_KEY, inefableBaseUrl } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { log } from '../lib/logger';
import { providerError } from '../lib/errors';

export interface InefableOrderInput {
  productId: number;
  playerId: string;
}

export interface InefableOrderResult {
  success: boolean;
  providerOrderId: string | null;
  providerStatus: string | null;
  message: string;
  raw: Record<string, unknown> | null;
  httpStatus: number;
  /** `true` si tiene sentido reintentar (red caída, 5xx, saldo temporal). */
  retryable: boolean;
}

interface InefableRawResponse {
  status?: string;
  success?: boolean;
  message?: string;
  error?: string;
  order_id?: string | number;
  data?: {
    order_id?: string | number;
    id?: string | number;
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** El proveedor confirma con `status: "exitosa"` según las especificaciones. */
const SUCCESS_STATUSES = ['exitosa', 'exitoso', 'success', 'completed', 'ok', 'aprobada'];

function readOrderId(body: InefableRawResponse | null): string | null {
  if (!body) return null;
  const candidate = body.order_id ?? body.data?.order_id ?? body.data?.id;
  if (candidate === undefined || candidate === null) return null;
  return String(candidate);
}

function readStatus(body: InefableRawResponse | null): string | null {
  if (!body) return null;
  const status = body.status ?? body.data?.status;
  return typeof status === 'string' ? status : null;
}

function readMessage(body: InefableRawResponse | null): string | null {
  if (!body) return null;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.error === 'string') return body.error;
  return null;
}

/** Envía una recarga individual al proveedor. */
export async function createOrder(input: InefableOrderInput): Promise<InefableOrderResult> {
  const apiKey = INEFABLE_API_KEY.value();
  if (!apiKey) {
    throw providerError('El despacho automático no está configurado.');
  }

  const url = `${inefableBaseUrl().replace(/\/+$/, '')}/api/v1/order`;

  const response = await fetchJson<InefableRawResponse>(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      product_id: input.productId,
      player_id: input.playerId,
    },
    timeoutMs: 30_000,
    // Sin reintentos automáticos de red: una recarga duplicada cuesta dinero
    // real. El reintento es una decisión explícita del panel de administración.
    retries: 0,
  });

  const body = response.data ?? null;
  const status = readStatus(body);
  const providerOrderId = readOrderId(body);
  const message = readMessage(body);

  const statusLooksGood = status ? SUCCESS_STATUSES.includes(status.toLowerCase()) : false;
  const success =
    response.ok && (statusLooksGood || body?.success === true || Boolean(providerOrderId));

  log.info('Respuesta de Inefable', {
    status: response.status,
    productId: input.productId,
    playerId: `***${input.playerId.slice(-4)}`,
    success,
    body: body ?? response.raw.slice(0, 400),
  });

  return {
    success,
    providerOrderId,
    providerStatus: status,
    message:
      message ??
      (success
        ? 'Recarga enviada al proveedor.'
        : 'El proveedor no pudo procesar la recarga.'),
    raw: (body as Record<string, unknown>) ?? null,
    httpStatus: response.status,
    // Un 4xx suele ser "ID inválido" o "producto inexistente": reintentar no
    // arregla nada. Red caída o 5xx sí valen la pena.
    retryable: response.status === 0 || response.status >= 500 || response.status === 429,
  };
}

export function isInefableConfigured(): boolean {
  return Boolean(INEFABLE_API_KEY.value());
}
