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

/**
 * ¿El monto reportado por el banco coincide con el esperado?
 * Se admite una tolerancia porcentual pequeña porque algunos bancos redondean
 * los céntimos de forma distinta.
 */
export function amountMatches(
  expectedBs: number,
  receivedBs: number,
  tolerancePercent: number
): boolean {
  if (!Number.isFinite(receivedBs)) return false;
  const tolerance = Math.max((expectedBs * tolerancePercent) / 100, 0.01);
  return Math.abs(expectedBs - receivedBs) <= tolerance;
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
