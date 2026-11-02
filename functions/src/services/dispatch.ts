/**
 * Despacho de recargas ya pagadas.
 *
 * Reglas del documento técnico que este módulo implementa:
 *
 *  - Los combos son varias llamadas EN SECUENCIA. Para 830+83 💎 se envía
 *    `product_id: 3`, se confirma que la respuesta sea exitosa, y sólo entonces
 *    se envía `product_id: 2`. Nunca en paralelo.
 *  - Si una llamada falla, se detiene la secuencia. Las llamadas anteriores ya
 *    llegaron al jugador, así que el reintento del panel repite ÚNICAMENTE las
 *    que quedaron pendientes o en error. Esto es lo que evita recargar dos veces
 *    y regalar dinero.
 *  - Los productos manuales (Categoría B) no tocan el API del proveedor: se
 *    genera el enlace de WhatsApp y la orden queda esperando gestión humana.
 */
import { db, orders, games, products, now, minutesFromNow, providerOrders } from '../config/firebase';
import { createHash } from 'node:crypto';
import { log, stripCodes } from '../lib/logger';
import { notFound } from '../lib/errors';
import { round } from '../lib/money';
import * as inefable from './inefable';
import * as fazercards from './fazercards';
import * as centralOne from './centralOne';
import * as audit from './audit';
import * as notifications from './notifications';
import * as adminAlerts from './adminAlerts';
import * as stats from './stats';
import * as usersService from './users';
import * as creatorsService from './creators';
import { addEvent } from './orderEvents';
import { getConfig } from './settings';
import { sendOrderEmail } from './orderEmails';
import { resolvePlayerFields } from './catalog';
import { describeOrder } from '../lib/orderItem';
import { buildManualOrderUrl, buildWhatsappUrl } from './whatsapp';
import type {
  DispatchCallResult,
  Game,
  ManualFlow,
  Order,
  OrderStatus,
  TimestampLike,
} from '../types/models';

const REVIEW_CUSTOMER_MESSAGE =
  'Estamos procesando tu orden manualmente. Si no se completa en 1 hora, se te devuelve el saldo automáticamente.';

/**
 * Limpia cualquier mensaje de error del proveedor para que nunca se guarde
 * JSON crudo ni HTML en `providerError` o `dispatch.lastError`.
 */
export function sanitizeProviderError(raw: unknown, httpStatus?: number | null): string {
  const fallback = httpStatus
    ? `Error del proveedor (HTTP ${httpStatus}).`
    : 'El proveedor no pudo completar la recarga.';

  if (raw === null || raw === undefined) return fallback;

  let text = typeof raw === 'string' ? raw.trim() : '';

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const candidate =
      (typeof obj.error === 'string' && obj.error) ||
      (typeof obj.message === 'string' && obj.message) ||
      (typeof obj.detail === 'string' && obj.detail) ||
      (Array.isArray(obj.errors) && typeof obj.errors[0] === 'string' ? obj.errors[0] : '');
    text = candidate ? candidate.trim() : '';
  } else if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidate =
          (typeof parsed.error === 'string' && parsed.error) ||
          (typeof parsed.message === 'string' && parsed.message) ||
          (typeof parsed.detail === 'string' && parsed.detail) ||
          (Array.isArray(parsed.errors) && typeof parsed.errors[0] === 'string'
            ? parsed.errors[0]
            : '');
        text = candidate ? candidate.trim() : '';
      } else {
        text = '';
      }
    } catch {
      text = '';
    }
  }

  if (
    !text ||
    text.startsWith('{') ||
    text.startsWith('[') ||
    text.startsWith('<!doctype') ||
    text.startsWith('<html') ||
    /[{}\[\]]/.test(text)
  ) {
    return fallback;
  }

  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine;
}

export interface DispatchOutcome {
  status: OrderStatus;
  calls: DispatchCallResult[];
  allSucceeded: boolean;
  message: string;
}

/** Inefable mantiene sus identificadores numéricos; FazerCards no. */
function requireInefableId(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`El ${field} de Inefable debe ser numérico; revisa el proveedor configurado en el juego.`);
  }
  return parsed;
}

/** Un ID externo puede contener `/`; se hashea antes de usarlo como doc ID. */
function providerOrderIndexId(provider: string, providerOrderId: string): string {
  return createHash('sha256').update(`${provider}:${providerOrderId}`).digest('hex');
}

/**
 * Indexa el pedido del proveedor para que su webhook resuelva en O(1).
 *
 * Nunca lanza: la recarga ya fue aceptada y una caída del índice no puede
 * convertirla en fallo ni habilitar que se vuelva a enviar.
 */
async function indexProviderOrder(
  provider: 'fazercards' | 'centralone',
  providerOrderId: string,
  orderId: string,
  callIndex: number
): Promise<void> {
  await providerOrders()
    .doc(providerOrderIndexId(provider, providerOrderId))
    .set({ provider, providerOrderId, orderId, callIndex, createdAt: now() })
    .catch((error) => {
      log.error('No se pudo indexar la orden del proveedor para webhook', {
        orderId,
        provider,
        providerOrderId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

// ---------------------------------------------------------------------------
// Escritura de `dispatch.calls`: compare-and-set por llamada y códigos aparte
// ---------------------------------------------------------------------------

/**
 * Lo que cambia cuando alguien despacha, consulta o reintenta una llamada. Si
 * la huella guardada ya no es la que se leyó, otra petición la tocó.
 */
function callFingerprint(call: DispatchCallResult | undefined): string {
  if (!call) return '';
  const state = call as CentralOneCallState;
  return JSON.stringify([
    call.status,
    call.attempts ?? 0,
    call.providerOrderId ?? null,
    state.idempotencyKey ?? null,
    state.keyClosed === true,
    state.keyAttempts ?? 0,
  ]);
}

/**
 * Mezcla, llamada por llamada, lo que se va a escribir con lo guardado. Pura.
 *
 * El cron, el webhook y el reintento del panel leen la orden, hablan un rato
 * con el proveedor (un POST puede tardar 25 s) y luego escriben el arreglo
 * entero de llamadas. Si en medio otro escribió, esa copia vieja deshacía su
 * trabajo: p. ej. el cron devolvía a `error` una llamada que el panel acababa
 * de comprar con llave nueva, ese pedido quedaba huérfano y la orden podía
 * terminar reembolsada con la recarga entregada. Aquí cada llamada se escribe
 * sólo si lo guardado sigue como se leyó (`read`); si no, gana lo guardado y
 * se conserva, al menos, el id de pedido que traía la versión descartada.
 */
export function mergeDispatchCalls(
  read: DispatchCallResult[],
  stored: DispatchCallResult[],
  next: DispatchCallResult[]
): { calls: DispatchCallResult[]; kept: number[] } {
  const readByIndex = new Map(read.map((call) => [call.index, call]));
  const storedByIndex = new Map(stored.map((call) => [call.index, call]));
  const kept: number[] = [];
  const calls = next.map((call) => {
    const storedCall = storedByIndex.get(call.index);
    if (!storedCall) return call;
    if (callFingerprint(storedCall) === callFingerprint(readByIndex.get(call.index))) return call;
    kept.push(call.index);
    const storedState = storedCall as CentralOneCallState;
    const nextState = call as CentralOneCallState;
    const ids = new Set([
      ...(storedState.previousProviderOrderIds ?? []),
      ...(nextState.previousProviderOrderIds ?? []),
      ...(call.providerOrderId ? [call.providerOrderId] : []),
    ]);
    if (storedCall.providerOrderId) ids.delete(storedCall.providerOrderId);
    return ids.size > 0 ? ({ ...storedCall, previousProviderOrderIds: [...ids] } as DispatchCallResult) : storedCall;
  });
  for (const storedCall of stored) {
    if (!next.some((call) => call.index === storedCall.index)) calls.push(storedCall);
  }
  calls.sort((a, b) => a.index - b.index);
  return { calls, kept };
}

/**
 * Códigos entregados por llamada, fuera del doc de la orden.
 *
 * El dueño puede leer `orders/{id}` entero (reglas de Firestore, para ver el
 * estado en vivo). Con los códigos en `dispatch.calls[].deliveredCodes`, una
 * gift card de varias unidades con una entregada y otra fallida dejaba leer el
 * código entregado aunque luego se reembolsara la orden completa. Aquí sólo
 * entra el Admin SDK; el cliente los recibe en `deliveredCodes` cuando la
 * orden se completa, y el panel los lee por su API.
 */
export const orderDeliveryDoc = (orderId: string) => orders().doc(orderId).collection('private').doc('delivery');

/** Separa los códigos de las llamadas para guardarlos aparte. Pura. */
export function splitCallCodes(calls: DispatchCallResult[]): {
  calls: DispatchCallResult[];
  codes: Record<string, string[]>;
} {
  const codes: Record<string, string[]> = {};
  const clean = calls.map((call) => {
    if (call.deliveredCodes === undefined) return call;
    const { deliveredCodes, ...rest } = call;
    if (deliveredCodes && deliveredCodes.length > 0) codes[String(call.index)] = deliveredCodes;
    return rest as DispatchCallResult;
  });
  return { calls: clean, codes };
}

/** Códigos por llamada guardados en `orders/{id}/private/delivery`. */
function storedCallCodes(data: FirebaseFirestore.DocumentData | undefined): Record<string, string[]> {
  const raw = (data?.callCodes ?? {}) as Record<string, unknown>;
  const out: Record<string, string[]> = {};
  for (const [index, codes] of Object.entries(raw)) {
    if (Array.isArray(codes)) out[index] = codes.filter((code): code is string => typeof code === 'string');
  }
  return out;
}

/** Escribe `dispatch.calls` sin códigos y los códigos en el doc privado. */
function writeCalls(
  tx: FirebaseFirestore.Transaction,
  orderId: string,
  calls: DispatchCallResult[],
  buildPatch: (cleanCalls: DispatchCallResult[]) => Record<string, unknown>
): void {
  const { calls: clean, codes } = splitCallCodes(calls);
  tx.set(orders().doc(orderId), buildPatch(clean), { merge: true });
  if (Object.keys(codes).length > 0) {
    tx.set(orderDeliveryDoc(orderId), { callCodes: codes, updatedAt: now() }, { merge: true });
  }
}

// ---------------------------------------------------------------------------
// Central One: llave de idempotencia, ambigüedad, pausa por saldo y códigos
// ---------------------------------------------------------------------------

/**
 * Seguimiento de Central One que viaja dentro de la llamada.
 *
 * Firestore guarda la llamada tal cual, así que estos campos se tipan aquí y
 * no en el modelo compartido: sólo este módulo los escribe y los lee.
 */
type CentralOneCallState = DispatchCallResult & {
  /** Llave del último `POST /orders` de esta llamada. */
  idempotencyKey?: string | null;
  /** Cuántos POST se hicieron con `idempotencyKey` (el cron se rinde al tercero sin confirmación). */
  keyAttempts?: number;
  /**
   * Último motivo de Central One: `ambiguous`/`network_error`/`timeout`/
   * `unconfirmed` (pudo entrar), `insufficient_balance` (pausa),
   * `codes_pending` (entregado sin códigos aún) o el código de un fallo.
   */
  errorCode?: string | null;
  /**
   * Central One CONFIRMÓ que la llave actual no tiene un pedido vivo: lo
   * rechazó en firme al crearlo, o `GET /orders/{id}` lo dio por cerrado sin
   * entregar. Sólo entonces el próximo intento puede comprar con otra llave.
   */
  keyClosed?: boolean;
  /** Desde cuándo está en pausa por falta de saldo en Central One. */
  balanceBlockedAt?: TimestampLike | null;
  /** Último aviso al equipo por falta de saldo (como mucho uno por hora). */
  balanceAlertAt?: TimestampLike | null;
  /** Por qué sigue en curso, en palabras para el panel. */
  pendingReason?: string | null;
  /**
   * Pedidos de Central One de llaves ya rotadas. Un pedido «fallido» puede
   * entregarse después (Central One lo documenta): sin guardarlos, su aviso
   * tardío no se reconocía y un doble cobro o un reembolso con entrega pasaban
   * sin que nadie se enterara.
   */
  previousProviderOrderIds?: string[];
};

/** POST con la misma llave que el cron hace antes de dar por incierto un pedido. */
const CENTRAL_ONE_MAX_POSTS_PER_KEY = 3;
/** Sin saldo se reintenta solo durante este tiempo antes de pasar a revisión. */
const CENTRAL_ONE_BALANCE_GIVE_UP_MS = 24 * 60 * 60_000;
/** Un aviso de saldo por llamada como mucho cada hora: el cron pasa cada 2 min. */
const CENTRAL_ONE_BALANCE_ALERT_MS = 60 * 60_000;
/** Motivos tras los que el pedido pudo quedar creado sin que sepamos su id. */
const CENTRAL_ONE_MAY_EXIST_CODES = new Set([
  'ambiguous',
  'network_error',
  'timeout',
  'unconfirmed',
  'ambiguous_unresolved',
]);

/** Llave base de una llamada: `RF-8K3M2Q-1`. */
export function centralOneBaseKey(orderCode: string, index: number): string {
  return `${orderCode}-${index + 1}`;
}

/**
 * Llave del próximo `POST /orders` de una llamada. Función pura.
 *
 * Central One devuelve el pedido original (sin cobrar otra vez) cuando se
 * repite la llave, así que repetirla es SIEMPRE seguro: es la respuesta a un
 * timeout, un 5xx, un 429 o un 409 de llave. Sólo cuando Central One confirmó
 * que esa llave no dejó un pedido vivo (`keyClosed`) hace falta una nueva,
 * `-r{intento}`, o el reintento recibiría otra vez el pedido fallido.
 * `attempt` es el número del intento que se va a hacer (ya sumado).
 */
export function nextCentralOneKey(
  call: Pick<CentralOneCallState, 'index' | 'idempotencyKey' | 'keyClosed'>,
  orderCode: string,
  attempt: number
): string {
  const base = centralOneBaseKey(orderCode, call.index);
  const current = call.idempotencyKey || base;
  if (!call.keyClosed) return current;
  return `${base}-r${Math.max(2, attempt)}`;
}

/**
 * ¿Pudo quedar un pedido creado en Central One para esta llamada? Función pura.
 *
 * Con id de pedido, sí. Sin id, sólo si el último POST fue ambiguo (red, 5xx,
 * 429, 409 de llave, aceptado sin id). Las llamadas anteriores a este
 * seguimiento no traen `errorCode`: se deduce de su HTTP, porque entonces un
 * 5xx se guardaba como `failed` y aun así pudo haber entrado.
 */
export function centralOneCallMayExist(
  call: Pick<
    CentralOneCallState,
    'providerOrderId' | 'keyClosed' | 'errorCode' | 'attempts' | 'providerStatus' | 'httpStatus'
  >
): boolean {
  if (call.providerOrderId) return true;
  if (call.keyClosed) return false;
  const code = (call.errorCode ?? '').toLowerCase();
  if (code) return CENTRAL_ONE_MAY_EXIST_CODES.has(code);
  if ((call.attempts ?? 0) <= 0) return false;
  const status = (call.providerStatus ?? '').toLowerCase();
  const http = call.httpStatus ?? null;
  return (
    status === 'network_error' ||
    status === 'ambiguous' ||
    http === 0 ||
    http === 409 ||
    http === 429 ||
    (http !== null && http >= 500)
  );
}

/** Mensaje de una llamada que pudo haber entrado y no se pudo confirmar. */
function centralOneUncertainMessage(key: string): string {
  return `El pedido pudo haber entrado en Central One (llave ${key}); no se compró otro. Revísalo en su portal antes de reintentar o reembolsar.`;
}

/**
 * La llamada entrega códigos (gift card) y no puede cerrarse sin ellos.
 * `targetFields: []` es la marca que deja la sincronización en las gift cards.
 */
function centralOneNeedsCodes(order: Order, call: DispatchCallResult): boolean {
  return (
    order.providerFamily === 'gift_card' ||
    order.providerFamily === 'game_key' ||
    (Array.isArray(call.targetFields) && call.targetFields.length === 0)
  );
}

function millisOf(value: TimestampLike | null | undefined): number | null {
  const candidate = value as { toMillis?: () => number } | null | undefined;
  return candidate && typeof candidate.toMillis === 'function' ? candidate.toMillis() : null;
}

/** Saldo que Central One deja tras cobrar el pedido, si lo informa. */
function centralOneBalanceAfter(raw: Record<string, unknown>): number | null {
  const orderRaw = (raw?.order ?? null) as Record<string, any> | null;
  return centralOne.parseAmount(orderRaw?.pricing?.balance_after ?? orderRaw?.balance_after);
}

/**
 * Lee los códigos de un pedido que Central One dio por entregado.
 *
 * Una gift card no se cierra sin códigos: si `GET /orders/{id}/codes` falla
 * (p. ej. la llave no tiene `codes:read`) o viene vacío, se devuelve `ok:false`
 * y la llamada sigue en curso. En una recarga a cuenta los códigos son un
 * extra: se guardan si los hay, pero no frenan la entrega. Los códigos nunca
 * se loguean.
 */
async function readCentralOneCodes(
  order: Order,
  call: DispatchCallResult,
  providerOrderId: string,
  deliveredCount: number
): Promise<{ ok: true; codes: string[] } | { ok: false; message: string }> {
  const needsCodes = centralOneNeedsCodes(order, call);
  if (!needsCodes && deliveredCount <= 0) return { ok: true, codes: [] };

  const result = await centralOne.getOrderCodes(providerOrderId).catch(() => null);
  const codes = result && result.ok ? result.codes : [];
  if (codes.length > 0) return { ok: true, codes };
  if (!needsCodes) return { ok: true, codes: [] };

  log.warn('Central One entregó una gift card sin códigos legibles; sigue en curso', {
    orderId: order.id,
    providerOrderId,
    code: result && !result.ok ? result.code : 'empty',
  });
  const reason =
    result && !result.ok
      ? result.message
      : 'Central One entregó el pedido pero todavía no devolvió los códigos.';
  return { ok: false, message: `${reason} Se vuelve a consultar sin comprar otro.` };
}

/**
 * Deja constancia de que la llamada está en pausa por falta de saldo y avisa
 * al equipo, como mucho una vez por hora: el cron la reintenta cada 2 minutos.
 */
async function noteCentralOneBalancePause(order: Order, call: CentralOneCallState): Promise<void> {
  if (!millisOf(call.balanceBlockedAt)) call.balanceBlockedAt = now();
  const lastAlert = millisOf(call.balanceAlertAt);
  if (lastAlert !== null && Date.now() - lastAlert < CENTRAL_ONE_BALANCE_ALERT_MS) return;
  call.balanceAlertAt = now();

  await adminAlerts.alert({
    kind: 'low_balance',
    severity: 'critical',
    title: `Saldo insuficiente en Central One · ${order.code}`,
    body: [
      `${describeOrder(order)} (${order.gameName}) está pagada y en pausa: Central One no tiene saldo.`,
      'Recarga el saldo de Central One: la tienda la reintenta sola con la misma llave cada pocos minutos.',
      'No se reembolsa por esto; si en 24 h sigue sin saldo, pasa a revisión manual.',
    ].join('\n'),
    link: `/admin/ordenes/${order.id}`,
    data: { code: order.code, packageId: call.packageId, callIndex: call.index },
  });
}

/** Construye el plan de llamadas a partir de la configuración del producto. */
export function buildCallPlan(
  calls: Array<{
    packageId: number | string;
    quantity: number;
    providerGameId?: number | string | null;
    provider?: 'inefable' | 'fazercards' | 'centralone';
    targetFields?: string[];
  }>
): DispatchCallResult[] {
  const plan: DispatchCallResult[] = [];
  let index = 0;

  for (const call of calls) {
    // `quantity: 2` en un mismo packageId significa dos llamadas idénticas
    // seguidas (el combo 200+20 💎 = dos veces el paquete 1).
    for (let i = 0; i < Math.max(1, call.quantity); i += 1) {
      plan.push({
        packageId: call.packageId,
        // Se congela en el plan: cambiar el catálogo después no puede alterar
        // a dónde se envía una orden que ya se cotizó.
        providerGameId: call.providerGameId ?? null,
        provider: call.provider,
        // Igual que el proveedor: los datos que pide la oferta quedan fijos.
        ...(Array.isArray(call.targetFields) ? { targetFields: [...call.targetFields] } : {}),
        // Cada entrada del plan es UNA unidad: `quantity: N` ya se expandió en
        // N llamadas. Guardar N aquí hacía que Central One comprara N×N.
        quantity: 1,
        index,
        status: 'pending',
        providerOrderId: null,
        providerStatus: null,
        playerName: null,
        providerReference: null,
        error: null,
        httpStatus: null,
        providerResponse: null,
        attempts: 0,
        completedAt: null,
      });
      index += 1;
    }
  }

  return plan;
}

async function loadOrder(orderId: string): Promise<Order> {
  const snap = await orders().doc(orderId).get();
  if (!snap.exists) throw notFound('Orden no encontrada.');
  return { id: snap.id, ...snap.data() } as Order;
}

/** Cierra una orden manual: genera el enlace de WhatsApp y avisa al cliente. */
export async function prepareManualOrder(orderId: string): Promise<DispatchOutcome> {
  const order = await loadOrder(orderId);
  const config = await getConfig();

  // El flujo lo decide el producto. Se lee del catálogo y no de la orden porque
  // es una preferencia de operación, no una condición de la venta: cambiarla
  // debe valer para las órdenes que ya están esperando gestión.
  const productSnap = await products().doc(order.productId).get();
  const flow: ManualFlow = (productSnap.data()?.manualFlow as ManualFlow | undefined) ?? 'notify';

  // El mensaje lleva todos los datos que pidió el juego, no sólo el ID: sin el
  // Zone ID o el correo, el asesor no puede completar la recarga.
  const gameSnap = await games().doc(order.gameId).get();
  const fields = gameSnap.exists
    ? resolvePlayerFields({ id: gameSnap.id, ...gameSnap.data() } as Game)
    : [];

  // Toda orden manual que pasa a awaiting_manual genera siempre su whatsappUrl
  // usando adminNumber con fallback a supportNumber.
  const adminPhone =
    config.whatsapp?.adminNumber?.trim() ||
    config.whatsapp?.supportNumber?.trim() ||
    '584122686326';
  const whatsappUrl = buildManualOrderUrl(order, adminPhone, fields);

  await orders().doc(orderId).set(
    {
      status: 'awaiting_manual',
      whatsappUrl,
      dispatch: {
        ...order.dispatch,
        startedAt: now(),
        completedAt: null,
        lastError: null,
      },
      updatedAt: now(),
    },
    { merge: true }
  );

  await addEvent({
    orderId,
    type: 'manual_ready',
    message:
      flow === 'whatsapp'
        ? 'Pago verificado. Producto manual listo para gestionar por WhatsApp.'
        : 'Pago verificado. Producto manual pendiente de entrega por el equipo.',
    status: 'awaiting_manual',
  });

  // Cuando el cliente dejó su teléfono, el aviso trae el enlace listo para que
  // sea la tienda quien escriba: es lo que evita que el cliente tenga que dar
  // el primer paso.
  const contactPhone = order.contactPhone ?? null;
  const contactLink = contactPhone
    ? buildWhatsappUrl(
        contactPhone,
        `Hola 👋 Soy de Refill Store. Vi tu orden ${order.code} (${describeOrder(order)}). Ya la estoy gestionando.`
      )
    : null;

  await Promise.all([
    notifications.notify({
      uid: order.uid,
      title: 'Pago confirmado ✅',
      body:
        flow === 'whatsapp'
          ? `Tu ${describeOrder(order)} se entrega por WhatsApp. Abre el chat para completarlo.`
          : `Tu ${describeOrder(order)} está siendo procesada. Te avisamos aquí y por correo apenas esté lista.`,
      type: 'order',
      link: `/orden/${orderId}`,
    }),
    adminAlerts.alert({
      kind: 'manual_order',
      severity: 'warning',
      title: `Producto manual pagado · ${order.code}`,
      body: [
        `${describeOrder(order)} (${order.gameName}).`,
        `Cuenta a recargar: ${order.playerId}.`,
        `Cobrado: ${order.pricing.totalBs.toFixed(2)} Bs.`,
        contactPhone
          ? `Escríbele tú: ${contactPhone}${contactLink ? ` — ${contactLink}` : ''}`
          : flow === 'whatsapp'
            ? 'El cliente puede escribir por WhatsApp.'
            : 'Entrégalo y márcalo como completado desde el panel.',
      ].join('\n'),
      link: `/admin/ordenes/${orderId}`,
      data: {
        code: order.code,
        playerId: order.playerId,
        customer: order.user.email,
        contactPhone,
      },
    }),
  ]);

  return {
    status: 'awaiting_manual',
    calls: [],
    allSucceeded: true,
    message:
      flow === 'whatsapp'
        ? 'Producto manual listo para gestión por WhatsApp.'
        : 'Producto manual pendiente de entrega por el equipo.',
  };
}

/**
 * Ejecuta (o reintenta) las llamadas pendientes de una orden automática.
 *
 * El cambio de estado a `dispatching` se hace con una transacción que exige que
 * la orden esté en `paid`, `dispatching` o `failed`: así dos ejecuciones
 * simultáneas (por ejemplo, el cliente reintentando y el admin a la vez) no
 * pueden despachar la misma orden dos veces.
 */
export async function dispatchOrder(
  orderId: string,
  options: { actorUid?: string | null; isRetry?: boolean } = {}
): Promise<DispatchOutcome> {
  const orderRef = orders().doc(orderId);

  const claimed = await orderRef.firestore.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) throw notFound('Orden no encontrada.');

    const order = { id: snap.id, ...snap.data() } as Order;

    if (order.fulfillment !== 'auto') return { order, claimed: false as const };
    if (
      order.status === 'cancelled' ||
      order.status === 'refunded' ||
      Boolean(order.refundedAt) ||
      order.pricing?.walletRefunded === true
    ) {
      log.warn('Intento de despachar una orden ya cancelada o reembolsada (ignorado)', {
        orderId,
        code: order.code,
        status: order.status,
      });
      return { order, claimed: false as const };
    }
    if (!['paid', 'dispatching', 'in_review', 'failed'].includes(order.status)) {
      return { order, claimed: false as const };
    }
    // Otra ejecución ya está en marcha: no la duplicamos.
    if (order.status === 'dispatching' && !options.isRetry) {
      return { order, claimed: false as const };
    }

    const initialProvider = order.provider ?? 'inefable';
    tx.set(
      orderRef,
      {
        status: 'dispatching',
        estado:
          initialProvider === 'centralone'
            ? 'DESPACHANDO_CENTRAL_ONE'
            : initialProvider === 'fazercards'
              ? 'DESPACHANDO_FAZERCARDS'
              : 'DESPACHANDO_INEFABLE',
        dispatch: { ...order.dispatch, startedAt: order.dispatch.startedAt ?? now() },
        updatedAt: now(),
      },
      { merge: true }
    );

    return { order, claimed: true as const };
  });

  if (!claimed.claimed) {
    return {
      status: claimed.order.status,
      calls: claimed.order.dispatch.calls,
      allSucceeded: claimed.order.status === 'completed',
      message: 'La orden no estaba en un estado despachable.',
    };
  }

  const order = claimed.order;
  const config = await getConfig();

  if (!config.features.autoDispatchEnabled) {
    const reason = 'El despacho automático está desactivado desde el panel.';
    const finalStatus = await finalizeDispatch(order, order.dispatch.calls, false, {
      failure: reason,
      actorUid: options.actorUid ?? null,
      anyProcessing: false,
    });
    return {
      status: finalStatus,
      calls: order.dispatch.calls,
      allSucceeded: false,
      message: 'El despacho automático está desactivado.',
    };
  }

  // Las órdenes creadas antes de que se congelara `providerGameId` no lo traen:
  // para esas se cae al catálogo. Sin este dato el proveedor no sabe a qué
  // juego pertenece el paquete y puede emparejarlo con otro.
  let providerGameId = order.providerGameId ?? null;
  const provider = order.provider ?? 'inefable';
  if (providerGameId === null || providerGameId === undefined) {
    if (provider === 'centralone') {
      providerGameId = order.gameId ?? 'free-fire';
    } else {
      const gameSnap = await games().doc(order.gameId).get();
      providerGameId = (gameSnap.data()?.apiGameId as number | string | undefined) ?? null;
    }
  }

  if (providerGameId === null) {
    const reason = `No se pudo determinar el game_id del proveedor para ${order.gameId}.`;
    const finalStatus = await finalizeDispatch(order, order.dispatch.calls, false, {
      failure: reason,
      actorUid: options.actorUid ?? null,
      anyProcessing: false,
    });
    return { status: finalStatus, calls: order.dispatch.calls, allSucceeded: false, message: reason };
  }

  const calls = order.dispatch.calls.map((call) => ({ ...call }));

  // Auto-reparación para combos incompletos: si la orden define más `productIds` que llamadas registradas
  // (por ejemplo, si un fallo anterior truncó el array o el combo provino de un bot externo),
  // reconstruimos las llamadas pendientes faltantes antes de iterar para no dejar el combo a medias.
  const expectedProductIds = Array.isArray(order.productIds) ? order.productIds : [];
  if (expectedProductIds.length > calls.length) {
    for (let idx = calls.length; idx < expectedProductIds.length; idx++) {
      const rawPkgId = expectedProductIds[idx];
      // Los paquetes de Inefable son numéricos; los de Central One son UUID y
      // convertirlos a número los volvía `NaN`.
      const pkgId =
        typeof rawPkgId === 'number' || !Number.isFinite(Number(rawPkgId))
          ? rawPkgId
          : Number(rawPkgId);
      calls.push({
        packageId: pkgId,
        providerGameId,
        index: idx,
        provider,
        status: 'pending',
        providerOrderId: null,
        providerStatus: null,
        playerName: null,
        providerReference: null,
        error: null,
        httpStatus: null,
        providerResponse: null,
        attempts: 0,
        completedAt: null,
      });
    }
  }

  let failure: string | null = null;

  await addEvent({
    orderId,
    type: options.isRetry ? 'dispatch_retry' : 'dispatch_start',
    message: options.isRetry
      ? 'Reintentando el despacho de las recargas pendientes.'
      : `Enviando ${calls.length} recarga(s) al proveedor.`,
    status: 'dispatching',
    actor: options.actorUid ? 'admin' : 'system',
    actorUid: options.actorUid ?? null,
  });

  for (const call of calls) {
    // Las llamadas ya exitosas NO se repiten: el jugador ya recibió esos
    // diamantes y repetirlas sería regalar producto. Las aceptadas y en curso
    // tampoco: el pedido ya está puesto y repetirlo lo cobraría dos veces.
    if (call.status === 'success' || call.status === 'processing') continue;

    const externalOrderId = `${order.code}-${call.index + 1}`;
    const callProvider = call.provider ?? provider;

    // Candado anti-doble cobro en reintentos (Inefable):
    // Si la llamada viene de un reintento (tenía intentos previos o estaba en estado error),
    // consultamos primero al proveedor para verificar si ya fue completada antes de disparar un nuevo POST.
    if (callProvider === 'inefable' && (options.isRetry || call.attempts > 0 || call.status === 'error')) {
      try {
        const existing = await inefable.getOrderStatus(externalOrderId);
        if (existing.found && existing.status) {
          if (inefable.isSuccessStatus(existing.status)) {
            log.info('Candado anti-doble cobro: la recarga ya figuraba completada en Inefable', {
              orderId,
              externalOrderId,
              providerOrderId: existing.providerOrderId,
              providerReference: existing.providerReference,
            });

            call.status = 'success';
            call.error = null;
            call.completedAt = now();
            call.providerOrderId = existing.providerOrderId ?? call.providerOrderId;
            call.providerReference = existing.providerReference ?? call.providerReference;
            call.providerStatus = existing.status;
            call.httpStatus = 200;

            await addEvent({
              orderId,
              type: 'dispatch_call_ok',
              message: `Recarga ${call.index + 1}/${calls.length} ya estaba completada en el proveedor (paquete ${call.packageId}).`,
              data: {
                providerOrderId: call.providerOrderId,
              },
            });

            // Continúa con la siguiente llamada pendiente del combo
            continue;
          }

          if (inefable.isPendingStatus(existing.status)) {
            log.info('Candado anti-doble cobro: la recarga sigue en proceso en Inefable', {
              orderId,
              externalOrderId,
              providerOrderId: existing.providerOrderId,
            });

            call.status = 'processing';
            call.error = null;
            call.providerOrderId = existing.providerOrderId ?? call.providerOrderId;
            call.providerReference = existing.providerReference ?? call.providerReference;
            call.providerStatus = existing.status;
            call.httpStatus = 202;

            await addEvent({
              orderId,
              type: 'dispatch_call_processing',
              message: `El proveedor sigue procesando la recarga ${call.index + 1}/${calls.length}.`,
              data: {
                packageId: call.packageId,
                providerOrderId: call.providerOrderId,
                providerStatus: call.providerStatus,
              },
            });

            // No reintentar mientras esté en proceso
            continue;
          }
        }
      } catch (err) {
        log.warn('No se pudo verificar getOrderStatus previo al reintento en Inefable', {
          orderId,
          externalOrderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Candado anti-doble cobro en reintentos (Central One). Decide si el
    // próximo POST va con la misma llave o con una nueva: sólo se rota cuando
    // `GET /orders/{id}` CONFIRMA que el pedido anterior cerró sin entregar.
    if (callProvider === 'centralone' && (options.isRetry || call.attempts > 0 || call.status === 'error')) {
      const state = call as CentralOneCallState;
      if (call.providerOrderId) {
        const existing = await centralOne.getOrder(call.providerOrderId).catch(() => null);

        if (existing?.found && existing.isSuccess) {
          const codes = await readCentralOneCodes(order, call, call.providerOrderId, existing.deliveredCount);
          call.providerReference = existing.referenceCode ?? call.providerReference;
          call.providerStatus = existing.lineStatus || existing.orderStatus;
          call.providerResponse = existing.raw;

          if (codes.ok) {
            log.info('Candado anti-doble cobro: la recarga ya figuraba completada en Central One', {
              orderId,
              externalOrderId,
              providerOrderId: call.providerOrderId,
              providerReference: existing.referenceCode,
            });
            if (codes.codes.length) call.deliveredCodes = codes.codes;
            call.status = 'success';
            call.error = null;
            call.completedAt = now();
            call.httpStatus = 200;
            state.errorCode = null;
            state.pendingReason = null;

            await addEvent({
              orderId,
              type: 'dispatch_call_ok',
              message: `Recarga ${call.index + 1}/${calls.length} ya estaba completada en Central One (paquete ${call.packageId}).`,
              data: { providerOrderId: call.providerOrderId },
            });
            continue;
          }

          // Entregada pero sin códigos: se espera, nunca se compra otra.
          call.status = 'processing';
          call.error = null;
          call.httpStatus = 202;
          state.errorCode = 'codes_pending';
          state.pendingReason = codes.message;
          await addEvent({
            orderId,
            type: 'dispatch_call_processing',
            message: `Recarga ${call.index + 1}/${calls.length}: ${codes.message}`,
            data: { packageId: call.packageId, providerOrderId: call.providerOrderId },
          });
          continue;
        }

        if (existing?.found && existing.isPending) {
          log.info('Candado anti-doble cobro: la recarga sigue en proceso en Central One', {
            orderId,
            externalOrderId,
            providerOrderId: call.providerOrderId,
          });

          call.status = 'processing';
          call.error = null;
          call.providerReference = existing.referenceCode ?? call.providerReference;
          call.providerStatus = existing.lineStatus || existing.orderStatus;
          call.httpStatus = 202;

          await addEvent({
            orderId,
            type: 'dispatch_call_processing',
            message: `Central One sigue procesando la recarga ${call.index + 1}/${calls.length}.`,
            data: {
              packageId: call.packageId,
              providerOrderId: call.providerOrderId,
              providerStatus: call.providerStatus,
            },
          });
          continue;
        }

        if (existing?.found && existing.isFailed) {
          // Confirmado: el pedido de esta llave cerró sin entregar. Repetir la
          // llave devolvería ese mismo pedido fallido; se compra con otra.
          state.keyClosed = true;
          state.errorCode = existing.failureCode ?? 'failed';
        } else {
          // No se pudo confirmar (sin llave, red, 404, 5xx). Comprar con otra
          // llave podría cobrar dos veces; repetir la misma es seguro porque
          // Central One devuelve el pedido original.
          log.warn('No se pudo confirmar el pedido anterior en Central One; se reintenta con la misma llave', {
            orderId,
            externalOrderId,
            providerOrderId: call.providerOrderId,
            failureCode: existing?.failureCode ?? null,
          });
          state.keyClosed = false;
        }
      }
    }

    call.attempts += 1;

    try {
      const result =
        callProvider === 'centralone'
          ? await dispatchCentralOneCall(order, call, options)
          : callProvider === 'fazercards'
            ? await dispatchFazerCall(order, call, providerGameId)
            : await inefable.createOrder({
              // Inefable sólo admite IDs enteros. La validación explícita evita
              // que una oferta de FazerCards se envíe por accidente al API viejo.
              gameId: requireInefableId(call.providerGameId ?? providerGameId, 'game_id'),
              packageId: requireInefableId(call.packageId, 'package_id'),
              playerId: order.playerId,
              playerId2: order.playerId2 ?? null,
              externalOrderId,
            });

      // Una compra de saldo digital no se puede marcar entregada sin que el
      // proveedor haya devuelto el PIN/clave; se mantiene en seguimiento.
      if (
        provider === 'fazercards' &&
        (order.providerFamily === 'gift_card' || order.providerFamily === 'game_key') &&
        result.success &&
        (!('codes' in result) || !Array.isArray(result.codes) || result.codes.length === 0)
      ) {
        result.success = false;
        result.processing = true;
        result.message = 'Compra aceptada; esperando los códigos digitales del proveedor.';
      }

      // El saldo del proveedor viaja en cada respuesta: es el momento más
      // barato para detectar que se está agotando.
      void adminAlerts.checkProviderBalance(
        result.remainingBalance ?? null,
        callProvider === 'centralone' ? 'Central One' : callProvider === 'fazercards' ? 'FazerCards' : 'Inefable'
      );

      // Se registra la respuesta del proveedor pase lo que pase: es la única
      // pista para diagnosticar después por qué una entrega no salió.
      call.providerOrderId = result.providerOrderId;
      call.providerStatus = result.providerStatus;
      call.provider = callProvider;
      call.playerName = result.playerName;
      call.providerReference = result.providerReference;
      call.httpStatus = result.httpStatus;
      // Central One: los códigos viajan sólo en `deliveredCodes`, nunca en la
      // respuesta guardada (el cliente puede leer su orden).
      call.providerResponse = callProvider === 'centralone' ? stripCodes(result.raw) : result.raw;
      if ('codes' in result && Array.isArray(result.codes) && result.codes.length) {
        call.deliveredCodes = result.codes as string[];
      }

      // FazerCards avisa por su propio `order_id`, no por nuestro código. Se
      // indexa apenas responde para que el webhook resuelva en O(1), incluso
      // cuando haya muchas órdenes simultáneas.
      if ((callProvider === 'fazercards' || callProvider === 'centralone') && result.providerOrderId) {
        await indexProviderOrder(callProvider, result.providerOrderId, orderId, call.index);
      }

      if (result.success) {
        call.status = 'success';
        call.error = null;
        call.completedAt = now();

        await addEvent({
          orderId,
          type: 'dispatch_call_ok',
          message: `Recarga ${call.index + 1}/${calls.length} enviada (paquete ${call.packageId})${
            result.playerName ? ` a ${result.playerName}` : ''
          }.`,
          data: {
            providerOrderId: result.providerOrderId,
            remainingBalance: result.remainingBalance,
          },
        });
      } else if (result.processing) {
        // El proveedor la aceptó y la termina en unos minutos. Se deja marcada
        // para que la tarea programada consulte el resultado: ni se reintenta
        // ni se le dice al cliente que falló.
        call.status = 'processing';
        call.error = null;

        await addEvent({
          orderId,
          type: 'dispatch_call_processing',
          // Central One también deja en curso lo ambiguo y la pausa por saldo:
          // el evento dice cuál de los casos es.
          message:
            callProvider === 'centralone' && result.message
              ? `Recarga ${call.index + 1}/${calls.length}: ${result.message}`
              : `El proveedor aceptó la recarga ${call.index + 1}/${calls.length} y la está procesando.`,
          data: {
            packageId: call.packageId,
            providerOrderId: result.providerOrderId,
            providerStatus: result.providerStatus,
          },
        });
      } else {
        const cleanMsg = sanitizeProviderError(result.message, result.httpStatus);
        call.status = 'error';
        call.error = cleanMsg;
        failure = cleanMsg;

        await addEvent({
          orderId,
          type: 'dispatch_call_error',
          message: `Falló la recarga ${call.index + 1}/${calls.length}: ${cleanMsg}`,
          data: {
            packageId: call.packageId,
            httpStatus: result.httpStatus,
            providerStatus: result.providerStatus,
          },
        });
        // Secuencia detenida: no se envía la siguiente parte del combo.
        break;
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const cleanMsg = sanitizeProviderError(rawMessage);
      call.status = 'error';
      call.error = cleanMsg;
      failure = cleanMsg;

      await addEvent({
        orderId,
        type: 'dispatch_call_error',
        message: `Error al contactar al proveedor en la recarga ${call.index + 1}: ${cleanMsg}`,
      });
      break;
    }

    // Respiro entre llamadas de un combo: algunos proveedores rechazan dos
    // pedidos idénticos en el mismo segundo tomándolos por duplicados.
    if (calls.length > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  const allSucceeded = calls.every((call) => call.status === 'success');
  const anyProcessing = calls.some((call) => call.status === 'processing');

  const finalStatus = await finalizeDispatch(order, calls, allSucceeded, {
    failure,
    actorUid: options.actorUid ?? null,
    anyProcessing,
    // Mientras se despachaba, el cron o el webhook pudieron cerrar alguna
    // llamada: el cierre no pisa lo que cambiaron.
    readCalls: order.dispatch.calls,
  });

  return {
    status: finalStatus,
    calls,
    allSucceeded: finalStatus === 'completed',
    message:
      finalStatus === 'completed'
        ? 'Recarga entregada correctamente.'
        : finalStatus === 'dispatching'
          ? 'El proveedor aceptó la recarga y la está procesando.'
          : (failure ?? 'No se pudo completar el despacho.'),
  };
}

/** Resultado de una llamada al proveedor, con la forma que aplica `dispatchOrder`. */
interface CentralOneCallOutcome {
  success: boolean;
  processing?: boolean;
  providerOrderId: string | null;
  providerStatus: string | null;
  providerReference: string | null;
  playerName: string | null;
  remainingBalance?: number | null;
  raw: Record<string, unknown>;
  httpStatus: number | null;
  message?: string;
  codes?: string[];
}

/**
 * Hace UN `POST /orders` de Central One para la llamada y lo interpreta.
 *
 * Además de devolver el resultado, deja en la llamada el seguimiento que
 * necesitan el cron y los reintentos (`CentralOneCallState`): la llave usada,
 * cuántas veces se usó, si quedó cerrada y el motivo. Reglas:
 *
 *  - Siempre `quantity: 1`: cada llamada del plan ya es una unidad.
 *  - `target_payload` con exactamente `call.targetFields` (congelados en la
 *    orden); sin lista, la heurística por juego de los productos sembrados.
 *    Gift cards (`[]`): sin `target_payload`.
 *  - Ambiguo (red, 5xx, 429, 409 de llave) → en curso con la MISMA llave.
 *  - Sin saldo → en curso y en pausa, misma llave, aviso crítico. Nunca fallo:
 *    un fallo pasaría a revisión y de ahí al reembolso automático.
 *  - Gift card entregada sin códigos → en curso; nunca se completa sin ellos.
 */
async function dispatchCentralOneCall(
  order: Order,
  call: DispatchCallResult,
  options: { isRetry?: boolean; actorUid?: string | null }
): Promise<CentralOneCallOutcome> {
  const state = call as CentralOneCallState;
  const idempotencyKey = nextCentralOneKey(state, order.code, call.attempts);
  const currentKey = state.idempotencyKey || centralOneBaseKey(order.code, call.index);
  const sameKey = idempotencyKey === currentKey;

  if (!sameKey) {
    // Justo antes de comprar con llave nueva se relee la orden: mientras se
    // consultaba el pedido anterior, el cron, el webhook u otro reintento pudo
    // tocar esta llamada (comprar, adoptar un id, cerrarla). Comprar sobre esa
    // copia vieja sería un segundo pedido. Si ya no está como se leyó, no se
    // compra y la llamada se deja en curso para que manda lo guardado.
    const fresh = await loadOrder(order.id).catch(() => null);
    const stored = fresh?.dispatch?.calls?.find((item) => item.index === call.index) as
      | CentralOneCallState
      | undefined;
    const rotationAllowed = Boolean(
      fresh &&
        fresh.status === 'dispatching' &&
        !fresh.refundedAt &&
        fresh.pricing?.walletRefunded !== true &&
        stored &&
        stored.status !== 'success' &&
        stored.status !== 'processing' &&
        (stored.idempotencyKey || centralOneBaseKey(order.code, call.index)) === currentKey &&
        (stored.providerOrderId ?? null) === (call.providerOrderId ?? null)
    );
    if (!rotationAllowed) {
      log.warn('Reintento de Central One sin compra: la llamada cambió mientras se consultaba', {
        orderId: order.id,
        callIndex: call.index,
        status: fresh?.status ?? null,
      });
      return {
        success: false,
        processing: true,
        providerOrderId: call.providerOrderId,
        providerStatus: call.providerStatus,
        providerReference: call.providerReference,
        playerName: call.playerName,
        raw: {},
        httpStatus: null,
        message: 'La llamada cambió mientras se reintentaba; no se compró otro pedido.',
      };
    }
  }

  // Una llave nueva estrena su cuenta de intentos; un reintento manual del
  // panel también, para que el cron pueda volver a confirmarla.
  if (!sameKey || options.actorUid) state.keyAttempts = 0;
  // El pedido de una llave cerrada ya no es el de esta llamada, pero se
  // recuerda: Central One puede entregarlo tarde (ver `previousProviderOrderIds`).
  if (!sameKey && call.providerOrderId) {
    const previous = new Set(state.previousProviderOrderIds ?? []);
    previous.add(call.providerOrderId);
    state.previousProviderOrderIds = [...previous];
  }
  const previousOrderId = sameKey ? call.providerOrderId : null;
  state.idempotencyKey = idempotencyKey;
  state.keyClosed = false;
  state.keyAttempts = (state.keyAttempts ?? 0) + 1;

  const orderFields = order.playerFields ?? {};
  const targetPayload = Array.isArray(call.targetFields)
    ? centralOne.buildTargetPayloadFromFields(call.targetFields, orderFields, {
        playerId: order.playerId,
        playerId2: order.playerId2,
      })
    : centralOne.buildCentralOneTargetPayload(
        order.gameId || '',
        order.playerId || '',
        order.playerId2 || orderFields.server_id || orderFields.zone_id || (order as any).serverId || (order as any).zoneId,
        orderFields
      );

  const createResult = await centralOne.createOrder({
    catalogItemId: String(call.packageId),
    quantity: 1,
    targetPayload,
    idempotencyKey,
    note: `Orden ${order.code} - ${order.gameName}`,
  });
  const remainingBalance = centralOneBalanceAfter(createResult.raw);

  if (!createResult.success) {
    const failureCode = (createResult.failureCode ?? '').toLowerCase();

    if (failureCode === 'insufficient_balance') {
      // No se creó nada: los POST rechazados por saldo no cuentan para el tope
      // de intentos ambiguos de la llave.
      state.keyAttempts = 0;
      state.errorCode = 'insufficient_balance';
      const message =
        'Central One no tiene saldo suficiente: la recarga queda en pausa y se reintenta sola con la misma llave.';
      state.pendingReason = message;
      await noteCentralOneBalancePause(order, state);
      return {
        success: false,
        processing: true,
        providerOrderId: previousOrderId,
        providerStatus: 'insufficient_balance',
        providerReference: null,
        playerName: null,
        raw: createResult.raw,
        httpStatus: createResult.httpStatus,
        message,
      };
    }

    if (centralOne.isAmbiguousCreateFailure(createResult)) {
      state.errorCode = createResult.status === 'network_error' ? 'network_error' : 'ambiguous';
      state.balanceBlockedAt = null;
      const message =
        'Central One no confirmó si el pedido entró; se confirmará con la misma llave sin comprar otro.';
      state.pendingReason = message;
      log.warn('POST /orders ambiguo en Central One; se mantiene la llave', {
        orderId: order.id,
        idempotencyKey,
        httpStatus: createResult.httpStatus,
        failureCode,
        keyAttempts: state.keyAttempts,
      });
      return {
        success: false,
        processing: true,
        // Si ya había pedido con esta llave, se conserva: es el que se consulta.
        providerOrderId: previousOrderId,
        providerStatus: createResult.status || 'ambiguous',
        providerReference: null,
        playerName: null,
        raw: createResult.raw,
        httpStatus: createResult.httpStatus,
        message,
      };
    }

    // Rechazo en firme: Central One no creó el pedido. `missing_config` ni
    // siquiera salió, así que no gasta intento ni cierra la llave.
    state.balanceBlockedAt = null;
    state.pendingReason = null;
    state.errorCode = failureCode || 'failed';
    if (failureCode === 'missing_config') {
      state.keyAttempts = Math.max(0, (state.keyAttempts ?? 1) - 1);
    } else {
      state.keyClosed = true;
    }

    const isNotEligible =
      createResult.failureCode === 'not_eligible' ||
      createResult.failureAction === 'do_not_retry';

    const failureMsg = isNotEligible
      ? 'La cuenta del jugador no es elegible para este nivel (ya fue reclamado anteriormente o no cumple el requisito).'
      : centralOne.formatCentralOneFailure({
          code: createResult.failureCode,
          action: createResult.failureAction,
          message: createResult.errorMessage,
        });

    return {
      success: false,
      processing: false,
      providerOrderId: null,
      providerStatus: createResult.status || 'failed',
      providerReference: null,
      playerName: null,
      raw: createResult.raw,
      httpStatus: createResult.httpStatus,
      message: failureMsg,
    };
  }

  state.balanceBlockedAt = null;
  const orderId = createResult.orderId;
  const referenceCode = createResult.referenceCode;

  // Aceptado sin identificador (caso anómalo): en curso, y el cron repite con
  // la misma llave para recuperar el id sin comprar otro.
  if (!orderId) {
    state.errorCode = 'unconfirmed';
    state.pendingReason = 'Central One aceptó el pedido sin identificador; se confirma con la misma llave.';
    return {
      success: false,
      processing: true,
      providerOrderId: previousOrderId,
      providerStatus: createResult.status,
      providerReference: referenceCode,
      playerName: null,
      remainingBalance,
      raw: createResult.raw,
      httpStatus: createResult.httpStatus,
      message: 'Orden creada en Central One pero sin identificador de seguimiento.',
    };
  }

  state.errorCode = null;
  state.pendingReason = null;

  // Verificación rápida a los ~2.5 segundos (Regla 2 del manual)
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const orderDetail = await centralOne.getOrder(orderId).catch(() => null);

  if (orderDetail && orderDetail.found) {
    if (orderDetail.isSuccess) {
      const codes = await readCentralOneCodes(order, call, orderId, orderDetail.deliveredCount);
      if (!codes.ok) {
        state.errorCode = 'codes_pending';
        state.pendingReason = codes.message;
        return {
          success: false,
          processing: true,
          providerOrderId: orderId,
          providerStatus: orderDetail.lineStatus || 'completed',
          providerReference: referenceCode,
          playerName: order.playerNickname || null,
          remainingBalance,
          raw: orderDetail.raw,
          httpStatus: 202,
          message: codes.message,
        };
      }
      return {
        success: true,
        processing: false,
        providerOrderId: orderId,
        providerStatus: orderDetail.lineStatus || orderDetail.orderStatus || 'completed',
        providerReference: referenceCode,
        playerName: order.playerNickname || null,
        remainingBalance,
        raw: orderDetail.raw,
        httpStatus: 200,
        message: 'Recarga completada exitosamente en Central One.',
        codes: codes.codes,
      };
    }

    if (orderDetail.isFailed) {
      // Confirmado por `GET /orders/{id}`: cerrado sin entregar.
      state.keyClosed = true;
      state.errorCode = orderDetail.failureCode ?? 'failed';
      return {
        success: false,
        processing: false,
        providerOrderId: orderId,
        providerStatus: orderDetail.lineStatus || orderDetail.orderStatus || 'failed',
        providerReference: referenceCode,
        playerName: order.playerNickname || null,
        remainingBalance,
        raw: orderDetail.raw,
        httpStatus: orderDetail.httpStatus || 400,
        message:
          orderDetail.failureMessage ||
          'Falló la entrega del producto en Central One.',
      };
    }

    return {
      success: false,
      processing: true,
      providerOrderId: orderId,
      providerStatus: orderDetail.lineStatus || orderDetail.orderStatus || 'processing',
      providerReference: referenceCode,
      playerName: order.playerNickname || null,
      remainingBalance,
      raw: orderDetail.raw,
      httpStatus: 202,
      message: 'Orden en proceso en Central One; en cola de entrega.',
    };
  }

  // Si falló la consulta inmediata del detalle, mantener en processing de forma segura
  return {
    success: false,
    processing: true,
    providerOrderId: orderId,
    providerStatus: createResult.status || 'confirmed',
    providerReference: referenceCode,
    playerName: order.playerNickname || null,
    remainingBalance,
    raw: createResult.raw,
    httpStatus: 202,
    message: 'Orden aceptada en Central One; esperando confirmación de entrega.',
  };
}

/** Rutea la llamada FazerCards según la familia congelada en el juego. */
async function dispatchFazerCall(
  order: Order,
  call: DispatchCallResult,
  providerGameId: number | string
) {
  const categoryId = call.providerGameId ?? providerGameId;
  const idempotencyKey = `${order.code}-${call.index + 1}`;
  const family = order.providerFamily ?? 'topup';
  if (family === 'gift_card' || family === 'game_key') {
    return fazercards.createStockOrder({
      family,
      categoryId,
      offerId: call.packageId,
      quantity: 1,
      idempotencyKey,
    });
  }
  const orderFields: Record<string, string> = { ...(order.playerFields ?? {}) };

  // 1. Obtenemos las keys oficiales que FazerCards exige para esta categoría
  // directamente de GET /api/v2/topups/offers?category_id=<categoria> (array "fields")
  let expectedKeys = await fazercards.getTopupFieldKeys(String(categoryId)).catch(() => []);

  // 2. Si la consulta al API falló o vino vacía, leemos las keys declaradas en el juego en Firestore
  if (expectedKeys.length === 0) {
    try {
      const gameSnap = await games().doc(order.gameId).get();
      if (gameSnap.exists) {
        const g = gameSnap.data() as Game;
        if (Array.isArray(g.playerFields) && g.playerFields.length > 0) {
          expectedKeys = g.playerFields
            .map((f) => {
              const k = (f.providerField || f.key || '').trim();
              if (k === 'playerId') return 'player_id';
              if (k === 'zone_id') return 'server_id';
              return k;
            })
            .filter(Boolean);
        }
      }
    } catch (err) {
      log.warn('No se pudieron leer los playerFields de Firestore en dispatchFazerCall', { gameId: order.gameId, error: err });
    }
  }

  // 3. Respaldo de seguridad según los datos que envió el comprador si no se obtuvieron keys:
  if (expectedKeys.length === 0) {
    if (orderFields.server_id || orderFields.zone_id || orderFields.serverId || orderFields.zoneId || order.playerId2) {
      expectedKeys = ['player_id', 'server_id'];
    } else {
      expectedKeys = ['player_id'];
    }
  }

  // 4. Mapeamos lo que el cliente escribió en la tienda a cada key oficial de FazerCards
  const fields: Record<string, string> = {};
  for (let i = 0; i < expectedKeys.length; i++) {
    const key = expectedKeys[i];
    let val = '';

    if (key === 'player_id') {
      val =
        orderFields.player_id ||
        orderFields.playerId ||
        orderFields.userId ||
        orderFields.user_id ||
        orderFields.uid ||
        order.playerId ||
        '';
    } else if (key === 'server_id') {
      val =
        orderFields.server_id ||
        orderFields.zone_id ||
        orderFields.serverId ||
        orderFields.zoneId ||
        order.playerId2 ||
        '';
    } else if (key === 'user_id') {
      val =
        orderFields.user_id ||
        orderFields.userId ||
        orderFields.player_id ||
        orderFields.playerId ||
        orderFields.uid ||
        order.playerId ||
        '';
    } else if (key === 'server') {
      val =
        orderFields.server ||
        orderFields.serverId ||
        orderFields.server_id ||
        orderFields.zone_id ||
        orderFields.zoneId ||
        order.playerId2 ||
        '';
    } else if (key === 'uid') {
      val =
        orderFields.uid ||
        orderFields.playerId ||
        orderFields.player_id ||
        orderFields.userId ||
        orderFields.user_id ||
        order.playerId ||
        '';
    } else if (key === 'grow_id') {
      val =
        orderFields.grow_id ||
        orderFields.growId ||
        orderFields.playerId ||
        orderFields.player_id ||
        order.playerId ||
        '';
    } else if (key === 'account_id') {
      val =
        orderFields.account_id ||
        orderFields.accountId ||
        orderFields.playerId ||
        orderFields.player_id ||
        order.playerId ||
        '';
    } else if (key === 'bigo_id') {
      val =
        orderFields.bigo_id ||
        orderFields.bigoId ||
        orderFields.playerId ||
        orderFields.player_id ||
        order.playerId ||
        '';
    } else if (key === 'sid') {
      val =
        orderFields.sid ||
        orderFields.playerId ||
        orderFields.player_id ||
        order.playerId ||
        '';
    } else if (key === 'email') {
      val = orderFields.email || orderFields.correo || '';
    } else if (key === 'password') {
      val = orderFields.password || orderFields.pass || orderFields.contrasena || '';
    } else if (key === 'account') {
      val = orderFields.account || orderFields.character_name || order.playerId2 || '';
    } else if (key === 'character_name') {
      val = orderFields.character_name || orderFields.account || '';
    } else {
      val = orderFields[key] || '';
    }

    // Respaldo posicional si no coincidió por nombre:
    if (!val) {
      if (i === 0) {
        val = order.playerId || Object.values(orderFields)[0] || '';
      } else if (i === 1) {
        val = order.playerId2 || Object.values(orderFields)[1] || '';
      }
    }

    fields[key] = val.trim();
  }

  // Medida de seguridad adicional: NUNCA enviar 'zone_id', 'zoneId', 'playerId' ni 'serverId'
  delete fields.zone_id;
  delete fields.zoneId;
  delete fields.playerId;
  delete fields.serverId;

  return fazercards.createTopup({
    categoryId,
    offerId: call.packageId,
    fields,
    idempotencyKey,
  });
}

/**
 * Cierra una orden ya despachada: estado, correos, comisiones y avisos.
 *
 * Se extrajo porque el desenlace llega por dos caminos —el despacho en vivo y
 * la tarea que resuelve las que el proveedor dejó en curso— y duplicar esto
 * significaría que a una de las dos vías se le olvide pagar la comisión o
 * mandar el correo.
 */
export async function finalizeDispatch(
  order: Order,
  calls: DispatchCallResult[],
  allSucceeded: boolean,
  options: {
    failure?: string | null;
    actorUid?: string | null;
    anyProcessing?: boolean;
    allowRefundedOverride?: boolean;
    /**
     * Llamadas tal como se LEYERON antes de hablar con el proveedor. Con ellas
     * el cierre es compare-and-set por llamada (`mergeDispatchCalls`): si otra
     * petición cambió alguna mientras tanto, se conserva lo guardado y el
     * estado de la orden se recalcula con el resultado de la mezcla.
     */
    readCalls?: DispatchCallResult[];
  } = {}
): Promise<OrderStatus> {
  const orderId = order.id;
  const orderRef = orders().doc(orderId);

  const derive = (list: DispatchCallResult[], succeeded: boolean, anyProcessingHint?: boolean) => {
    const rawFailure = options.failure ?? list.find((call) => call.error)?.error ?? null;
    const failure = rawFailure ? sanitizeProviderError(rawFailure) : null;
    const anyProcessing = anyProcessingHint ?? list.some((c) => c.status === 'processing');
    const anySucceeded = list.some((c) => c.status === 'success');
    const esEntregaParcial = !succeeded && !anyProcessing && anySucceeded;
    const nextStatus: OrderStatus = succeeded ? 'completed' : anyProcessing ? 'dispatching' : 'in_review';
    const providerForEstado = list.find((c) => c.provider)?.provider ?? order.provider ?? 'inefable';
    const nextEstado = succeeded
      ? 'COMPLETADO'
      : anyProcessing
        ? (providerForEstado === 'centralone'
            ? 'DESPACHANDO_CENTRAL_ONE'
            : providerForEstado === 'fazercards'
              ? 'DESPACHANDO_FAZERCARDS'
              : 'DESPACHANDO_INEFABLE')
        : esEntregaParcial
          ? 'ENTREGA_PARCIAL_COMBO'
          : 'REVISION_MANUAL';
    const subOrdenes = list.map((c) => ({
      product_id: c.packageId,
      package_id: c.packageId,
      exito: c.status === 'success',
      order_id: c.providerOrderId ?? null,
      status: c.providerStatus ?? c.status,
      error: c.error ?? null,
      httpStatus: c.httpStatus ?? null,
      timestamp: new Date().toISOString(),
    }));
    return { failure, anyProcessing, esEntregaParcial, nextStatus, nextEstado, subOrdenes };
  };

  const originalCalls = calls;
  const originalAllSucceeded = allSucceeded;
  let derived = derive(calls, allSucceeded, options.anyProcessing);

  const txOutcome = await db.runTransaction(async (tx) => {
    // Una transacción puede repetirse: siempre se parte de lo que pidió quien llama.
    calls = originalCalls;
    allSucceeded = originalAllSucceeded;
    derived = derive(calls, allSucceeded, options.anyProcessing);

    const snap = await tx.get(orderRef);
    if (!snap.exists) return { kind: 'missing' as const };
    const current = { id: snap.id, ...snap.data() } as Order;
    const deliverySnap = await tx.get(orderDeliveryDoc(orderId));

    if (options.readCalls) {
      const merged = mergeDispatchCalls(options.readCalls, current.dispatch?.calls ?? [], originalCalls);
      if (merged.kept.length > 0) {
        log.warn('Otra petición cambió llamadas del despacho mientras se cerraba; se conserva lo guardado', {
          orderId,
          kept: merged.kept,
        });
        calls = merged.calls;
        allSucceeded = calls.every((call) => call.status === 'success');
        derived = derive(calls, allSucceeded);
      }
    }
    const { failure, nextStatus, nextEstado, subOrdenes } = derived;

    const isCancelledOrRefunded =
      current.status === 'cancelled' ||
      current.status === 'refunded' ||
      Boolean(current.refundedAt) ||
      current.pricing?.walletRefunded === true;

    if (isCancelledOrRefunded) {
      const canCompleteRefunded =
        allSucceeded &&
        (options.allowRefundedOverride || Boolean(options.actorUid) || current.status === 'dispatching');

      if (!canCompleteRefunded) {
        return { kind: 'already_cancelled' as const, current };
      }
    }

    if (current.status === 'completed') {
      return { kind: 'already_completed' as const, current };
    }

    if (!['paid', 'dispatching', 'in_review', 'failed'].includes(current.status)) {
      return { kind: 'unexpected_status' as const, current };
    }

    // Códigos de todas las llamadas: los de esta pasada, los guardados aparte
    // en pasadas anteriores y los de órdenes viejas que aún viven en la llamada.
    const savedCodes = storedCallCodes(deliverySnap.data());
    const legacyCodes = new Map(
      (current.dispatch?.calls ?? []).map((call) => [call.index, call.deliveredCodes ?? []])
    );
    const allCodes = calls.flatMap((call) =>
      call.deliveredCodes?.length
        ? call.deliveredCodes
        : savedCodes[String(call.index)]?.length
          ? savedCodes[String(call.index)]
          : legacyCodes.get(call.index) ?? []
    );

    const timestamp = now();
    const isWhatsappOrigin = current.origen === 'WHATSAPP' || current.canal === 'WHATSAPP';
    const updateData: Record<string, unknown> = {
      status: nextStatus,
      estado: nextEstado,
      subOrdenes,
      deliveredCodes: allSucceeded ? allCodes : current.deliveredCodes ?? order.deliveredCodes ?? [],
      updatedAt: timestamp,
    };

    if (nextStatus === 'in_review') {
      updateData.reviewDeadline = isWhatsappOrigin
        ? null
        : (current.reviewDeadline ?? minutesFromNow(60));
      updateData.providerError = failure ?? 'No se pudo completar el despacho automático.';
    } else if (nextStatus === 'completed') {
      updateData.reviewDeadline = null;
      updateData.providerError = null;
      updateData.metricsAccounted = true;
      const hadRefund = Boolean(current.pricing?.walletRefunded || current.refundedAt);
      if (hadRefund) {
        updateData.refundedAt = null;
        updateData.refundReason = null;
        updateData.pricing = {
          ...(current.pricing ?? order.pricing),
          walletRefunded: false,
        };
      }
    }

    writeCalls(tx, orderId, calls, (cleanCalls) => ({
      ...updateData,
      dispatch: {
        calls: cleanCalls,
        startedAt: current.dispatch?.startedAt ?? order.dispatch?.startedAt ?? timestamp,
        completedAt: allSucceeded ? timestamp : null,
        lastError: allSucceeded ? null : failure,
      },
    }));
    return { kind: 'updated' as const, current, status: nextStatus };
  });

  const { failure, anyProcessing, esEntregaParcial, nextStatus, nextEstado, subOrdenes } = derived;

  if (txOutcome.kind === 'missing') {
    return nextStatus;
  }

  if (txOutcome.kind === 'already_cancelled') {
    if (allSucceeded || calls.some((c) => c.status === 'success')) {
      log.error('entrega tardía en orden reembolsada: revisar manualmente', {
        orderId,
        code: txOutcome.current.code,
        status: txOutcome.current.status,
        refundedAt: txOutcome.current.refundedAt ?? null,
      });
      // Con Central One el cliente puede quedarse con la recarga Y el
      // reembolso: un log no lo ve nadie, el aviso sí.
      for (const call of calls) {
        if (call.status === 'success' && call.providerOrderId && (call.provider ?? order.provider) === 'centralone') {
          await alertCentralOneLateDelivery(
            { ...order, ...txOutcome.current, id: orderId } as Order,
            call.providerOrderId
          );
        }
      }
    } else {
      log.warn('Respuesta tardía de fallo del proveedor en orden ya cancelada (ignorada)', {
        orderId,
        code: txOutcome.current.code,
        status: txOutcome.current.status,
        error: failure,
      });
    }
    return txOutcome.current.status;
  }

  if (txOutcome.kind !== 'updated') {
    log.info('Despacho finalizado sin cambio de estado porque la orden ya cambió', {
      orderId,
      code: txOutcome.current.code,
      status: txOutcome.current.status,
    });
    return txOutcome.current.status;
  }

  const status = txOutcome.status;
  const isWhatsappGuest = Boolean(order.uid?.startsWith('whatsapp:'));
  const alreadyAccounted = txOutcome.current.metricsAccounted === true;

  // Aceptada y en curso: ni correo de entrega ni de fallo. La tarea programada
  // resolverá el estado real y disparará lo que corresponda.
  if (anyProcessing && !allSucceeded) {
    if (!isWhatsappGuest) {
      await notifications.notify({
        uid: order.uid,
        title: 'Tu recarga está en camino ⏳',
        body: `${describeOrder(order)}: el proveedor la está procesando. Te avisamos al terminar.`,
        type: 'order',
        link: `/orden/${orderId}`,
      });
    }

    return status;
  }

  if (allSucceeded) {
    void sendOrderEmail('delivered', orderId);

    // Una gift card no se acredita a ninguna cuenta: lo entregado es un código
    // que el cliente ve en el detalle de su orden.
    const entregaCodigos =
      order.providerFamily === 'gift_card' ||
      order.providerFamily === 'game_key' ||
      calls.some((call) => (call.deliveredCodes?.length ?? 0) > 0);

    await addEvent({
      orderId,
      type: 'completed',
      message: entregaCodigos
        ? '¡Código entregado! Lo encuentras en el detalle de tu orden.'
        : '¡Recarga entregada! Revisa tu cuenta del juego.',
      status: 'completed',
    });

    await Promise.all([
      !isWhatsappGuest
        ? notifications.notify({
            uid: order.uid,
            title: entregaCodigos ? '¡Tu código está listo! 🎁' : '¡Recarga entregada! 🎮',
            body: entregaCodigos
              ? `${describeOrder(order)}: tu código ya está en el detalle de la orden.`
              : `${describeOrder(order)} ya está en tu cuenta (ID ${order.playerId}).`,
            type: 'order',
            link: `/orden/${orderId}`,
          })
        : Promise.resolve(),
      !alreadyAccounted
        ? usersService.registerCompletedPurchase(order.uid, order.pricing.totalUsd)
        : Promise.resolve(),
      // No lanza: la recarga ya llegó al jugador y un fallo contable no puede
      // deshacerla. Deja rastro en el registro para conciliar.
      creatorsService.accrueCommission(order),
      !alreadyAccounted
        ? stats.trackEvent({ type: 'order_completed', order: { ...order, status } })
        : Promise.resolve(),
      audit.record({
        action: audit.ACTIONS.ORDER_DISPATCHED,
        actorUid: options.actorUid ?? null,
        targetType: 'order',
        targetId: orderId,
        summary: `Orden ${order.code} despachada correctamente.`,
        data: { calls: calls.length },
      }),
    ]);

    const hadWalletRefund = Boolean(
      txOutcome.current.pricing?.walletRefunded === true || txOutcome.current.refundedAt
    );

    if (hadWalletRefund && !isWhatsappGuest) {
      const amountToReverse = round(order.pricing?.totalUsd ?? 0, 2);
      if (amountToReverse > 0) {
        try {
          await usersService.moveWallet({
            uid: order.uid,
            deltaUsd: -amountToReverse,
            movementId: `reversal_refund_${orderId}`,
            reason: `Reversión por entrega tardía de la orden ${order.code}`,
            orderId,
            orderCode: order.code,
            actorUid: options.actorUid ?? null,
          });
          log.info('Reversión de saldo por entrega tardía completada exitosamente', {
            orderId,
            code: order.code,
            amountUsd: amountToReverse,
          });
          await addEvent({
            orderId,
            type: 'in_review',
            message: `Reversión automática de saldo (${amountToReverse.toFixed(2)}) aplicada por entrega tardía del proveedor.`,
            actor: 'system',
            status: 'completed',
          });
        } catch (err) {
          log.error('ALERTA CRÍTICA: Entrega tardía completada pero saldo insuficiente en billetera para revertir reembolso', {
            orderId,
            code: order.code,
            uid: order.uid,
            amountUsd: amountToReverse,
            error: err instanceof Error ? err.message : String(err),
          });
          await audit.record({
            action: audit.ACTIONS.ORDER_DISPATCHED,
            actorUid: options.actorUid ?? null,
            targetType: 'order',
            targetId: orderId,
            summary: `CRÍTICO: Orden tardía ${order.code} entregada pero el cliente no tenía saldo suficiente (${amountToReverse.toFixed(2)}) para revertir el reembolso.`,
            data: { amountUsd: amountToReverse, error: err instanceof Error ? err.message : String(err) },
          });
          await addEvent({
            orderId,
            type: 'in_review',
            message: `⚠️ ALERTA CRÍTICA: La recarga fue entregada por el proveedor pero el cliente ya consumió el reembolso previo de ${amountToReverse.toFixed(2)}. Saldo insuficiente para debitar.`,
            actor: 'system',
            status: 'completed',
          });
        }
      }
    }
  } else {
    void sendOrderEmail('dispatch_failed', orderId);

    await addEvent({
      orderId,
      type: 'dispatch_failed',
      message: REVIEW_CUSTOMER_MESSAGE,
      status: 'in_review',
    });

    const providerUpper = (order.provider ?? 'inefable').toUpperCase();
    const entregados = calls.filter((c) => c.status === 'success');
    const fallidos = calls.filter((c) => c.status !== 'success');
    const entregadosTxt =
      entregados.length > 0
        ? entregados
            .map((c) => `package_id ${c.packageId} (order #${c.providerOrderId ?? 'OK'})`)
            .join(', ')
        : 'Ninguno';
    const fallidosTxt = fallidos
      .map((c) => `package_id ${c.packageId} (${c.error ?? c.providerStatus ?? 'error'})`)
      .join(', ');
    const pabiloRef = order.payment?.reference ?? order.referencia ?? null;
    const montoBsPagado = round(
      order.payment?.paidBs && order.payment.paidBs > 0
        ? order.payment.paidBs
        : (order.pricing?.totalBs ?? 0),
      2
    );

    await Promise.all([
      !isWhatsappGuest
        ? notifications.notify({
            uid: order.uid,
            title: 'Orden en revisión manual ⏳',
            body: REVIEW_CUSTOMER_MESSAGE,
            type: 'order',
            link: `/orden/${orderId}`,
          })
        : Promise.resolve(),
      stats.trackEvent({ type: 'order_failed', order: { ...order, status } }),
      audit.record({
        action: audit.ACTIONS.ORDER_DISPATCH_FAILED,
        actorUid: options.actorUid ?? null,
        targetType: 'order',
        targetId: orderId,
        summary: `Falló el despacho de la orden ${order.code}. Pasó a revisión manual.`,
        data: { error: failure, subOrdenes },
      }),
      // El cliente ya pagó: esto necesita a una persona ya, no cuando alguien
      // se acuerde de abrir el panel.
      adminAlerts.alert({
        kind: 'dispatch_failed',
        severity: 'critical',
        title: `⚠️ RECARGA PASADA A MANUAL (FALLO API ${providerUpper}) · ${order.code}`,
        body: [
          `⚠️ RECARGA PASADA A MANUAL (FALLO API ${providerUpper})`,
          esEntregaParcial ? '🔴 ATENCIÓN: ENTREGA PARCIAL EN COMBO' : null,
          `🎮 Juego: ${order.gameName}`,
          `💎 Paquete: ${describeOrder(order)}`,
          `🆔 Player ID: ${order.playerId}`,
          `✅ Entregados: ${entregadosTxt}`,
          `❌ Fallidos: ${fallidosTxt || 'Todos'}`,
          pabiloRef
            ? `🧾 Ref Pabilo: ${pabiloRef} (✅ Pago ya verificado en BDV)`
            : `💳 Método: ${order.payment?.method ?? 'wallet'}`,
          `💰 Monto en Bs: ${montoBsPagado.toFixed(2)} Bs`,
          `⚙️ Motivo técnico: ${failure ?? 'sin detalle del proveedor'}.`,
        ]
          .filter(Boolean)
          .join('\n'),
        link: `/admin/ordenes/${orderId}`,
        data: {
          code: order.code,
          playerId: order.playerId,
          referencia: pabiloRef,
          montoBs: montoBsPagado,
          estado: nextEstado,
          error: failure,
          customer: order.user.email,
        },
      }),
    ]);

    log.error('Despacho en revisión manual', { orderId, code: order.code, error: failure });
  }

  return status;
}

/** Tras este tiempo sin resolverse, el equipo debe mirarlo. */
const PROCESSING_ALERT_MINUTES = 20;
/** Y tras éste se da por perdida: el proveedor ya no la va a cerrar solo. */
const PROCESSING_GIVE_UP_MINUTES = 120;

/**
 * Resuelve las órdenes que el proveedor aceptó pero aún no había terminado.
 *
 * El proveedor responde HTTP 202 y cierra la recarga minutos después; el estado
 * real sólo se sabe preguntándole. Se consulta por `external_order_id`, que es
 * el mismo que se envió al despachar, así que la consulta funciona aunque no
 * haya devuelto `order_id` (pasó: una de las dos órdenes afectadas no lo trajo).
 */
/**
 * Resuelve la orden a la que pertenece un `external_order_id`.
 *
 * Es el camino del webhook: el proveedor avisa citando su identificador, que
 * es el que nosotros mismos le mandamos al despachar (`RF-XXXXXX-1`), así que
 * la orden se localiza por su código sin buscar en toda la colección.
 */
export async function resolveProcessingOrder(externalOrderId: string): Promise<string> {
  // `RF-8K3M2Q-1` -> código `RF-8K3M2Q`. El sufijo es el número de llamada.
  const code = externalOrderId.replace(/-\d+$/, '').trim();
  if (!code) return 'identificador ilegible';

  const snap = await orders().where('code', '==', code).limit(1).get();
  if (snap.empty) return 'orden no encontrada';

  const order = { id: snap.docs[0].id, ...snap.docs[0].data() } as Order;
  if (
    order.status === 'cancelled' ||
    order.status === 'refunded' ||
    Boolean(order.refundedAt) ||
    order.pricing?.walletRefunded === true
  ) {
    log.error('entrega tardía en orden reembolsada: revisar manualmente', {
      orderId: order.id,
      code: order.code,
      status: order.status,
      externalOrderId,
    });
    return `la orden está en ${order.status}`;
  }
  if (!['dispatching', 'in_review'].includes(order.status)) {
    return `la orden está en ${order.status}`;
  }

  const resuelta = await resolveOne(order);
  return resuelta ? 'resuelta' : 'sigue en curso';
}

/** Resuelve un aviso de FazerCards, que cita el id interno de su pedido. */
export async function resolveFazerProcessingOrder(providerOrderId: string): Promise<string> {
  const index = await providerOrders().doc(providerOrderIndexId('fazercards', providerOrderId)).get();
  const orderId = index.data()?.orderId as string | undefined;
  if (!orderId) return 'orden no encontrada';
  const snap = await orders().doc(orderId).get();
  if (!snap.exists) return 'orden no encontrada';
  const order = { id: snap.id, ...snap.data() } as Order;
  if (
    order.status === 'cancelled' ||
    order.status === 'refunded' ||
    Boolean(order.refundedAt) ||
    order.pricing?.walletRefunded === true
  ) {
    log.error('entrega tardía en orden reembolsada: revisar manualmente', {
      orderId: order.id,
      code: order.code,
      status: order.status,
      providerOrderId,
    });
    return `la orden está en ${order.status}`;
  }
  if (!['dispatching', 'in_review'].includes(order.status)) {
    return `la orden está en ${order.status}`;
  }
  return (await resolveOne(order)) ? 'resuelta' : 'sigue en curso';
}

/**
 * Avisa al equipo de un pedido de Central One entregado cuando la orden ya no
 * lo esperaba (reemplazado por otro tras rotar la llave, o la orden ya está
 * completada o reembolsada). Nunca cambia la orden ni cobra nada: decidir si
 * se reclama a Central One o al cliente es de una persona. Un aviso por pedido
 * (se anota en la orden).
 */
async function alertCentralOneLateDelivery(order: Order, providerOrderId: string): Promise<void> {
  const ref = orders().doc(order.id);
  const first = await db
    .runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const seen = (snap.data()?.centralOneLateDeliveries ?? []) as string[];
      if (seen.includes(providerOrderId)) return false;
      tx.set(ref, { centralOneLateDeliveries: [...seen, providerOrderId] }, { merge: true });
      return true;
    })
    .catch(() => true);
  if (!first) return;

  const refunded =
    order.status === 'refunded' ||
    order.status === 'cancelled' ||
    Boolean(order.refundedAt) ||
    order.pricing?.walletRefunded === true;
  const title = refunded
    ? `Entrega tardía de Central One · ${order.code}`
    : order.status === 'completed'
      ? `Central One cobró dos veces · ${order.code}`
      : `Entrega tardía de Central One · ${order.code}`;
  const body = refunded
    ? `Central One entregó el pedido ${providerOrderId} de la orden ${order.code}, que ya está ${order.status} (reembolsada). El cliente tiene la recarga y el reembolso: revísalo.`
    : order.status === 'completed'
      ? `Central One entregó el pedido ${providerOrderId} de la orden ${order.code}, que ya se completó con otro pedido. Reclama el duplicado en el portal de Central One; al cliente no se le cobra nada.`
      : `Central One entregó el pedido ${providerOrderId} de la orden ${order.code} después de reintentarla con otra llave. Revisa en su portal si se cobró dos veces antes de reintentar o reembolsar.`;
  log.error('Entrega tardía de Central One', {
    orderId: order.id,
    code: order.code,
    status: order.status,
    providerOrderId,
  });
  await adminAlerts.alert({
    kind: 'dispatch_failed',
    severity: 'critical',
    title,
    body,
    link: `/admin/ordenes/${order.id}`,
    data: { code: order.code, providerOrderId, status: order.status },
  });
}

/**
 * Consulta un pedido de Central One que la orden ya no espera y, si se
 * entregó, avisa. Devuelve el resultado para la respuesta del webhook, o
 * `null` si no hubo entrega (o no se pudo confirmar).
 */
async function checkCentralOneLateDelivery(order: Order, providerOrderId: string): Promise<string | null> {
  const detail = await centralOne.getOrder(providerOrderId).catch(() => null);
  if (!detail || !detail.found || !detail.isSuccess) return null;
  await alertCentralOneLateDelivery(order, providerOrderId);
  return 'entrega tardía avisada';
}

/**
 * Para una llamada que se daría por fallida o no registrada: ¿algún pedido
 * de una llave anterior sigue abierto, se entregó o no se pudo consultar?
 * Devuelve el motivo para dejarla incierta (nunca se reembolsa sola) o `null`.
 */
async function supersededCentralOneOrdersBlock(order: Order, call: CentralOneCallState): Promise<string | null> {
  for (const previousId of call.previousProviderOrderIds ?? []) {
    const detail = await centralOne.getOrder(previousId).catch(() => null);
    if (!detail || !detail.found) {
      return `No se pudo consultar el pedido anterior ${previousId} en Central One; no se reembolsa hasta confirmarlo.`;
    }
    if (detail.isSuccess) {
      await alertCentralOneLateDelivery(order, previousId);
      return `Central One entregó el pedido anterior ${previousId} de esta recarga: no se reembolsa. Revisa su portal.`;
    }
    if (!detail.isFailed) {
      return `El pedido anterior ${previousId} sigue abierto en Central One; no se reembolsa hasta que cierre.`;
    }
  }
  return null;
}

/**
 * Resuelve un aviso del webhook de Central One.
 *
 * El aviso sólo dispara la consulta: la orden se localiza por el índice
 * `providerOrders` (id del pedido de Central One) o, si el POST nunca llegó a
 * responder y no hay índice, por el código de la orden que va en la
 * `idempotency_key`. El estado real siempre sale de `GET /orders/{id}` dentro
 * de `resolveOne`, nunca del cuerpo del aviso.
 *
 * Si la llamada aún no tiene id de pedido (el POST fue ambiguo) y el aviso
 * cita la MISMA llave de esa llamada, se adopta el id que trae: la ruta ya
 * verificó la firma y, aun así, sólo sirve para preguntarle a Central One.
 */
export async function resolveCentralOneWebhookOrder(input: {
  providerOrderId?: string | null;
  idempotencyKey?: string | null;
}): Promise<{ matched: boolean; orderId?: string; result?: string }> {
  const providerOrderId = input.providerOrderId?.trim() || null;
  const idempotencyKey = input.idempotencyKey?.trim() || null;

  let orderId: string | null = null;
  if (providerOrderId) {
    const index = await providerOrders()
      .doc(providerOrderIndexId('centralone', providerOrderId))
      .get();
    orderId = (index.data()?.orderId as string | undefined) ?? null;
  }
  if (!orderId && idempotencyKey) {
    const code = centralOne.orderCodeFromIdempotencyKey(idempotencyKey);
    if (code) {
      const snap = await orders().where('code', '==', code).limit(1).get();
      if (!snap.empty) orderId = snap.docs[0].id;
    }
  }
  if (!orderId) return { matched: false, result: 'orden no encontrada' };

  const snap = await orders().doc(orderId).get();
  if (!snap.exists) return { matched: false, result: 'orden no encontrada' };
  let order = { id: snap.id, ...snap.data() } as Order;

  const refunded =
    order.status === 'cancelled' ||
    order.status === 'refunded' ||
    Boolean(order.refundedAt) ||
    order.pricing?.walletRefunded === true;
  const open = !refunded && ['dispatching', 'in_review'].includes(order.status);

  // ¿El aviso habla de un pedido que la orden espera? El id actual de alguna
  // llamada, o uno que se va a adoptar (POST ambiguo, misma llave). Cualquier
  // otro —una llave ya rotada, o una orden ya cerrada— se consulta: si se
  // entregó, es un doble cobro o una entrega sobre un reembolso y se avisa en
  // vez de callarlo.
  if (providerOrderId) {
    const calls = (order.dispatch?.calls ?? []) as CentralOneCallState[];
    const current = calls.find((call) => call.providerOrderId === providerOrderId);
    const adoptable =
      Boolean(idempotencyKey) &&
      calls.some(
        (call) =>
          (call.provider ?? order.provider) === 'centralone' &&
          !call.providerOrderId &&
          (call.idempotencyKey || centralOneBaseKey(order.code, call.index)) === idempotencyKey
      );
    const expected =
      (open && (current || adoptable)) || (order.status === 'completed' && !refunded && current?.status === 'success');
    if (!expected) {
      const late = await checkCentralOneLateDelivery(order, providerOrderId);
      if (!open) return { matched: true, orderId, result: late ?? `la orden está en ${order.status}` };
    }
  }

  if (refunded) {
    log.error('entrega tardía en orden reembolsada: revisar manualmente', {
      orderId: order.id,
      code: order.code,
      status: order.status,
      providerOrderId,
    });
    return { matched: true, orderId, result: `la orden está en ${order.status}` };
  }
  if (!open) {
    return { matched: true, orderId, result: `la orden está en ${order.status}` };
  }

  if (providerOrderId && idempotencyKey) {
    const adopted = await adoptCentralOneOrderId(order, providerOrderId, idempotencyKey);
    if (adopted) order = adopted;
  }

  const resuelta = await resolveOne(order);
  return { matched: true, orderId, result: resuelta ? 'resuelta' : 'sigue en curso' };
}

/**
 * Pone el id de pedido de un aviso en la llamada que lo esperaba (POST ambiguo,
 * sin id). Sólo si la llave del aviso es exactamente la llave actual de esa
 * llamada: un aviso de una llave ya rotada habla de un pedido anterior.
 * Devuelve la orden actualizada, o `null` si no había nada que adoptar.
 */
async function adoptCentralOneOrderId(
  order: Order,
  providerOrderId: string,
  idempotencyKey: string
): Promise<Order | null> {
  const ref = orders().doc(order.id);
  const updated = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = { id: snap.id, ...snap.data() } as Order;
    if (!['dispatching', 'in_review'].includes(current.status)) return null;

    const calls = (current.dispatch?.calls ?? []).map((call) => ({ ...call })) as CentralOneCallState[];
    const target = calls.find(
      (call) =>
        (call.provider ?? current.provider) === 'centralone' &&
        !call.providerOrderId &&
        (call.status === 'processing' || call.status === 'error') &&
        (call.idempotencyKey || centralOneBaseKey(current.code, call.index)) === idempotencyKey
    );
    if (!target) return null;

    target.providerOrderId = providerOrderId;
    // Con id ya no hay que repetir el POST: se consulta el pedido.
    if (target.status === 'error') target.status = 'processing';
    target.error = null;
    target.pendingReason = 'Central One avisó del pedido; se confirma con su API.';
    tx.set(ref, { dispatch: { ...current.dispatch, calls }, updatedAt: now() }, { merge: true });
    return { ...current, dispatch: { ...current.dispatch, calls } } as Order;
  });

  if (updated) {
    const call = updated.dispatch.calls.find((item) => item.providerOrderId === providerOrderId);
    await indexProviderOrder('centralone', providerOrderId, order.id, call?.index ?? 0);
    log.info('Pedido de Central One adoptado desde el webhook', {
      orderId: order.id,
      providerOrderId,
      idempotencyKey,
    });
  }
  return updated;
}

/**
 * Consulta y, si hace falta, reintenta UNA llamada de Central One del cron.
 *
 * Con id de pedido: `GET /orders/{id}` decide (y los códigos, si es gift
 * card). Sin id y en curso: el POST anterior fue ambiguo o se pausó por saldo,
 * así que se repite con la MISMA llave —nunca otra—. Devuelve `true` si la
 * llamada cambió y hay que guardarla.
 */
async function resolveCentralOneCall(order: Order, call: DispatchCallResult): Promise<boolean> {
  const state = call as CentralOneCallState;

  if (!call.providerOrderId) {
    // En revisión no se compra nada: sólo se repite lo que sigue en curso.
    if (call.status !== 'processing') return false;
    return retryCentralOneCall(order, state);
  }

  const detail = await centralOne.getOrder(call.providerOrderId).catch(() => null);
  // Sin llave, red caída o 404: no se decide nada; se vuelve a consultar.
  if (!detail || !detail.found) return false;

  if (detail.isSuccess) {
    const codes = await readCentralOneCodes(order, call, call.providerOrderId, detail.deliveredCount);
    if (!codes.ok) {
      // Entregada sin códigos legibles: sigue esperando. Una que ya está en
      // revisión se queda ahí (la consulta de reembolso la reporta incierta).
      if (call.status !== 'processing' || state.errorCode === 'codes_pending') return false;
      call.providerStatus = detail.lineStatus || detail.orderStatus;
      state.errorCode = 'codes_pending';
      state.pendingReason = codes.message;
      return true;
    }
    if (codes.codes.length) call.deliveredCodes = codes.codes;
    call.status = 'success';
    call.error = null;
    call.completedAt = now();
    call.providerStatus = detail.lineStatus || detail.orderStatus;
    call.providerReference = detail.referenceCode ?? call.providerReference;
    call.providerResponse = detail.raw;
    state.errorCode = null;
    state.pendingReason = null;
    return true;
  }

  if (detail.isFailed && call.status === 'processing') {
    call.status = 'error';
    call.error = sanitizeProviderError(
      detail.failureMessage || `El proveedor marcó la recarga como ${detail.lineStatus}.`
    );
    call.providerStatus = detail.lineStatus || detail.orderStatus;
    call.providerResponse = detail.raw;
    state.keyClosed = true;
    state.errorCode = detail.failureCode ?? 'failed';
    state.pendingReason = null;
    return true;
  }

  // Sigue en curso: no se toca.
  return false;
}

/**
 * Repite el POST de una llamada de Central One en curso sin id de pedido.
 *
 * Siempre con la misma llave: si el pedido entró, Central One lo devuelve sin
 * cobrar otra vez. Tras 3 POST ambiguos con esa llave se deja de intentar y
 * pasa a revisión con un mensaje que impide reembolsarla a ciegas. La pausa
 * por saldo no gasta esos intentos: se reintenta cada pasada hasta 24 h.
 */
async function retryCentralOneCall(order: Order, state: CentralOneCallState): Promise<boolean> {
  const key = state.idempotencyKey || centralOneBaseKey(order.code, state.index);

  if (state.errorCode === 'insufficient_balance') {
    const since = millisOf(state.balanceBlockedAt);
    if (since !== null && Date.now() - since >= CENTRAL_ONE_BALANCE_GIVE_UP_MS) {
      state.status = 'error';
      state.error = 'Central One siguió sin saldo durante 24 horas; la recarga no se compró.';
      state.pendingReason = null;
      return true;
    }
  } else if ((state.keyAttempts ?? 0) >= CENTRAL_ONE_MAX_POSTS_PER_KEY) {
    state.status = 'error';
    state.error = centralOneUncertainMessage(key);
    state.errorCode = 'ambiguous_unresolved';
    state.pendingReason = null;
    return true;
  }

  state.attempts += 1;
  const result = await dispatchCentralOneCall(order, state, { isRetry: true });

  state.providerOrderId = result.providerOrderId;
  state.providerStatus = result.providerStatus;
  state.providerReference = result.providerReference ?? state.providerReference;
  state.playerName = result.playerName ?? state.playerName;
  state.httpStatus = result.httpStatus;
  state.providerResponse = stripCodes(result.raw);
  if (result.providerOrderId) {
    await indexProviderOrder('centralone', result.providerOrderId, order.id, state.index);
  }

  if (result.success) {
    if (result.codes?.length) state.deliveredCodes = result.codes;
    state.status = 'success';
    state.error = null;
    state.completedAt = now();
  } else if (result.processing) {
    state.status = 'processing';
    state.error = null;
  } else {
    state.status = 'error';
    state.error = sanitizeProviderError(result.message, result.httpStatus);
  }

  await addEvent({
    orderId: order.id,
    type: result.success ? 'dispatch_call_ok' : result.processing ? 'dispatch_call_processing' : 'dispatch_call_error',
    message: result.success
      ? `Recarga ${state.index + 1} confirmada en Central One con la misma llave.`
      : `Recarga ${state.index + 1}: ${result.processing ? result.message ?? 'sigue en curso.' : state.error}`,
    data: {
      packageId: state.packageId,
      providerOrderId: result.providerOrderId,
      idempotencyKey: state.idempotencyKey ?? null,
      keyAttempts: state.keyAttempts ?? null,
    },
  });
  return true;
}

/** Llamada en pausa por falta de saldo (tiene su propio plazo y su propio aviso). */
function isBalancePaused(call: DispatchCallResult): boolean {
  return call.status === 'processing' && (call as CentralOneCallState).errorCode === 'insufficient_balance';
}

/**
 * Consulta y cierra UNA orden con llamadas en curso.
 *
 * Devuelve `true` si quedó resuelta (entregada o fallida). El estado siempre
 * sale de la API autenticada del proveedor, nunca de lo que llegue por fuera.
 */
async function resolveOne(order: Order): Promise<boolean> {
  const calls = (order.dispatch?.calls ?? []).map((call) => ({ ...call }));
  const canCheckCall = (call: DispatchCallResult) =>
    call.status === 'processing' || (order.status === 'in_review' && call.status === 'error');
  if (!calls.some(canCheckCall)) return false;

  const inicio = order.dispatch?.startedAt as { toMillis?: () => number } | null;
  const iniciadaMs =
    inicio && typeof inicio.toMillis === 'function' ? inicio.toMillis() : Date.now();
  const minutos = (Date.now() - iniciadaMs) / 60_000;
  let cambio = false;
  // Una llamada que sale de la pausa por saldo empieza de nuevo su plazo: sin
  // esto, una orden que esperó saldo 3 h se daba por perdida en la primera
  // pasada en que Central One aún la estuviera procesando.
  let reanudada = false;

  for (const call of calls) {
    if (!canCheckCall(call)) continue;

    const provider = call.provider ?? order.provider ?? 'inefable';
    if (provider === 'centralone') {
      // Central One tiene su propio camino: misma llave, pausa por saldo y
      // códigos de gift cards.
      const estabaEnPausa = isBalancePaused(call);
      if (await resolveCentralOneCall(order, call)) cambio = true;
      if (estabaEnPausa && !isBalancePaused(call)) reanudada = true;
      continue;
    }

    const externalOrderId = `${order.code}-${call.index + 1}`;
    const fazerResult =
      provider === 'fazercards' && call.providerOrderId
        ? await fazercards.getOrder(call.providerOrderId).catch(() => null)
        : null;
    const inefableResult =
      provider === 'inefable' ? await inefable.getOrderStatus(externalOrderId).catch(() => null) : null;
    if (!fazerResult && !inefableResult) continue;
    if (inefableResult && !inefableResult.found) continue;

    const providerStatus = fazerResult?.providerStatus ?? inefableResult?.status ?? null;
    const normalizado = (providerStatus ?? '').toLowerCase();
    const requiresCode = order.providerFamily === 'gift_card' || order.providerFamily === 'game_key';
    const success = fazerResult
      ? fazerResult.success && (!requiresCode || Boolean(fazerResult.codes?.length))
      : inefable.isSuccessStatus(normalizado);
    const failed = fazerResult
      ? !fazerResult.success && !fazerResult.processing
      : inefable.isFailureStatus(normalizado);
    if (success) {
      if (fazerResult?.codes?.length) call.deliveredCodes = fazerResult.codes;
      call.status = 'success';
      call.error = null;
      call.completedAt = now();
      call.providerStatus = providerStatus;
      call.providerOrderId = fazerResult?.providerOrderId ?? inefableResult?.providerOrderId ?? call.providerOrderId;
      call.providerReference = fazerResult?.providerReference ?? inefableResult?.providerReference ?? call.providerReference;
      cambio = true;
    } else if (failed && call.status === 'processing') {
      call.status = 'error';
      call.error = sanitizeProviderError(
        inefableResult?.error ||
          fazerResult?.message ||
          `El proveedor marcó la recarga como ${providerStatus}.`
      );
      call.providerStatus = providerStatus;
      cambio = true;
    }
    // Sigue en curso: no se toca.
  }

  const pendientes = calls.some((call) => call.status === 'processing');

  // Lo que se leyó antes de consultar al proveedor: las escrituras de abajo
  // son compare-and-set contra esto (ver `mergeDispatchCalls`).
  const leidas = order.dispatch?.calls ?? [];

  if (cambio && !pendientes) {
    // Se reutiliza el cierre normal del despacho para no duplicar la lógica de
    // correos, comisiones, estadísticas y avisos.
    await finalizeDispatch(order, calls, calls.every((call) => call.status === 'success'), { readCalls: leidas });
    return true;
  }

  if (cambio) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(orders().doc(order.id));
      if (!snap.exists) return;
      const current = snap.data() as Order;
      if (!['dispatching', 'in_review'].includes(current.status)) return;
      const merged = mergeDispatchCalls(leidas, current.dispatch?.calls ?? [], calls);
      if (merged.kept.length > 0) {
        log.warn('Otra petición cambió llamadas mientras el cron consultaba; se conserva lo guardado', {
          orderId: order.id,
          kept: merged.kept,
        });
      }
      writeCalls(tx, order.id, merged.calls, (cleanCalls) => ({
        dispatch: { ...current.dispatch, calls: cleanCalls, ...(reanudada ? { startedAt: now() } : {}) },
        updatedAt: now(),
      }));
    });
    return false;
  }

  // Una pausa por saldo tiene su propio plazo (24 h) y su propio aviso
  // (uno por hora): ni se da por perdida a las 2 h ni se avisa cada pasada.
  if (calls.some(isBalancePaused)) return false;

  // Sin novedad. Si lleva demasiado se avisa, y pasado el tope se cierra como
  // en revisión para que el equipo pueda atenderla a mano.
  if (order.status === 'dispatching' && minutos >= PROCESSING_GIVE_UP_MINUTES) {
    for (const call of calls) {
      if (call.status === 'processing') {
        call.status = 'error';
        call.error = `El proveedor no resolvió la recarga en ${PROCESSING_GIVE_UP_MINUTES} minutos.`;
      }
    }
    await finalizeDispatch(order, calls, false, { readCalls: leidas });
    return true;
  }

  if (order.status === 'dispatching' && minutos >= PROCESSING_ALERT_MINUTES) {
    await adminAlerts.alert({
      kind: 'dispatch_failed',
      severity: 'warning',
      title: `Recarga en curso hace ${Math.floor(minutos)} min · ${order.code}`,
      body: [
        `${describeOrder(order)} (${order.gameName}) para ${order.playerId}.`,
        'El proveedor la aceptó pero todavía no la cierra. Revísala en su panel.',
      ].join('\n'),
      link: `/admin/ordenes/${order.id}`,
      data: { code: order.code, minutos: Math.floor(minutos) },
    });
  }

  return false;
}

/**
 * Red de seguridad del webhook: repasa las que quedaron en curso.
 *
 * El aviso del proveedor es el camino rápido, pero un webhook se puede perder
 * (un despliegue a medias, un corte de red). Esto lo cubre.
 */
export async function resolveProcessingOrders(): Promise<{
  revisadas: number;
  resueltas: number;
}> {
  const snap = await orders().where('status', '==', 'dispatching').limit(50).get();
  let revisadas = 0;
  let resueltas = 0;

  for (const doc of snap.docs) {
    const order = { id: doc.id, ...doc.data() } as Order;
    if (!(order.dispatch?.calls ?? []).some((call) => call.status === 'processing')) continue;

    revisadas += 1;
    if (await resolveOne(order)) resueltas += 1;
  }

  return { revisadas, resueltas };
}


export interface CallProviderCheck {
  index: number;
  packageId: number | string;
  provider: 'inefable' | 'fazercards' | 'centralone';
  providerOrderId: string | null;
  found: boolean;
  status: 'completed' | 'processing' | 'failed' | 'not_found' | 'unknown';
  rawStatus: string | null;
  message: string;
}

export interface CheckProviderStatusResult {
  ok: boolean;
  orderId: string;
  orderCode: string;
  orderStatus: OrderStatus;
  orderEstado: string | null;
  calls: CallProviderCheck[];
  summary: string;
  continuedDispatch: boolean;
}

/**
 * Consulta manual en tiempo real del estado de cada llamada en la API del proveedor.
 *
 * Se apoya en el circuito existente de reconciliación (`finalizeDispatch` / `dispatchOrder`)
 * para ejecutar exactamente los mismos efectos secundarios si la orden se completa o continúa.
 */
export async function checkOrderProviderStatus(
  orderId: string,
  actorUid?: string
): Promise<CheckProviderStatusResult> {
  const orderRef = orders().doc(orderId);
  const snap = await orderRef.get();
  if (!snap.exists) {
    throw notFound('Orden no encontrada.');
  }

  let order = { id: snap.id, ...snap.data() } as Order;
  const calls = (order.dispatch?.calls ?? []).map((c) => ({ ...c }));

  if (calls.length === 0) {
    return {
      ok: false,
      orderId: order.id,
      orderCode: order.code,
      orderStatus: order.status,
      orderEstado: order.estado ?? null,
      calls: [],
      summary: 'Esta orden no tiene llamadas automáticas configuradas.',
      continuedDispatch: false,
    };
  }

  const checks: CallProviderCheck[] = [];
  let callChanged = false;

  for (const call of calls) {
    const provider = call.provider ?? order.provider ?? 'inefable';
    const externalOrderId = `${order.code}-${call.index + 1}`;

    if (call.status === 'success') {
      checks.push({
        index: call.index,
        packageId: call.packageId,
        provider,
        providerOrderId: call.providerOrderId,
        found: true,
        status: 'completed',
        rawStatus: call.providerStatus ?? 'completada',
        message: `Completada y confirmada en el sistema (Orden #${call.providerOrderId ?? 'N/A'}).`,
      });
      continue;
    }

    if (provider === 'inefable') {
      const inefableResult = await inefable.getOrderStatus(externalOrderId).catch(() => null);

      if (!inefableResult || !inefableResult.found) {
        if (call.status === 'processing') {
          call.status = 'error';
          call.error = 'No registrada en el proveedor (la llamada nunca llegó a procesarse).';
          callChanged = true;
        }
        checks.push({
          index: call.index,
          packageId: call.packageId,
          provider: 'inefable',
          providerOrderId: null,
          found: false,
          status: 'not_found',
          rawStatus: null,
          message: '⚪ No registrada en el proveedor: La llamada nunca llegó a procesarse en Inefable. Es 100% seguro usar el botón de Reintentar.',
        });
      } else {
        const raw = (inefableResult.status ?? '').toLowerCase();
        const pOrderId = inefableResult.providerOrderId ?? call.providerOrderId;
        const pRef = inefableResult.providerReference ?? call.providerReference;

        if (inefable.isSuccessStatus(raw)) {
          call.status = 'success';
          call.error = null;
          call.completedAt = now();
          call.providerOrderId = pOrderId;
          call.providerReference = pRef;
          call.providerStatus = inefableResult.status;
          call.httpStatus = 200;
          callChanged = true;

          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'inefable',
            providerOrderId: pOrderId,
            found: true,
            status: 'completed',
            rawStatus: inefableResult.status,
            message: `Completada en Inefable (Orden #${pOrderId ?? 'N/A'}).`,
          });
        } else if (inefable.isPendingStatus(raw)) {
          if (call.status !== 'processing') {
            call.status = 'processing';
            call.providerOrderId = pOrderId;
            call.providerReference = pRef;
            call.providerStatus = inefableResult.status;
            callChanged = true;
          }
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'inefable',
            providerOrderId: pOrderId,
            found: true,
            status: 'processing',
            rawStatus: inefableResult.status,
            message: `En proceso en Inefable (Orden #${pOrderId ?? 'N/A'}). Sigue en cola del proveedor.`,
          });
        } else if (inefable.isFailureStatus(raw)) {
          if (call.status === 'processing') {
            call.status = 'error';
            call.error = sanitizeProviderError(
              inefableResult.error || `El proveedor marcó la recarga como ${inefableResult.status}.`
            );
            call.providerOrderId = pOrderId;
            call.providerStatus = inefableResult.status;
            callChanged = true;
          }
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'inefable',
            providerOrderId: pOrderId,
            found: true,
            status: 'failed',
            rawStatus: inefableResult.status,
            message: sanitizeProviderError(inefableResult.error || `Marcada como ${inefableResult.status} por Inefable.`),
          });
        } else {
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'inefable',
            providerOrderId: pOrderId,
            found: true,
            status: 'unknown',
            rawStatus: inefableResult.status,
            message: `Estado no reconocido en Inefable: ${inefableResult.status}`,
          });
        }
      }
    } else if (provider === 'centralone') {
      const state = call as CentralOneCallState;
      const key = state.idempotencyKey || centralOneBaseKey(order.code, call.index);

      if (!call.providerOrderId) {
        // Sin id no hay a quién preguntar: decide lo que se sabe de la llamada.
        // Un POST ambiguo pudo crear el pedido, así que nunca es «no registrada»
        // (eso habilitaría el reembolso automático de algo quizá entregado).
        if (call.status === 'processing') {
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: null,
            found: false,
            status: 'processing',
            rawStatus: state.errorCode ?? call.providerStatus ?? null,
            message:
              state.errorCode === 'insufficient_balance'
                ? 'En pausa: Central One no tiene saldo. Se reintenta sola con la misma llave al recargar.'
                : `Central One no confirmó si el pedido entró; se confirma con la misma llave (${key}) sin comprar otro.`,
          });
        } else if (centralOneCallMayExist(call)) {
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: null,
            found: false,
            status: 'unknown',
            rawStatus: state.errorCode ?? call.providerStatus ?? null,
            message: centralOneUncertainMessage(key),
          });
        } else {
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: null,
            found: false,
            status: 'not_found',
            rawStatus: state.errorCode ?? call.providerStatus ?? null,
            message: '⚪ No registrada en Central One: rechazó la compra o nunca se envió. Es seguro reintentar.',
          });
        }
        continue;
      }

      const coResult = await centralOne.getOrder(call.providerOrderId).catch(() => null);

      if (coResult && !coResult.found && coResult.httpStatus === 404 && coResult.failureCode === 'not_found') {
        if (call.status === 'processing') {
          call.status = 'error';
          call.error = 'No registrada en Central One (la orden no existe o no llegó a crearse).';
          callChanged = true;
        }
        checks.push({
          index: call.index,
          packageId: call.packageId,
          provider: 'centralone',
          providerOrderId: call.providerOrderId,
          found: false,
          status: 'not_found',
          rawStatus: null,
          message: '⚪ No registrada en Central One: La llamada nunca llegó a procesarse. Es seguro reintentar.',
        });
      } else if (!coResult || !coResult.found) {
        // Sin llave (`missing_config`), red caída o error del proveedor: NO
        // es «no encontrada». Tratarlo así reembolsaba recargas entregadas.
        checks.push({
          index: call.index,
          packageId: call.packageId,
          provider: 'centralone',
          providerOrderId: call.providerOrderId,
          found: false,
          status: 'unknown',
          rawStatus: coResult?.failureCode ?? null,
          message: `No se pudo consultar Central One (${coResult?.failureCode ?? 'sin respuesta'}); no se reembolsa hasta confirmar el pedido.`,
        });
      } else {
        const pOrderId = coResult.orderId ?? call.providerOrderId;
        const pRef = coResult.referenceCode ?? call.providerReference;
        const codes = coResult.isSuccess
          ? await readCentralOneCodes(order, call, pOrderId, coResult.deliveredCount)
          : null;

        if (coResult.isSuccess && codes?.ok) {
          if (codes.codes.length) call.deliveredCodes = codes.codes;
          call.status = 'success';
          call.error = null;
          call.completedAt = now();
          call.providerOrderId = pOrderId;
          call.providerReference = pRef;
          call.providerStatus = coResult.lineStatus || coResult.orderStatus;
          call.httpStatus = 200;
          state.errorCode = null;
          state.pendingReason = null;
          callChanged = true;

          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: pOrderId,
            found: true,
            status: 'completed',
            rawStatus: call.providerStatus,
            message: `Completada en Central One (Ref: ${pRef ?? pOrderId}).`,
          });
        } else if (coResult.isSuccess && codes && !codes.ok) {
          // Entregada pero sin códigos: el dinero ya se gastó. En curso si lo
          // estaba; si no, incierta para que nunca se reembolse sola.
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: pOrderId,
            found: true,
            status: call.status === 'processing' ? 'processing' : 'unknown',
            rawStatus: coResult.lineStatus || coResult.orderStatus,
            message: codes.message,
          });
        } else if (coResult.isPending) {
          if (call.status !== 'processing') {
            call.status = 'processing';
            call.providerOrderId = pOrderId;
            call.providerReference = pRef;
            call.providerStatus = coResult.lineStatus || coResult.orderStatus;
            callChanged = true;
          }
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: pOrderId,
            found: true,
            status: 'processing',
            rawStatus: coResult.lineStatus || coResult.orderStatus,
            message: `En proceso en Central One (Ref: ${pRef ?? pOrderId}). Saldo retenido en cola.`,
          });
        } else if (coResult.isFailed) {
          if (call.status === 'processing') {
            call.status = 'error';
            call.error = sanitizeProviderError(
              coResult.failureMessage || `Falló en Central One: ${coResult.failureCode || coResult.lineStatus}`
            );
            call.providerOrderId = pOrderId;
            call.providerStatus = coResult.lineStatus || coResult.orderStatus;
            callChanged = true;
          }
          // Confirmado cerrado sin entregar. No marca `callChanged` a propósito:
          // eso volvería a cerrar la orden y repetir el aviso; el reintento lo
          // vuelve a confirmar con `GET /orders/{id}` antes de rotar la llave.
          state.keyClosed = true;
          state.errorCode = coResult.failureCode ?? 'failed';
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: pOrderId,
            found: true,
            status: 'failed',
            rawStatus: coResult.lineStatus || coResult.orderStatus,
            message: sanitizeProviderError(coResult.failureMessage || 'Marcada como fallida por Central One.'),
          });
        } else {
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'centralone',
            providerOrderId: pOrderId,
            found: true,
            status: 'unknown',
            rawStatus: coResult.lineStatus || coResult.orderStatus,
            message: `Estado no reconocido en Central One: ${coResult.lineStatus || coResult.orderStatus}`,
          });
        }
      }
    } else if (provider === 'fazercards') {
      const fazerResult = call.providerOrderId
        ? await fazercards.getOrder(call.providerOrderId).catch(() => null)
        : null;

      if (!fazerResult || fazerResult.httpStatus === 404) {
        if (call.status === 'processing') {
          call.status = 'error';
          call.error = 'No registrada en el proveedor (la llamada nunca llegó a procesarse).';
          callChanged = true;
        }
        checks.push({
          index: call.index,
          packageId: call.packageId,
          provider: 'fazercards',
          providerOrderId: call.providerOrderId,
          found: false,
          status: 'not_found',
          rawStatus: null,
          message: '⚪ No registrada en el proveedor: La llamada nunca llegó a procesarse en FazerCards. Es 100% seguro usar el botón de Reintentar.',
        });
      } else {
        const requiresCode = order.providerFamily === 'gift_card' || order.providerFamily === 'game_key';
        const success = Boolean(fazerResult.success && (!requiresCode || Boolean(fazerResult.codes?.length)));

        if (success) {
          if (fazerResult.codes?.length) call.deliveredCodes = fazerResult.codes;
          call.status = 'success';
          call.error = null;
          call.completedAt = now();
          call.providerOrderId = fazerResult.providerOrderId ?? call.providerOrderId;
          call.providerReference = fazerResult.providerReference ?? call.providerReference;
          call.providerStatus = fazerResult.providerStatus;
          callChanged = true;

          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'fazercards',
            providerOrderId: call.providerOrderId,
            found: true,
            status: 'completed',
            rawStatus: fazerResult.providerStatus,
            message: `Completada en FazerCards (Orden #${call.providerOrderId ?? 'N/A'}).`,
          });
        } else if (fazerResult.processing) {
          if (call.status !== 'processing') {
            call.status = 'processing';
            callChanged = true;
          }
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'fazercards',
            providerOrderId: call.providerOrderId,
            found: true,
            status: 'processing',
            rawStatus: fazerResult.providerStatus,
            message: `En proceso en FazerCards (Orden #${call.providerOrderId ?? 'N/A'}).`,
          });
        } else {
          if (call.status === 'processing') {
            call.status = 'error';
            call.error = sanitizeProviderError(fazerResult.message || `Marcada como ${fazerResult.providerStatus}.`);
            callChanged = true;
          }
          checks.push({
            index: call.index,
            packageId: call.packageId,
            provider: 'fazercards',
            providerOrderId: call.providerOrderId,
            found: true,
            status: 'failed',
            rawStatus: fazerResult.providerStatus,
            message: sanitizeProviderError(fazerResult.message || `Marcada como ${fazerResult.providerStatus}.`),
          });
        }
      }
    }
  }

  // Una llamada de Central One que se daría por fallida o no registrada pudo
  // tener un pedido con una llave anterior que se entregó después o sigue
  // abierto: entonces es incierta y la revisión vencida no la reembolsa.
  for (const check of checks) {
    if (check.provider !== 'centralone' || (check.status !== 'failed' && check.status !== 'not_found')) continue;
    const call = calls.find((item) => item.index === check.index) as CentralOneCallState | undefined;
    const block = call ? await supersededCentralOneOrdersBlock(order, call) : null;
    if (block) {
      check.status = 'unknown';
      check.message = block;
    }
  }

  if (callChanged) {
    // Compare-and-set por llamada: lo consultado no pisa lo que el cron o el
    // webhook cambiaron mientras tanto.
    const leidas = order.dispatch?.calls ?? [];
    const merged = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(orderRef);
      const stored = ((fresh.data() as Order | undefined)?.dispatch?.calls ?? []) as DispatchCallResult[];
      const result = mergeDispatchCalls(leidas, stored, calls);
      writeCalls(tx, orderId, result.calls, (cleanCalls) => ({
        dispatch: { ...(fresh.data() as Order | undefined)?.dispatch, calls: cleanCalls },
        updatedAt: now(),
      }));
      return result.calls;
    });
    calls.splice(0, calls.length, ...merged.map((call) => ({ ...call })));
    order.dispatch.calls = merged;
  }

  let summary = '';
  let continuedDispatch = false;

  const allSucceeded = calls.every((c) => c.status === 'success');
  const anyProcessing = calls.some((c) => c.status === 'processing');
  const anySucceeded = calls.some((c) => c.status === 'success');
  const pendingCalls = calls.some(
    (c) => c.status !== 'success' && c.status !== 'processing' && (c.attempts === 0 || c.status === 'pending')
  );

  if (allSucceeded) {
    await finalizeDispatch(order, calls, true, {
      actorUid,
      allowRefundedOverride: true,
      readCalls: order.dispatch.calls,
    });
    summary = 'Todas las llamadas fueron confirmadas como completadas en el proveedor. La orden se completó exitosamente.';

    await addEvent({
      orderId,
      type: 'dispatch_call_ok',
      message: 'Consulta de estado en proveedor: todas las llamadas confirmadas completadas.',
      actor: actorUid ? 'admin' : 'system',
      actorUid: actorUid ?? null,
    });
  } else if (!anyProcessing && anySucceeded && pendingCalls) {
    log.info('Continuando despacho de combo tras verificar llamada exitosa', { orderId, code: order.code });
    await addEvent({
      orderId,
      type: 'dispatch_retry',
      message: 'Llamada previa confirmada exitosa en proveedor. Continuando despacho automático del combo.',
      status: 'dispatching',
      actor: actorUid ? 'admin' : 'system',
      actorUid: actorUid ?? null,
    });

    const dispatchRes = await dispatchOrder(orderId, { isRetry: true, actorUid });
    continuedDispatch = true;
    summary = `Llamada previa confirmada exitosa. Se continuó con el despacho de las recargas pendientes del combo: ${dispatchRes.message}`;
  } else if (anyProcessing) {
    if (order.status !== 'dispatching') {
      const enCurso = calls.find((c) => c.status === 'processing');
      const proveedorEnCurso = enCurso?.provider ?? order.provider ?? 'inefable';
      await orderRef.update({
        status: 'dispatching',
        estado:
          proveedorEnCurso === 'centralone'
            ? 'DESPACHANDO_CENTRAL_ONE'
            : proveedorEnCurso === 'fazercards'
              ? 'DESPACHANDO_FAZERCARDS'
              : 'DESPACHANDO_INEFABLE',
        updatedAt: now(),
      });
    }
    summary = 'Una o más llamadas continúan en proceso en el proveedor. La orden permanece en despacho.';
  } else {
    if (callChanged) {
      await finalizeDispatch(order, calls, false, { actorUid, readCalls: order.dispatch.calls });
    }
    const hasNotFound = checks.some((c) => c.status === 'not_found');
    if (hasNotFound && !anySucceeded) {
      summary = '⚪ No registrada en el proveedor: La llamada nunca llegó a procesarse en el proveedor. Es 100% seguro usar el botón de Reintentar.';
    } else {
      summary = 'Una o más llamadas reportan fallo en el proveedor. La orden permanece en revisión manual.';
    }
  }

  await audit.record({
    action: 'order.provider_status_checked',
    actorUid: actorUid ?? null,
    targetType: 'order',
    targetId: orderId,
    summary: `Consulta de estado en proveedor para ${order.code}: ${summary}`,
    data: { checks, summary, continuedDispatch },
  });

  const freshSnap = await orderRef.get();
  const freshOrder = freshSnap.data() as Order;

  return {
    ok: true,
    orderId: freshOrder.id,
    orderCode: freshOrder.code,
    orderStatus: freshOrder.status,
    orderEstado: freshOrder.estado ?? null,
    calls: checks,
    summary,
    continuedDispatch,
  };
}
