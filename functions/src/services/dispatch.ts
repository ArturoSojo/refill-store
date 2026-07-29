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
import { orders, now } from '../config/firebase';
import { log } from '../lib/logger';
import { notFound } from '../lib/errors';
import * as inefable from './inefable';
import * as audit from './audit';
import * as notifications from './notifications';
import * as stats from './stats';
import * as usersService from './users';
import { addEvent } from './orderEvents';
import { getConfig } from './settings';
import { buildManualOrderUrl } from './whatsapp';
import type { DispatchCallResult, Order, OrderStatus } from '../types/models';

export interface DispatchOutcome {
  status: OrderStatus;
  calls: DispatchCallResult[];
  allSucceeded: boolean;
  message: string;
}

/** Construye el plan de llamadas a partir de la configuración del producto. */
export function buildCallPlan(
  calls: Array<{ packageId: number; quantity: number }>
): DispatchCallResult[] {
  const plan: DispatchCallResult[] = [];
  let index = 0;

  for (const call of calls) {
    // `quantity: 2` en un mismo packageId significa dos llamadas idénticas
    // seguidas (el combo 200+20 💎 = dos veces el paquete 1).
    for (let i = 0; i < Math.max(1, call.quantity); i += 1) {
      plan.push({
        packageId: call.packageId,
        index,
        status: 'pending',
        providerOrderId: null,
        providerStatus: null,
        error: null,
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
  const whatsappUrl = buildManualOrderUrl(order, config.whatsapp.adminNumber);

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
    message: 'Pago verificado. Producto manual listo para gestionar por WhatsApp.',
    status: 'awaiting_manual',
  });

  await notifications.notify({
    uid: order.uid,
    title: 'Pago confirmado ✅',
    body: `Tu ${order.productName} se entrega por WhatsApp. Abre el chat para completarlo.`,
    type: 'order',
    link: `/orden/${orderId}`,
  });

  return {
    status: 'awaiting_manual',
    calls: [],
    allSucceeded: true,
    message: 'Producto manual listo para gestión por WhatsApp.',
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
    // diamantes y repetirlas sería regalar producto.
    if (call.status === 'success') continue;

    call.attempts += 1;

    try {
      const result = await inefable.createOrder({
        productId: call.packageId,
        playerId: order.playerId,
      });

      if (result.success) {
        call.status = 'success';
        call.providerOrderId = result.providerOrderId;
        call.providerStatus = result.providerStatus;
        call.error = null;
        call.completedAt = now();

        await addEvent({
          orderId,
          type: 'dispatch_call_ok',
          message: `Recarga ${call.index + 1}/${calls.length} enviada (paquete ${call.packageId}).`,
          data: { providerOrderId: result.providerOrderId },
        });
      } else {
        call.status = 'error';
        call.error = result.message;
        failure = result.message;

        await addEvent({
          orderId,
          type: 'dispatch_call_error',
          message: `Falló la recarga ${call.index + 1}/${calls.length}: ${result.message}`,
          data: { packageId: call.packageId, httpStatus: result.httpStatus },
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
  const status: OrderStatus = allSucceeded ? 'completed' : 'failed';

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

  if (allSucceeded) {
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
        body: `${order.productName} ya está en tu cuenta (ID ${order.playerId}).`,
        type: 'order',
        link: `/orden/${orderId}`,
      }),
      usersService.registerCompletedPurchase(order.uid, order.pricing.totalUsd),
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
        body: `Tu pago de ${order.productName} está confirmado. Hubo un problema al entregar y ya lo estamos atendiendo.`,
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
    ]);

    log.error('Despacho fallido', { orderId, code: order.code, error: failure });
  }

  return {
    status,
    calls,
    allSucceeded,
    message: allSucceeded
      ? 'Recarga entregada correctamente.'
      : (failure ?? 'No se pudo completar el despacho.'),
  };
}
