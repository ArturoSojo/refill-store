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
import { log } from '../lib/logger';
import { notFound } from '../lib/errors';
import { round } from '../lib/money';
import * as inefable from './inefable';
import * as fazercards from './fazercards';
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

/** Construye el plan de llamadas a partir de la configuración del producto. */
export function buildCallPlan(
  calls: Array<{ packageId: number | string; quantity: number; providerGameId?: number | string | null }>
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

  // Sólo el flujo `whatsapp` empuja al cliente al chat. En los otros dos se
  // queda en la tienda y se le avisa cuando esté lista.
  const whatsappUrl =
    flow === 'whatsapp' ? buildManualOrderUrl(order, config.whatsapp.adminNumber, fields) : null;

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

    tx.set(
      orderRef,
      {
        status: 'dispatching',
        estado: 'DESPACHANDO_INEFABLE',
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
    const gameSnap = await games().doc(order.gameId).get();
    providerGameId = (gameSnap.data()?.apiGameId as number | string | undefined) ?? null;
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

    call.attempts += 1;

    try {
      const result =
        provider === 'fazercards'
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
      void adminAlerts.checkProviderBalance(result.remainingBalance);

      // Se registra la respuesta del proveedor pase lo que pase: es la única
      // pista para diagnosticar después por qué una entrega no salió.
      call.providerOrderId = result.providerOrderId;
      call.providerStatus = result.providerStatus;
      call.provider = provider;
      call.playerName = result.playerName;
      call.providerReference = result.providerReference;
      call.httpStatus = result.httpStatus;
      call.providerResponse = result.raw;
      if ('codes' in result && Array.isArray(result.codes) && result.codes.length) {
        call.deliveredCodes = result.codes as string[];
      }

      // FazerCards avisa por su propio `order_id`, no por nuestro código. Se
      // indexa apenas responde para que el webhook resuelva en O(1), incluso
      // cuando haya muchas órdenes simultáneas.
      if (provider === 'fazercards' && result.providerOrderId) {
        await providerOrders()
          .doc(providerOrderIndexId(provider, result.providerOrderId))
          .set({
            provider,
            providerOrderId: result.providerOrderId,
            orderId,
            callIndex: call.index,
            createdAt: now(),
          })
          .catch((error) => {
            // La recarga ya fue aceptada: una caída del índice no puede
            // convertirla en fallo ni habilitar que se vuelva a enviar.
            log.error('No se pudo indexar la orden de FazerCards para webhook', {
              orderId,
              providerOrderId: result.providerOrderId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
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
          message: `El proveedor aceptó la recarga ${call.index + 1}/${calls.length} y la está procesando.`,
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
  options: { failure?: string | null; actorUid?: string | null; anyProcessing?: boolean; allowRefundedOverride?: boolean } = {}
): Promise<OrderStatus> {
  const orderId = order.id;
  const orderRef = orders().doc(orderId);
  const rawFailure = options.failure ?? calls.find((call) => call.error)?.error ?? null;
  const failure = rawFailure ? sanitizeProviderError(rawFailure) : null;
  const anyProcessing = options.anyProcessing ?? calls.some((c) => c.status === 'processing');
  const anySucceeded = calls.some((c) => c.status === 'success');
  const esEntregaParcial = !allSucceeded && !anyProcessing && anySucceeded;
  const nextStatus: OrderStatus = allSucceeded
    ? 'completed'
    : anyProcessing
      ? 'dispatching'
      : 'in_review';
  const nextEstado = allSucceeded
    ? 'COMPLETADO'
    : anyProcessing
      ? 'DESPACHANDO_INEFABLE'
      : esEntregaParcial
        ? 'ENTREGA_PARCIAL_COMBO'
        : 'REVISION_MANUAL';
  const subOrdenes = calls.map((c) => ({
    product_id: c.packageId,
    package_id: c.packageId,
    exito: c.status === 'success',
    order_id: c.providerOrderId ?? null,
    status: c.providerStatus ?? c.status,
    error: c.error ?? null,
    httpStatus: c.httpStatus ?? null,
    timestamp: new Date().toISOString(),
  }));

  const txOutcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) return { kind: 'missing' as const };
    const current = { id: snap.id, ...snap.data() } as Order;

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

    const timestamp = now();
    const isWhatsappOrigin = current.origen === 'WHATSAPP' || current.canal === 'WHATSAPP';
    const updateData: Record<string, unknown> = {
      status: nextStatus,
      estado: nextEstado,
      subOrdenes,
      dispatch: {
        calls,
        startedAt: current.dispatch?.startedAt ?? order.dispatch?.startedAt ?? timestamp,
        completedAt: allSucceeded ? timestamp : null,
        lastError: allSucceeded ? null : failure,
      },
      deliveredCodes: allSucceeded
        ? calls.flatMap((call) => call.deliveredCodes ?? [])
        : current.deliveredCodes ?? order.deliveredCodes ?? [],
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

    tx.set(orderRef, updateData, { merge: true });
    return { kind: 'updated' as const, current, status: nextStatus };
  });

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
  const isWhatsappGuest = order.uid.startsWith('whatsapp:');
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

    await addEvent({
      orderId,
      type: 'completed',
      message: '¡Recarga entregada! Revisa tu cuenta del juego.',
      status: 'completed',
    });

    await Promise.all([
      !isWhatsappGuest
        ? notifications.notify({
            uid: order.uid,
            title: '¡Recarga entregada! 🎮',
            body: `${describeOrder(order)} ya está en tu cuenta (ID ${order.playerId}).`,
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

  for (const call of calls) {
    if (!canCheckCall(call)) continue;

    const provider = call.provider ?? order.provider ?? 'inefable';
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

  if (cambio && !pendientes) {
    // Se reutiliza el cierre normal del despacho para no duplicar la lógica de
    // correos, comisiones, estadísticas y avisos.
    await finalizeDispatch(order, calls, calls.every((call) => call.status === 'success'));
    return true;
  }

  if (cambio) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(orders().doc(order.id));
      if (!snap.exists) return;
      const current = snap.data() as Order;
      if (!['dispatching', 'in_review'].includes(current.status)) return;
      tx.set(
        orders().doc(order.id),
        { dispatch: { ...current.dispatch, calls }, updatedAt: now() },
        { merge: true }
      );
    });
    return false;
  }

  // Sin novedad. Si lleva demasiado se avisa, y pasado el tope se cierra como
  // en revisión para que el equipo pueda atenderla a mano.
  if (order.status === 'dispatching' && minutos >= PROCESSING_GIVE_UP_MINUTES) {
    for (const call of calls) {
      if (call.status === 'processing') {
        call.status = 'error';
        call.error = `El proveedor no resolvió la recarga en ${PROCESSING_GIVE_UP_MINUTES} minutos.`;
      }
    }
    await finalizeDispatch(order, calls, false);
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
  provider: 'inefable' | 'fazercards';
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

  if (callChanged) {
    await orderRef.update({
      'dispatch.calls': calls,
      updatedAt: now(),
    });
    order.dispatch.calls = calls;
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
    await finalizeDispatch(order, calls, true, { actorUid, allowRefundedOverride: true });
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
      await orderRef.update({
        status: 'dispatching',
        estado: 'DESPACHANDO_INEFABLE',
        updatedAt: now(),
      });
    }
    summary = 'Una o más llamadas continúan en proceso en el proveedor. La orden permanece en despacho.';
  } else {
    if (callChanged) {
      await finalizeDispatch(order, calls, false, { actorUid });
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
