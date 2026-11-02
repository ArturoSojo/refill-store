/**
 * Logging estructurado sobre el logger de Cloud Functions.
 *
 * `redact` existe porque en los logs entran respuestas de proveedores y datos de
 * pago: nunca deben quedar registrados API keys ni referencias completas.
 * `stripCodes` cubre lo otro que nunca debe quedar en un registro: los códigos
 * de gift card que entrega Central One.
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

/**
 * Claves bajo las que los proveedores devuelven códigos entregados. Central
 * One los manda en `items[].codes` (`GET /orders/{id}/codes` y el aviso
 * `order.delivered` con «incluir códigos»); el resto cubre variantes de PIN y
 * series de tarjetas.
 */
const CODE_CONTAINER_KEYS = new Set([
  'cards',
  'keys',
  'codes',
  'pin',
  'pins',
  'pin_code',
  'gift_code',
  'redemption_code',
  'activation_code',
  'serial',
  'serials',
  'voucher',
]);
/** Dentro de un elemento de lista (`items[]`, `delivered[]`) el código va suelto. */
const CODE_ITEM_KEYS = new Set([...CODE_CONTAINER_KEYS, 'code', 'key']);

/**
 * Devuelve una copia de la respuesta del proveedor SIN códigos entregados.
 *
 * Se aplica a toda respuesta de Central One antes de loguearla o guardarla en
 * `call.providerResponse`: un código de gift card es dinero, y la respuesta
 * cruda la ve cualquiera del staff y queda en los registros de Cloud Logging.
 * Los códigos sólo viajan por `deliveredCodes`. Quita `cards`/`keys`/`codes`/…
 * en cualquier nivel y, dentro de los elementos de una lista, también `code` y
 * `key`. El `code` de nivel superior se conserva: es el código de error
 * (`insufficient_balance`), no un código entregado.
 */
export function stripCodes<T = unknown>(raw: T, depth = 0, inList = false): T {
  if (depth > 8) return raw;
  if (raw === null || raw === undefined) return raw;
  if (Array.isArray(raw)) {
    return raw.map((item) => stripCodes(item, depth + 1, true)) as unknown as T;
  }
  if (typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (CODE_CONTAINER_KEYS.has(lower) || (inList && CODE_ITEM_KEYS.has(lower))) {
        out[key] = '[código omitido]';
        continue;
      }
      out[key] = stripCodes(val, depth + 1, false);
    }
    return out as unknown as T;
  }
  return raw;
}

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
