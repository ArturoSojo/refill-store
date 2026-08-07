/**
 * Estadísticas.
 *
 * Se mantienen agregados diarios incrementales (`stats/daily/days/{yyyy-MM-dd}`)
 * para que el dashboard cargue sin recorrer miles de órdenes. Los KPIs del panel
 * se calculan sumando esos documentos, no leyendo la colección de órdenes.
 *
 * Las fechas usan la zona horaria de Venezuela: si se usara UTC, todas las
 * ventas después de las 8 p. m. caerían en el día siguiente.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { dailyStats, now, users, orders } from '../config/firebase';
import { log } from '../lib/logger';
import { round } from '../lib/money';
import type { BreakdownEntry, DailyStats, Order } from '../types/models';

export const STORE_TIMEZONE = 'America/Caracas';

/** Clave `yyyy-MM-dd` en hora de Venezuela. */
export function dayKey(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: STORE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/** Últimas `count` claves de día, de la más antigua a la más reciente. */
export function recentDayKeys(count: number): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    keys.push(dayKey(new Date(Date.now() - i * 86_400_000)));
  }
  return keys;
}

type StatEvent =
  | { type: 'order_created'; order: Order }
  | { type: 'order_completed'; order: Order }
  | { type: 'order_failed'; order: Order }
  | { type: 'payment_rejected'; order: Order }
  | { type: 'order_refunded'; order: Order }
  | { type: 'user_created' };

/** Aplica un evento al agregado del día. Nunca lanza. */
export async function trackEvent(event: StatEvent): Promise<void> {
  const key = dayKey();
  const ref = dailyStats().doc(key);

  try {
    const patch: Record<string, unknown> = { date: key, updatedAt: now() };

    switch (event.type) {
      case 'order_created':
        patch.orders = FieldValue.increment(1);
        break;

      case 'order_completed': {
        const { pricing, gameId, productId } = event.order;
        patch.completedOrders = FieldValue.increment(1);
        patch.revenueUsd = FieldValue.increment(round(pricing.totalUsd, 2));
        patch.revenueBs = FieldValue.increment(round(pricing.totalBs, 2));
        patch.costUsd = FieldValue.increment(round(pricing.costUsd, 2));
        patch.profitUsd = FieldValue.increment(round(pricing.profitUsd, 2));

        // Los desgloses van como objetos ANIDADOS, no con la clave
        // `byGame.free-fire.orders`. En `set()` una clave con puntos es un
        // nombre de campo literal —sólo `update()` la interpreta como ruta—,
        // así que la notación de puntos creaba campos sueltos y los mapas
        // `byGame` y `byProduct` quedaban vacíos: de ahí que los gráficos de
        // ingresos por juego y de productos más vendidos salieran sin datos.
        // Con `merge: true` los mapas se fusionan clave a clave, así que esto
        // no pisa lo acumulado por otros juegos ni productos del mismo día.
        // Con el costo dentro, el panel puede mostrar la ganancia real de cada
        // juego y de cada producto, no sólo cuánto facturó.
        const desglose = {
          orders: FieldValue.increment(1),
          revenueUsd: FieldValue.increment(round(pricing.totalUsd, 2)),
          costUsd: FieldValue.increment(round(pricing.costUsd, 2)),
          profitUsd: FieldValue.increment(round(pricing.profitUsd, 2)),
        };
        patch.byGame = { [gameId]: desglose };
        patch.byProduct = { [productId]: desglose };
        break;
      }

      case 'order_failed':
        patch.failedOrders = FieldValue.increment(1);
        break;

      case 'payment_rejected':
        patch.rejectedPayments = FieldValue.increment(1);
        break;

      case 'order_refunded': {
        const { pricing, gameId, productId } = event.order;
        patch.revenueUsd = FieldValue.increment(-round(pricing.totalUsd, 2));
        patch.profitUsd = FieldValue.increment(-round(pricing.profitUsd, 2));

        // El desglose también tiene que descontar, o acaba sumando más que el
        // total del periodo y los porcentajes por juego salen inflados.
        const desglose = {
          orders: FieldValue.increment(-1),
          revenueUsd: FieldValue.increment(-round(pricing.totalUsd, 2)),
          costUsd: FieldValue.increment(-round(pricing.costUsd, 2)),
          profitUsd: FieldValue.increment(-round(pricing.profitUsd, 2)),
        };
        patch.byGame = { [gameId]: desglose };
        patch.byProduct = { [productId]: desglose };
        break;
      }

      case 'user_created':
        patch.newUsers = FieldValue.increment(1);
        break;
    }

    await ref.set(patch, { merge: true });
  } catch (error) {
    log.warn('No se pudo actualizar el agregado diario', {
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface SeriesPoint {
  date: string;
  orders: number;
  completedOrders: number;
  failedOrders: number;
  revenueUsd: number;
  profitUsd: number;
  newUsers: number;
}

/** Serie diaria lista para graficar, rellenando los días sin ventas con ceros. */
export async function getSeries(days: number): Promise<SeriesPoint[]> {
  const keys = recentDayKeys(days);
  const snaps = await Promise.all(keys.map((key) => dailyStats().doc(key).get()));

  return keys.map((key, index) => {
    const data = (snaps[index].data() ?? {}) as Partial<DailyStats>;
    return {
      date: key,
      orders: data.orders ?? 0,
      completedOrders: data.completedOrders ?? 0,
      failedOrders: data.failedOrders ?? 0,
      revenueUsd: round(data.revenueUsd ?? 0, 2),
      profitUsd: round(data.profitUsd ?? 0, 2),
      newUsers: data.newUsers ?? 0,
    };
  });
}

export interface TotalsSummary {
  orders: number;
  completedOrders: number;
  failedOrders: number;
  rejectedPayments: number;
  revenueUsd: number;
  revenueBs: number;
  costUsd: number;
  profitUsd: number;
  newUsers: number;
  averageTicketUsd: number;
  conversionRate: number;
  byGame: Record<string, BreakdownEntry>;
  byProduct: Record<string, BreakdownEntry>;
}

/** Suma un desglose diario sobre el acumulado del periodo. */
function acumular(
  destino: Record<string, BreakdownEntry>,
  origen: Record<string, Partial<BreakdownEntry>> | undefined
): void {
  for (const [id, value] of Object.entries(origen ?? {})) {
    const actual = destino[id] ?? { orders: 0, revenueUsd: 0, costUsd: 0, profitUsd: 0 };
    destino[id] = {
      orders: actual.orders + (value?.orders ?? 0),
      revenueUsd: actual.revenueUsd + (value?.revenueUsd ?? 0),
      costUsd: actual.costUsd + (value?.costUsd ?? 0),
      profitUsd: actual.profitUsd + (value?.profitUsd ?? 0),
    };
  }
}

function emptyTotals(): TotalsSummary {
  return {
    orders: 0,
    completedOrders: 0,
    failedOrders: 0,
    rejectedPayments: 0,
    revenueUsd: 0,
    revenueBs: 0,
    costUsd: 0,
    profitUsd: 0,
    newUsers: 0,
    averageTicketUsd: 0,
    conversionRate: 0,
    byGame: {},
    byProduct: {},
  };
}

/** Suma los agregados de los últimos `days` días. */
export async function getTotals(days: number): Promise<TotalsSummary> {
  const keys = recentDayKeys(days);
  const snaps = await Promise.all(keys.map((key) => dailyStats().doc(key).get()));

  const totals = emptyTotals();

  for (const snap of snaps) {
    const data = (snap.data() ?? {}) as Partial<DailyStats>;
    totals.orders += data.orders ?? 0;
    totals.completedOrders += data.completedOrders ?? 0;
    totals.failedOrders += data.failedOrders ?? 0;
    totals.rejectedPayments += data.rejectedPayments ?? 0;
    totals.revenueUsd += data.revenueUsd ?? 0;
    totals.revenueBs += data.revenueBs ?? 0;
    totals.costUsd += data.costUsd ?? 0;
    totals.profitUsd += data.profitUsd ?? 0;
    totals.newUsers += data.newUsers ?? 0;

    acumular(totals.byGame, data.byGame);
    acumular(totals.byProduct, data.byProduct);
  }

  totals.revenueUsd = round(totals.revenueUsd, 2);
  totals.revenueBs = round(totals.revenueBs, 2);
  totals.costUsd = round(totals.costUsd, 2);
  totals.profitUsd = round(totals.profitUsd, 2);

  // Sumar decimales acarrea residuos (0.1 + 0.2 = 0.30000000000000004); sin
  // esto el panel mostraría ganancias con doce decimales.
  for (const mapa of [totals.byGame, totals.byProduct]) {
    for (const [id, value] of Object.entries(mapa)) {
      mapa[id] = {
        orders: value.orders,
        revenueUsd: round(value.revenueUsd, 2),
        costUsd: round(value.costUsd, 2),
        profitUsd: round(value.profitUsd, 2),
      };
    }
  }
  totals.averageTicketUsd =
    totals.completedOrders > 0 ? round(totals.revenueUsd / totals.completedOrders, 2) : 0;
  totals.conversionRate =
    totals.orders > 0 ? round((totals.completedOrders / totals.orders) * 100, 1) : 0;

  return totals;
}

/** Conteos que necesitan mirar el estado actual, no el histórico. */
export async function getLiveCounters(): Promise<{
  totalUsers: number;
  pendingOrders: number;
  failedOrders: number;
  awaitingManual: number;
}> {
  const [usersCount, pending, failed, manual] = await Promise.all([
    users().count().get(),
    orders().where('status', 'in', ['awaiting_payment', 'verifying']).count().get(),
    orders().where('status', '==', 'failed').count().get(),
    orders().where('status', '==', 'awaiting_manual').count().get(),
  ]);

  return {
    totalUsers: usersCount.data().count,
    pendingOrders: pending.data().count,
    failedOrders: failed.data().count,
    awaitingManual: manual.data().count,
  };
}
