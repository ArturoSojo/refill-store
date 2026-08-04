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
  /** `true` si el pago cubre la orden dentro de lo aceptable. */
  ok: boolean;
  /** Cuánto faltó, en Bs. `0` si pagó igual o de más. */
  shortfallBs: number;
  /** Cuánto sobró, en Bs. `0` si pagó igual o de menos. */
  surplusBs: number;
  /** Margen que se admitió por debajo del total, en Bs. */
  toleranceBs: number;
}

/**
 * ¿El pago cubre la orden?
 *
 * La tolerancia es **asimétrica**, y no por capricho: pagar de más y pagar de
 * menos no son el mismo hecho.
 *
 *  - **De menos** es una pérdida directa. Sólo se admite el margen configurado,
 *    que existe porque los bancos redondean los céntimos de forma distinta y
 *    porque mucha gente teclea el monto sin decimales.
 *  - **De más** no perjudica al negocio: la orden queda cubierta. Rechazar a
 *    quien pagó de más sólo genera un reclamo. Se acepta y se registra el
 *    excedente para que el equipo decida si lo devuelve al saldo del cliente.
 *
 * Con una tolerancia simétrica del 8 %, una orden de 3.000 Bs se daría por
 * pagada con 2.760: eso es lo que se evita aquí.
 */
export function checkAmount(
  expectedBs: number,
  receivedBs: number,
  tolerancePercent: number
): AmountCheck {
  const toleranceBs = Math.max((expectedBs * tolerancePercent) / 100, 0.01);

  if (!Number.isFinite(receivedBs)) {
    return { ok: false, shortfallBs: expectedBs, surplusBs: 0, toleranceBs };
  }

  const difference = round(receivedBs - expectedBs, 2);
  const shortfallBs = difference < 0 ? Math.abs(difference) : 0;
  const surplusBs = difference > 0 ? difference : 0;

  return {
    ok: shortfallBs <= toleranceBs,
    shortfallBs,
    surplusBs,
    toleranceBs,
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
