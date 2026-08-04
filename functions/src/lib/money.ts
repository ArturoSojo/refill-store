/**
 * Aritmética monetaria.
 *
 * Todo se calcula en centavos enteros antes de redondear, para no arrastrar
 * los errores de coma flotante clásicos (0.1 + 0.2). El monto en bolívares es
 * el dato crítico: es exactamente lo que se compara contra el pago reportado
 * por Pabilo, así que se congela en la orden al momento de crearla.
 */

/** Redondea a `decimals` decimales sin errores de binario. */
export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Redondea `value` al múltiplo de `step` más cercano hacia arriba. */
export function roundUpTo(value: number, step: number): number {
  if (step <= 0) return round(value, 2);
  return round(Math.ceil(round(value / step, 6)) * step, 4);
}

/** Redondea `value` al múltiplo de `step` más cercano. */
export function roundTo(value: number, step: number): number {
  if (step <= 0) return round(value, 2);
  return round(Math.round(round(value / step, 6)) * step, 4);
}

/** Convierte USD a bolívares aplicando la tasa y el redondeo configurado. */
export function usdToBs(usd: number, rate: number, roundStep = 0.01): number {
  return roundTo(usd * rate, roundStep);
}

/** Aplica un margen porcentual sobre el costo y redondea el precio de venta. */
export function applyMargin(costUsd: number, marginPercent: number, roundStep = 0.05): number {
  const raw = costUsd * (1 + marginPercent / 100);
  return roundUpTo(raw, roundStep);
}

export interface AmountCheck {
  /** `true` si lo transferido cubre el total de la orden. */
  ok: boolean;
  /** Cuánto faltó, en Bs. `0` si pagó igual o de más. */
  shortfallBs: number;
  /** Cuánto sobró, en Bs. `0` si pagó igual o de menos. */
  surplusBs: number;
  /** A partir de este excedente se avisa al equipo, en Bs. */
  alertAboveBs: number;
}

/**
 * ¿El pago cubre la orden?
 *
 * La regla es de una sola dirección: **el monto transferido nunca puede ser
 * menor que el total**. Ni un céntimo. Pagar de menos es una pérdida directa, y
 * un porcentaje de holgura sobre montos grandes se convierte en mucho dinero:
 * con un 8 %, una orden de 3.000 Bs se daría por pagada con 2.760.
 *
 * Hacia arriba no hay límite: la orden queda cubierta y rechazar a quien pagó de
 * más sólo genera un reclamo. El excedente se registra, y si pasa de
 * `alertAboveBs` se avisa al equipo para que decida si se lo abona al cliente.
 *
 * Los dos montos se redondean a céntimos antes de compararlos. Sin eso, un pago
 * exacto podría rechazarse por el error de representación de los decimales
 * (3708.60 guardado como 3708.5999999999995).
 */
export function checkAmount(
  expectedBs: number,
  receivedBs: number,
  alertOverPercent: number
): AmountCheck {
  const alertAboveBs = Math.max((expectedBs * alertOverPercent) / 100, 0.01);

  if (!Number.isFinite(receivedBs)) {
    return { ok: false, shortfallBs: expectedBs, surplusBs: 0, alertAboveBs };
  }

  const difference = round(round(receivedBs, 2) - round(expectedBs, 2), 2);
  const shortfallBs = difference < 0 ? Math.abs(difference) : 0;
  const surplusBs = difference > 0 ? difference : 0;

  return {
    ok: shortfallBs === 0,
    shortfallBs,
    surplusBs,
    alertAboveBs,
  };
}

export function formatUsd(value: number): string {
  return `$${round(value, 2).toFixed(2)}`;
}

export function formatBs(value: number): string {
  return new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(round(value, 2));
}
