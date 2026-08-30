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
import { orders, games, products, now } from '../config/firebase';
import { log } from '../lib/logger';
import { notFound } from '../lib/errors';
import * as inefable from './inefable';
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

export interface DispatchOutcome {
  status: OrderStatus;
  calls: DispatchCallResult[];
  allSucceeded: boolean;
  message: string;
}

/** Construye el plan de llamadas a partir de la configuración del producto. */
export function buildCallPlan(
  calls: Array<{ packageId: number; quantity: number; providerGameId?: number | null }>
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
    if (!['paid', 'dispatching', 'failed'].includes(order.status)) {
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
    await orderRef.set(
      {
        status: 'failed',
        dispatch: {
          ...order.dispatch,
          lastError: 'El despacho automático está desactivado desde el panel.',
        },
        updatedAt: now(),
      },
      { merge: true }
    );
    await addEvent({
      orderId,
      type: 'dispatch_paused',
      message: 'Despacho automático desactivado. La orden espera acción del administrador.',
      status: 'failed',
    });
    return {
      status: 'failed',
      calls: order.dispatch.calls,
      allSucceeded: false,
      message: 'El despacho automático está desactivado.',
    };
  }

  // Las órdenes creadas antes de que se congelara `providerGameId` no lo traen:
  // para esas se cae al catálogo. Sin este dato el proveedor no sabe a qué
  // juego pertenece el paquete y puede emparejarlo con otro.
  let providerGameId = order.providerGameId ?? null;
  if (providerGameId === null || providerGameId === undefined) {
    const gameSnap = await games().doc(order.gameId).get();
    providerGameId = (gameSnap.data()?.apiGameId as number | undefined) ?? null;
  }

  if (providerGameId === null) {
    const reason = `No se pudo determinar el game_id del proveedor para ${order.gameId}.`;
    await orderRef.set(
      { status: 'failed', dispatch: { ...order.dispatch, lastError: reason }, updatedAt: now() },
      { merge: true }
    );
    await addEvent({ orderId, type: 'dispatch_failed', message: reason, status: 'failed' });
    return { status: 'failed', calls: order.dispatch.calls, allSucceeded: false, message: reason };
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

    call.attempts += 1;

    try {
      const result = await inefable.createOrder({
        // La llamada puede apuntar a otra «tienda» del proveedor; si no lo
        // hace, se usa la del juego.
        gameId: call.providerGameId ?? providerGameId,
        packageId: call.packageId,
        playerId: order.playerId,
        playerId2: order.playerId2 ?? null,
        // Estable por orden y por llamada: si la petición se corta y se
        // reintenta, el proveedor devuelve el resultado de la original en vez
        // de cobrar otra recarga. Un combo tiene un id distinto por parte.
        externalOrderId: `${order.code}-${call.index + 1}`,
      });

      // El saldo del proveedor viaja en cada respuesta: es el momento más
      // barato para detectar que se está agotando.
      void adminAlerts.checkProviderBalance(result.remainingBalance);

      // Se registra la respuesta del proveedor pase lo que pase: es la única
      // pista para diagnosticar después por qué una entrega no salió.
      call.providerOrderId = result.providerOrderId;
      call.providerStatus = result.providerStatus;
      call.playerName = result.playerName;
      call.providerReference = result.providerReference;
      call.httpStatus = result.httpStatus;
      call.providerResponse = result.raw;

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
        call.status = 'error';
        call.error = result.message;
        failure = result.message;

        await addEvent({
          orderId,
          type: 'dispatch_call_error',
          message: `Falló la recarga ${call.index + 1}/${calls.length}: ${result.message}`,
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
      const message = error instanceof Error ? error.message : String(error);
      call.status = 'error';
      call.error = message;
      failure = message;

      await addEvent({
        orderId,
        type: 'dispatch_call_error',
        message: `Error al contactar al proveedor en la recarga ${call.index + 1}: ${message}`,
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

  // Mientras el proveedor tenga algo en curso la orden sigue «despachando»:
  // marcarla fallida sería mentirle al cliente y disparar un aviso en balde.
  const status: OrderStatus = allSucceeded
    ? 'completed'
    : anyProcessing
      ? 'dispatching'
      : 'failed';

  await finalizeDispatch(order, calls, allSucceeded, {
    failure,
    actorUid: options.actorUid ?? null,
    anyProcessing,
  });

  return {
    status,
    calls,
    allSucceeded,
    message: allSucceeded
      ? 'Recarga entregada correctamente.'
      : anyProcessing
        ? 'El proveedor aceptó la recarga y la está procesando.'
        : (failure ?? 'No se pudo completar el despacho.'),
  };
}

/**
 * Cierra una orden ya despachada: estado, correos, comisiones y avisos.
 *
 * Se extrajo porque el desenlace llega por dos caminos —el despacho en vivo y
 * la tarea que resuelve las que el proveedor dejó en curso— y duplicar esto
 * significaría que a una de las dos vías se le olvide pagar la comisión o
 * mandar el correo.
 */
async function finalizeDispatch(
  order: Order,
  calls: DispatchCallResult[],
  allSucceeded: boolean,
  options: { failure?: string | null; actorUid?: string | null; anyProcessing?: boolean } = {}
): Promise<void> {
  const orderId = order.id;
  const orderRef = orders().doc(orderId);
  const failure = options.failure ?? calls.find((call) => call.error)?.error ?? null;
  const anyProcessing = options.anyProcessing ?? calls.some((c) => c.status === 'processing');
  const status: OrderStatus = allSucceeded
    ? 'completed'
    : anyProcessing
      ? 'dispatching'
      : 'failed';

  await orderRef.set(
    {
      status,
      dispatch: {
        calls,
        startedAt: order.dispatch.startedAt ?? now(),
        completedAt: allSucceeded ? now() : null,
        lastError: allSucceeded ? null : failure,
      },
      updatedAt: now(),
    },
    { merge: true }
  );

  // Aceptada y en curso: ni correo de entrega ni de fallo. La tarea programada
  // resolverá el estado real y disparará lo que corresponda.
  if (anyProcessing && !allSucceeded) {
    await notifications.notify({
      uid: order.uid,
      title: 'Tu recarga está en camino ⏳',
      body: `${describeOrder(order)}: el proveedor la está procesando. Te avisamos al terminar.`,
      type: 'order',
      link: `/orden/${orderId}`,
    });

    return;
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
      notifications.notify({
        uid: order.uid,
        title: '¡Recarga entregada! 🎮',
        body: `${describeOrder(order)} ya está en tu cuenta (ID ${order.playerId}).`,
        type: 'order',
        link: `/orden/${orderId}`,
      }),
      usersService.registerCompletedPurchase(order.uid, order.pricing.totalUsd),
      // No lanza: la recarga ya llegó al jugador y un fallo contable no puede
      // deshacerla. Deja rastro en el registro para conciliar.
      creatorsService.accrueCommission(order),
      stats.trackEvent({ type: 'order_completed', order: { ...order, status } }),
      audit.record({
        action: audit.ACTIONS.ORDER_DISPATCHED,
        actorUid: options.actorUid ?? null,
        targetType: 'order',
        targetId: orderId,
        summary: `Orden ${order.code} despachada correctamente.`,
        data: { calls: calls.length },
      }),
    ]);
  } else {
    void sendOrderEmail('dispatch_failed', orderId);

    await addEvent({
      orderId,
      type: 'dispatch_failed',
      message:
        'No pudimos completar la entrega. Nuestro equipo ya fue notificado y lo resolverá.',
      status: 'failed',
    });

    await Promise.all([
      notifications.notify({
        uid: order.uid,
        title: 'Estamos resolviendo tu recarga',
        body: `Tu pago de ${describeOrder(order)} está confirmado. Hubo un problema al entregar y ya lo estamos atendiendo.`,
        type: 'order',
        link: `/orden/${orderId}`,
      }),
      stats.trackEvent({ type: 'order_failed', order: { ...order, status } }),
      audit.record({
        action: audit.ACTIONS.ORDER_DISPATCH_FAILED,
        actorUid: options.actorUid ?? null,
        targetType: 'order',
        targetId: orderId,
        summary: `Falló el despacho de la orden ${order.code}.`,
        data: { error: failure },
      }),
      // El cliente ya pagó: esto necesita a una persona ya, no cuando alguien
      // se acuerde de abrir el panel.
      adminAlerts.alert({
        kind: 'dispatch_failed',
        severity: 'critical',
        title: `Recarga fallida · ${order.code}`,
        body: [
          `${describeOrder(order)} (${order.gameName}) para el ID ${order.playerId}.`,
          `Cobrado: ${order.pricing.totalBs.toFixed(2)} Bs.`,
          `Motivo: ${failure ?? 'sin detalle del proveedor'}.`,
        ].join('\n'),
        link: `/admin/ordenes/${orderId}`,
        data: {
          code: order.code,
          playerId: order.playerId,
          error: failure,
          customer: order.user.email,
        },
      }),
    ]);

    log.error('Despacho fallido', { orderId, code: order.code, error: failure });
  }

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
export async function resolveProcessingOrders(): Promise<{
  revisadas: number;
  completadas: number;
  fallidas: number;
}> {
  const snap = await orders().where('status', '==', 'dispatching').limit(50).get();
  let completadas = 0;
  let fallidas = 0;
  let revisadas = 0;

  for (const doc of snap.docs) {
    const order = { id: doc.id, ...doc.data() } as Order;
    const calls = order.dispatch?.calls ?? [];
    if (!calls.some((call) => call.status === 'processing')) continue;

    revisadas += 1;
    const inicio = order.dispatch?.startedAt as { toMillis?: () => number } | null;
    const iniciadaMs =
      inicio && typeof inicio.toMillis === 'function' ? inicio.toMillis() : Date.now();
    const minutos = (Date.now() - iniciadaMs) / 60_000;
    let cambio = false;

    for (const call of calls) {
      if (call.status !== 'processing') continue;

      const externalOrderId = `${order.code}-${call.index + 1}`;
      const estado = await inefable.getOrderStatus(externalOrderId).catch(() => null);
      if (!estado?.found) {
        // Todavía no aparece: se deja para la próxima pasada.
        continue;
      }

      const normalizado = (estado.status ?? '').toLowerCase();
      if (inefable.isSuccessStatus(normalizado)) {
        call.status = 'success';
        call.error = null;
        call.completedAt = now();
        call.providerStatus = estado.status;
        call.providerOrderId = estado.providerOrderId ?? call.providerOrderId;
        call.providerReference = estado.providerReference ?? call.providerReference;
        cambio = true;
      } else if (inefable.isFailureStatus(normalizado)) {
        call.status = 'error';
        call.error = estado.error || `El proveedor marcó la recarga como ${estado.status}.`;
        call.providerStatus = estado.status;
        cambio = true;
      }
      // Sigue en curso: no se toca.
    }

    const pendientes = calls.some((call) => call.status === 'processing');
    const todasOk = calls.every((call) => call.status === 'success');

    if (cambio && !pendientes) {
      // Se reutiliza el cierre normal del despacho para no duplicar la lógica
      // de correos, comisiones, estadísticas y avisos.
      await finalizeDispatch(order, calls, todasOk);
      if (todasOk) completadas += 1;
      else fallidas += 1;
      continue;
    }

    if (cambio) {
      await orders().doc(order.id).set(
        { dispatch: { ...order.dispatch, calls }, updatedAt: now() },
        { merge: true }
      );
      continue;
    }

    // Sin novedad. Si lleva demasiado, se avisa; y pasado el tope se cierra
    // como fallida para que el equipo pueda resolverla a mano.
    if (minutos >= PROCESSING_GIVE_UP_MINUTES) {
      for (const call of calls) {
        if (call.status === 'processing') {
          call.status = 'error';
          call.error = `El proveedor no resolvió la recarga en ${PROCESSING_GIVE_UP_MINUTES} minutos.`;
        }
      }
      await finalizeDispatch(order, calls, false);
      fallidas += 1;
    } else if (minutos >= PROCESSING_ALERT_MINUTES) {
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
  }

  return { revisadas, completadas, fallidas };
}
