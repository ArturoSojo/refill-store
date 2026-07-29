/**
 * Cliente HTTP con timeout y reintentos.
 *
 * Node 20 ya trae `fetch` global, así que no hace falta una dependencia extra.
 * Sólo se reintentan errores de red y 5xx: un 4xx del proveedor es una respuesta
 * legítima que debemos propagar tal cual (por ejemplo, "referencia ya usada").
 */

export interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface FetchJsonResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Cuerpo crudo, útil cuando el proveedor devuelve HTML en vez de JSON. */
  raw: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<FetchJsonResult<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 20_000,
    retries = 2,
    retryDelayMs = 700,
  } = options;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const raw = await response.text();
      let data: T | null = null;
      if (raw) {
        try {
          data = JSON.parse(raw) as T;
        } catch {
          data = null;
        }
      }

      // 5xx: puede ser transitorio, reintentamos mientras queden intentos.
      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      return { ok: response.ok, status: response.status, data, raw };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'Error de red';
  return { ok: false, status: 0, data: null, raw: message };
}
