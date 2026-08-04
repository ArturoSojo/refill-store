/**
 * Integración con Pabilo — verificación de pagos móviles (BDV).
 *
 * Endpoint (según especificaciones):
 *   POST {base}/userbankpayment/{PABILO_USER_BANK_ID}/betaserio
 *   Headers: Content-Type: application/json, appKey: PABILO_API_KEY
 *   Body:    { bank_reference: "12345678", amount: 150.50 }   // `amount` opcional
 *
 * Regla del negocio: `data.is_new === true` ⇒ el pago existe y NO se había
 * usado antes. Si `is_new === false`, la referencia ya fue consumida por otra
 * orden y se rechaza.
 *
 * IMPORTANTE: `is_new` es la primera línea de defensa contra referencias
 * reutilizadas, pero no la única. El servicio de órdenes toma además un candado
 * local en `paymentRefs/{referencia}` para que dos peticiones simultáneas con la
 * misma referencia no puedan pasar las dos.
 *
 * ---------------------------------------------------------------------------
 * `amount` FILTRA la búsqueda; no es un dato informativo
 * ---------------------------------------------------------------------------
 * Pabilo sólo devuelve el movimiento si el monto coincide EXACTO con el que se
 * le manda. Un céntimo de diferencia y responde «no encontrado», exactamente
 * igual que si la referencia no existiera.
 *
 * Eso dejaba inservible la tolerancia de la tienda: se rechazaba el pago antes
 * de llegar a comparar nada, así que daba lo mismo tenerla en 0,5 % o en 8 %.
 * Un cliente que transfería 3.708,70 en vez de 3.708,60 recibía «no encontramos
 * ese pago».
 *
 * La solución es la misma que usa el bot de WhatsApp: si la consulta con monto
 * no encuentra nada, se repite SIN monto para que el banco devuelva el
 * movimiento real, y es la tienda —no Pabilo— quien decide si la diferencia
 * entra en la tolerancia.
 *
 * Ojo con la trampa que eso abre: sin el filtro de monto, Pabilo devuelve el
 * movimiento sea cual sea su importe. Por eso, cuando se usa el respaldo, leer
 * el monto real es OBLIGATORIO: si no se puede leer, se rechaza. Si no, pagar
 * 1 Bs valdría por una orden de 3.000.
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
  /**
   * `true` cuando fue el propio Pabilo quien comprobó el monto (la consulta con
   * `amount` encontró el movimiento). Con esto en `true` la tienda no necesita
   * volver a compararlo; con `false` tiene que hacerlo ella, y el monto real es
   * obligatorio.
   */
  amountVerifiedByProvider: boolean;
  /** Fecha del pago informada por el proveedor, si viene. */
  reportedDate: string | null;
  /** Mensaje legible para mostrar al cliente. */
  message: string;
  /** Respuesta cruda (saneada) para auditoría. */
  raw: Record<string, unknown> | null;
  httpStatus: number;
}

interface PabiloMovement {
  is_new?: boolean;
  amount?: number | string;
  date?: string;
  reference?: string;
  /** El movimiento suele venir anidado aquí. */
  user_bank_payment?: Record<string, unknown>;
  userBankPayment?: Record<string, unknown>;
  [key: string]: unknown;
}

interface PabiloRawResponse {
  data?: PabiloMovement;
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
 * `true` si Pabilo dice que la cuenta bancaria configurada no existe.
 *
 * Lo devuelve como 500 con `user_bank not found`, indistinguible a simple vista
 * de una caída suya. Se mira el cuerpo porque el código HTTP miente sobre de
 * quién es la culpa.
 */
function isUnknownBankAccount(response: { status: number; raw: string }): boolean {
  return response.status >= 400 && /user_?bank not found/i.test(response.raw);
}

/**
 * Saca el monto del movimiento.
 *
 * Pabilo lo devuelve anidado (`data.user_bank_payment.amount`) y no siempre con
 * la misma envoltura, así que se buscan las variantes conocidas. Devolver `null`
 * aquí es significativo: quien llama decide si eso es aceptable o motivo de
 * rechazo.
 */
function extractAmount(movement: PabiloMovement | undefined): number | null {
  if (!movement) return null;

  const nested = (movement.user_bank_payment ?? movement.userBankPayment) as
    | Record<string, unknown>
    | undefined;

  return toNumber(movement.amount) ?? toNumber(nested?.amount) ?? null;
}

function extractDate(movement: PabiloMovement | undefined): string | null {
  if (!movement) return null;

  const nested = (movement.user_bank_payment ?? movement.userBankPayment) as
    | Record<string, unknown>
    | undefined;
  const value = movement.date ?? nested?.date;

  return typeof value === 'string' ? value : null;
}

/** Una consulta a Pabilo. `amountBs: null` = sin filtrar por monto. */
async function query(
  bankId: string,
  apiKey: string,
  bankReference: string,
  amountBs: number | null
) {
  const url = `${pabiloBaseUrl().replace(/\/+$/, '')}/userbankpayment/${bankId}/betaserio`;

  const response = await fetchJson<PabiloRawResponse>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', appKey: apiKey },
    body: {
      bank_reference: bankReference,
      // Omitido a propósito cuando es `null`: mandarlo convierte la consulta en
      // una búsqueda por monto exacto.
      ...(amountBs === null ? {} : { amount: Number(amountBs.toFixed(2)) }),
    },
    timeoutMs: 25_000,
    retries: 2,
  });

  log.info('Respuesta de Pabilo', {
    status: response.status,
    reference: `***${bankReference.slice(-4)}`,
    filtradoPorMonto: amountBs !== null,
    body: response.data ?? response.raw.slice(0, 400),
  });

  return response;
}

/** `true` si la respuesta significa «no hay movimiento con esa referencia». */
function isNotFound(response: { status: number; data: PabiloRawResponse | null }): boolean {
  return !response.data?.data || [400, 404, 422].includes(response.status);
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

  // 1) Consulta filtrando por el monto exacto. Es el camino normal: si acierta,
  //    fue Pabilo quien comprobó el importe y no hay nada más que discutir.
  let response = await query(bankId, apiKey, input.bankReference, input.amountBs);
  let amountVerifiedByProvider = true;

  // 2) No encontró nada: puede ser que la referencia no exista… o que el cliente
  //    haya transferido unos céntimos de más. Se vuelve a preguntar SIN monto
  //    para que devuelva el movimiento real y poder compararlo aquí.
  if (response.status !== 0 && !isUnknownBankAccount(response) && isNotFound(response)) {
    const withoutAmount = await query(bankId, apiKey, input.bankReference, null);

    if (!isNotFound(withoutAmount)) {
      response = withoutAmount;
      amountVerifiedByProvider = false;
    }
  }

  // Error de red o proveedor caído: hay que reintentar más tarde, no rechazar
  // el pago (el cliente podría haber pagado de verdad).
  if (response.status === 0) {
    throw providerError(
      'No pudimos comunicarnos con el verificador de pagos. Intenta de nuevo en un minuto.',
      { transport: response.raw }
    );
  }

  // Cuenta bancaria inexistente en Pabilo: parece una caída (responde 500) pero
  // es un error de CONFIGURACIÓN, y no se arregla esperando. Pasó de verdad: al
  // recrearse la cuenta cambió su identificador y `PABILO_USER_BANK_ID` quedó
  // apuntando a una que ya no existía, así que todos los pagos se rechazaban con
  // un «intenta más tarde» que nunca iba a dejar de aparecer.
  if (isUnknownBankAccount(response)) {
    log.error('Pabilo no reconoce la cuenta bancaria configurada', {
      bankId: `***${bankId.slice(-6)}`,
      body: response.raw.slice(0, 200),
    });

    throw providerError(
      'La verificación de pagos está mal configurada (Pabilo no reconoce la cuenta). ' +
        'Avísale al soporte: no se arregla reintentando.',
      { httpStatus: response.status, reason: 'unknown_user_bank' }
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

  // Ni con monto ni sin él: esa referencia no existe en la cuenta.
  if (isNotFound(response)) {
    return {
      isNew: false,
      found: false,
      reportedAmountBs: null,
      amountVerifiedByProvider: false,
      reportedDate: null,
      message:
        providerMessage ??
        'No encontramos ningún pago con esa referencia. Revisa que la hayas copiado completa.',
      raw: (response.data as Record<string, unknown>) ?? null,
      httpStatus: response.status,
    };
  }

  const isNew = data?.is_new === true;

  return {
    isNew,
    found: true,
    reportedAmountBs: extractAmount(data),
    amountVerifiedByProvider,
    reportedDate: extractDate(data),
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

export interface PabiloHealth {
  configured: boolean;
  /** `true` si Pabilo respondió y reconoce la cuenta bancaria. */
  accountOk: boolean;
  message: string | null;
}

/**
 * Comprueba que Pabilo reconoce la cuenta configurada.
 *
 * Consulta una referencia inexistente: es una lectura, no mueve dinero. «No
 * encontré ese pago» significa que la cuenta está bien; «user_bank not found»
 * significa que el `PABILO_USER_BANK_ID` apunta a una cuenta que ya no existe.
 *
 * Tener esto en el panel es la diferencia entre enterarse ahora o enterarse
 * cuando un cliente reclame que pagó y la web le dijo que reintentara.
 */
export async function checkAccount(): Promise<PabiloHealth> {
  const bankId = PABILO_USER_BANK_ID.value();
  const apiKey = PABILO_API_KEY.value();

  if (!bankId || !apiKey) {
    return { configured: false, accountOk: false, message: 'Faltan las credenciales.' };
  }

  const response = await fetchJson(
    `${pabiloBaseUrl().replace(/\/+$/, '')}/userbankpayment/${bankId}/betaserio`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', appKey: apiKey },
      // Referencia imposible: sólo interesa saber si la CUENTA existe.
      body: { bank_reference: '000000000000', amount: 1 },
      timeoutMs: 15_000,
      retries: 1,
    }
  );

  if (isUnknownBankAccount(response)) {
    return {
      configured: true,
      accountOk: false,
      message:
        'Pabilo no reconoce la cuenta bancaria. Revisa PABILO_USER_BANK_ID: los pagos no se pueden verificar.',
    };
  }

  if (response.status === 0 || response.status >= 500) {
    return { configured: true, accountOk: false, message: 'Pabilo no responde.' };
  }

  if (response.status === 401 || response.status === 403) {
    return { configured: true, accountOk: false, message: 'La appKey de Pabilo fue rechazada.' };
  }

  return { configured: true, accountOk: true, message: null };
}
