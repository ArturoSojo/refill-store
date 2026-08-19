/**
 * Cliente de la API.
 *
 * Adjunta automáticamente el ID token de Firebase y normaliza la respuesta
 * `{ ok, data | error }` que devuelve el backend, convirtiendo los errores en
 * una excepción `ApiError` con código estable.
 */
import { auth } from './firebase';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid_argument'
  | 'failed_precondition'
  | 'already_exists'
  | 'rate_limited'
  | 'provider_error'
  | 'payment_rejected'
  | 'maintenance'
  | 'internal'
  | 'network';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    status = 0,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** El pago fue rechazado pero el cliente puede corregir y reintentar. */
  get isRetryablePayment(): boolean {
    return this.code === 'payment_rejected' && this.details?.canRetry === true;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** `true` fuerza el token aunque haya expirado hace poco. */
  forceTokenRefresh?: boolean;
  signal?: AbortSignal;
  /** Rutas públicas que no requieren token. */
  anonymous?: boolean;
}

async function authHeader(force = false): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  try {
    const token = await user.getIdToken(force);
    return { Authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, forceTokenRefresh = false, signal, anonymous = false } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!anonymous) Object.assign(headers, await authHeader(forceTokenRefresh));

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      'network',
      'No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.'
    );
  }

  const text = await response.text();
  let payload: { ok?: boolean; data?: T; error?: { code: string; message: string; details?: Record<string, unknown> } } | null =
    null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok || payload?.ok === false) {
    const error = payload?.error;

    // Un 401 con sesión activa suele ser un token caducado: se reintenta una
    // sola vez con un token fresco antes de mandar al usuario al login.
    if (response.status === 401 && !forceTokenRefresh && auth.currentUser) {
      return request<T>(path, { ...options, forceTokenRefresh: true });
    }

    throw new ApiError(
      (error?.code as ApiErrorCode) ?? 'internal',
      error?.message ?? `Error ${response.status}`,
      response.status,
      error?.details
    );
  }

  return (payload?.data ?? (null as unknown)) as T;
}

/**
 * Códigos que significan «la petición se cortó por el camino», no «falló».
 *
 * El proxy que sirve la tienda corta a los 26 s, pero la función sigue viva
 * hasta 120 s: una entrega lenta deja al navegador sin respuesta mientras el
 * servidor la termina bien. Tratar eso como un fallo es lo que hacía aparecer
 * «Error 504» en pagos que en realidad salían perfectos.
 *
 * No se incluye el 0 (sin respuesta HTTP): ahí la petición pudo no haber salido
 * del teléfono, y decirle a alguien sin internet que su pago está en curso sería
 * peor que decirle que revise su conexión.
 */
const GATEWAY_TIMEOUTS = [408, 502, 503, 504, 522, 524];

export function isGatewayTimeout(error: unknown): boolean {
  return error instanceof ApiError && GATEWAY_TIMEOUTS.includes(error.status);
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};

/** Descarga un archivo generado por la API (CSV de órdenes). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const headers = await authHeader();
  const response = await fetch(`${BASE_URL}/api${path}`, { headers });
  if (!response.ok) throw new ApiError('internal', 'No se pudo generar el archivo.');

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
