/**
 * Integración con Pabilo — verificación de pagos móviles (BDV).
 *
 * Endpoint (según especificaciones):
 *   POST {base}/userbankpayment/{PABILO_USER_BANK_ID}/betaserio
 *   Headers: Content-Type: application/json, appKey: PABILO_API_KEY
 *   Body:    { bank_reference: "12345678", amount: 150.50 }
 *
 * Regla del negocio: `data.is_new === true` ⇒ el pago existe y NO se había
 * usado antes. Si `is_new === false`, la referencia ya fue consumida por otra
 * orden y se rechaza.
 *
 * IMPORTANTE: `is_new` es la primera línea de defensa contra referencias
 * reutilizadas, pero no la única. El servicio de órdenes toma además un candado
 * local en `paymentRefs/{referencia}` para que dos peticiones simultáneas con la
 * misma referencia no puedan pasar las dos.
 */
import { PABILO_API_KEY, PABILO_USER_BANK_ID, pabiloBaseUrl } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { log } from '../lib/logger';
import { providerError } from '../lib/errors';

export interface PabiloVerifyInput {
  /** Referencia del pago móvil, sólo dígitos. */
  bankReference: string;
  /** Monto exacto esperado en bolívares. */
  amountBs: number;
}

export interface PabiloVerifyResult {
  /** `true` si el pago existe y no había sido usado. */
  isNew: boolean;
  /** `true` si el proveedor reconoce la referencia (aunque ya esté usada). */
  found: boolean;
  /** Monto que el banco reporta para esa referencia, si viene. */
  reportedAmountBs: number | null;
  /** Fecha del pago informada por el proveedor, si viene. */
  reportedDate: string | null;
  /** Mensaje legible para mostrar al cliente. */
  message: string;
  /** Respuesta cruda (saneada) para auditoría. */
  raw: Record<string, unknown> | null;
  httpStatus: number;
}

interface PabiloRawResponse {
  data?: {
    is_new?: boolean;
    amount?: number | string;
    date?: string;
    reference?: string;
    [key: string]: unknown;
  };
  message?: string;
  error?: string;
  [key: string]: unknown;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Consulta a Pabilo si la referencia corresponde a un pago válido y sin usar.
 *
 * No lanza excepción cuando el pago simplemente no es válido: eso es una
 * respuesta de negocio (`isNew: false`). Sólo lanza si el proveedor está caído
 * o responde algo que no se puede interpretar.
 */
export async function verifyPayment(input: PabiloVerifyInput): Promise<PabiloVerifyResult> {
  const bankId = PABILO_USER_BANK_ID.value();
  const apiKey = PABILO_API_KEY.value();

  if (!bankId || !apiKey) {
    throw providerError(
      'La verificación de pagos no está configurada. Contacta al soporte.'
    );
  }

  const url = `${pabiloBaseUrl().replace(/\/+$/, '')}/userbankpayment/${bankId}/betaserio`;

  const response = await fetchJson<PabiloRawResponse>(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      appKey: apiKey,
    },
    body: {
      bank_reference: input.bankReference,
      amount: Number(input.amountBs.toFixed(2)),
    },
    timeoutMs: 25_000,
    retries: 2,
  });

  log.info('Respuesta de Pabilo', {
    status: response.status,
    reference: `***${input.bankReference.slice(-4)}`,
    amountBs: input.amountBs,
    body: response.data ?? response.raw.slice(0, 400),
  });

  // Error de red o proveedor caído: hay que reintentar más tarde, no rechazar
  // el pago (el cliente podría haber pagado de verdad).
  if (response.status === 0) {
    throw providerError(
      'No pudimos comunicarnos con el verificador de pagos. Intenta de nuevo en un minuto.',
      { transport: response.raw }
    );
  }

  if (response.status >= 500) {
    throw providerError(
      'El verificador de pagos no está disponible en este momento. Intenta en unos minutos.',
      { httpStatus: response.status }
    );
  }

  const data = response.data?.data;
  const providerMessage =
    (typeof response.data?.message === 'string' && response.data.message) ||
    (typeof response.data?.error === 'string' && response.data.error) ||
    null;

  // 404 / 422: el proveedor no encontró la referencia.
  if (!data || response.status === 404 || response.status === 422) {
    return {
      isNew: false,
      found: false,
      reportedAmountBs: null,
      reportedDate: null,
      message:
        providerMessage ??
        'No encontramos ese pago. Verifica el número de referencia y el monto exacto.',
      raw: (response.data as Record<string, unknown>) ?? null,
      httpStatus: response.status,
    };
  }

  const isNew = data.is_new === true;

  return {
    isNew,
    found: true,
    reportedAmountBs: toNumber(data.amount),
    reportedDate: typeof data.date === 'string' ? data.date : null,
    message: isNew
      ? 'Pago verificado correctamente.'
      : 'Esa referencia ya fue utilizada en otra compra.',
    raw: (response.data as Record<string, unknown>) ?? null,
    httpStatus: response.status,
  };
}

/** Comprobación de configuración usada por el panel de administración. */
export function isPabiloConfigured(): boolean {
  return Boolean(PABILO_API_KEY.value() && PABILO_USER_BANK_ID.value());
}
