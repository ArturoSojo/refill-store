/**
 * Logging estructurado sobre el logger de Cloud Functions.
 *
 * `redact` existe porque en los logs entran respuestas de proveedores y datos de
 * pago: nunca deben quedar registrados API keys ni referencias completas.
 */
import { logger as fnLogger } from 'firebase-functions/v2';

const SENSITIVE_KEYS = [
  'appkey',
  'authorization',
  'apikey',
  'api_key',
  'token',
  'password',
  'secret',
  'bearer',
];

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[profundidad máxima]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.includes(key.toLowerCase())
        ? '[oculto]'
        : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

type Meta = Record<string, unknown>;

export const log = {
  debug: (message: string, meta?: Meta) => fnLogger.debug(message, redact(meta)),
  info: (message: string, meta?: Meta) => fnLogger.info(message, redact(meta)),
  warn: (message: string, meta?: Meta) => fnLogger.warn(message, redact(meta)),
  error: (message: string, meta?: Meta) => fnLogger.error(message, redact(meta)),
};
