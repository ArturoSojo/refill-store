/**
 * Escalera de niveles de fidelidad.
 *
 * Ésta es la ÚNICA fuente de verdad del sistema: el umbral, el descuento y la
 * etiqueta de cada nivel salen de aquí. El frontend no la duplica, la recibe
 * servida en `/config` y en `/me`, para que subir un descuento no exija tocar
 * dos repositorios ni volver a desplegar la tienda.
 *
 * El orden importa: `tierForSpend` recorre la tabla de mayor a menor umbral y
 * se queda con el primero que el usuario alcanza.
 */
import type { UserTier } from '../types/models';

export interface TierDefinition {
  tier: UserTier;
  label: string;
  /** Gasto acumulado (en USD) a partir del cual se entra al nivel. */
  minSpentUsd: number;
  /** Descuento permanente, en porcentaje. */
  discountPercent: number;
  /** Cómo se describe al cliente en ese escalón. */
  profile: string;
}

/** De menor a mayor, que es como se muestra al cliente. */
export const TIERS: readonly TierDefinition[] = [
  { tier: 'hierro', label: 'Hierro', minSpentUsd: 0, discountPercent: 0, profile: 'Cliente inicial' },
  { tier: 'bronce', label: 'Bronce', minSpentUsd: 51, discountPercent: 0.5, profile: 'Primer descuento desbloqueado' },
  { tier: 'plata', label: 'Plata', minSpentUsd: 101, discountPercent: 1, profile: 'Cliente recurrente' },
  { tier: 'oro', label: 'Oro', minSpentUsd: 201, discountPercent: 1.5, profile: 'Comprador frecuente' },
  { tier: 'platino', label: 'Platino', minSpentUsd: 331, discountPercent: 2, profile: 'Usuario VIP' },
  { tier: 'esmeralda', label: 'Esmeralda', minSpentUsd: 500, discountPercent: 2.5, profile: 'Usuario élite' },
  { tier: 'rubi', label: 'Rubí', minSpentUsd: 701, discountPercent: 3, profile: 'Pequeño revendedor / Pro' },
  { tier: 'diamante', label: 'Diamante', minSpentUsd: 1000, discountPercent: 3.5, profile: 'Revendedor mayorista / Partner' },
] as const;

/** El escalón más bajo: sirve de respaldo ante un perfil sin nivel o corrupto. */
export const BASE_TIER: UserTier = TIERS[0].tier;

const BY_TIER = new Map<UserTier, TierDefinition>(TIERS.map((entry) => [entry.tier, entry]));

/** De mayor a menor umbral, que es el orden en el que hay que evaluar. */
const DESCENDING = [...TIERS].sort((a, b) => b.minSpentUsd - a.minSpentUsd);

export function tierForSpend(totalSpentUsd: number): UserTier {
  const spent = Number.isFinite(totalSpentUsd) ? totalSpentUsd : 0;
  return DESCENDING.find((entry) => spent >= entry.minSpentUsd)?.tier ?? BASE_TIER;
}

/**
 * Descuento permanente del nivel, en porcentaje.
 *
 * Un nivel desconocido (un perfil viejo con un nombre que ya no existe) cae al
 * escalón base en vez de reventar: el usuario pierde el descuento hasta su
 * próxima compra, que es cuando se recalcula, y nunca cobra de menos.
 */
export function tierDiscountPercent(tier: UserTier): number {
  return BY_TIER.get(tier)?.discountPercent ?? 0;
}

export function tierDefinition(tier: UserTier): TierDefinition {
  return BY_TIER.get(tier) ?? TIERS[0];
}

/** Siguiente escalón, o `null` si ya está en el tope. */
export function nextTier(tier: UserTier): TierDefinition | null {
  const index = TIERS.findIndex((entry) => entry.tier === tier);
  return index >= 0 && index < TIERS.length - 1 ? TIERS[index + 1] : null;
}
