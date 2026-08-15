/**
 * Escalera de niveles de fidelidad.
 *
 * La tabla de abajo es sólo el punto de partida: el administrador la edita en
 * caliente desde el panel y queda guardada en `config/app.tiers`. Lo que NO se
 * puede editar son las claves (`hierro`, `bronce`, …), porque son las que están
 * escritas en cada perfil de usuario: renombrarlas dejaría a la gente con un
 * nivel que ya no existe. Se editan el umbral, el descuento y los textos.
 *
 * Las funciones son puras y reciben la escalera vigente. Quien tenga acceso a
 * la configuración usa `services/users.activeLadder()`; los umbrales por
 * defecto sólo entran en juego si el documento nunca se editó.
 */
import type { TierDefinition, UserTier } from '../types/models';

export type { TierDefinition };

/**
 * Orden canónico de los niveles, de menor a mayor.
 *
 * Es el orden en el que se evalúan y se muestran, y no depende de los umbrales
 * que ponga el administrador: si alguien guardara un umbral fuera de lugar, el
 * saneado lo corrige en vez de reordenar los niveles.
 */
export const TIER_ORDER: readonly UserTier[] = [
  'hierro',
  'bronce',
  'plata',
  'oro',
  'platino',
  'esmeralda',
  'rubi',
  'diamante',
] as const;

/** El escalón más bajo: respaldo ante un perfil sin nivel o con uno desconocido. */
export const BASE_TIER: UserTier = TIER_ORDER[0];

/** Techo defensivo: un descuento mayor que esto es con seguridad un error de tipeo. */
export const MAX_DISCOUNT_PERCENT = 50;

export const DEFAULT_TIERS: readonly TierDefinition[] = [
  { tier: 'hierro', label: 'Hierro', minSpentUsd: 0, discountPercent: 0, profile: 'Cliente inicial' },
  { tier: 'bronce', label: 'Bronce', minSpentUsd: 51, discountPercent: 0.5, profile: 'Primer descuento desbloqueado' },
  { tier: 'plata', label: 'Plata', minSpentUsd: 101, discountPercent: 1, profile: 'Cliente recurrente' },
  { tier: 'oro', label: 'Oro', minSpentUsd: 201, discountPercent: 1.5, profile: 'Comprador frecuente' },
  { tier: 'platino', label: 'Platino', minSpentUsd: 331, discountPercent: 2, profile: 'Usuario VIP' },
  { tier: 'esmeralda', label: 'Esmeralda', minSpentUsd: 500, discountPercent: 2.5, profile: 'Usuario élite' },
  { tier: 'rubi', label: 'Rubí', minSpentUsd: 701, discountPercent: 3, profile: 'Pequeño revendedor / Pro' },
  { tier: 'diamante', label: 'Diamante', minSpentUsd: 1000, discountPercent: 3.5, profile: 'Revendedor mayorista / Partner' },
] as const;

function defaultFor(tier: UserTier): TierDefinition {
  return DEFAULT_TIERS.find((entry) => entry.tier === tier) ?? DEFAULT_TIERS[0];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Devuelve una escalera utilizable a partir de lo que haya guardado.
 *
 * Repara en vez de fallar, porque esto corre en el camino de cada compra: un
 * documento a medio migrar no puede tumbar el checkout. La validación estricta
 * (la que sí rechaza) vive en la ruta del panel, que es donde el administrador
 * puede leer el error y corregirlo.
 */
export function normalizeLadder(stored: unknown): TierDefinition[] {
  const list = Array.isArray(stored) ? stored : [];
  const byTier = new Map<UserTier, Partial<TierDefinition>>();
  for (const raw of list) {
    if (raw && typeof raw === 'object' && 'tier' in raw) {
      const entry = raw as Partial<TierDefinition>;
      if (entry.tier && TIER_ORDER.includes(entry.tier)) byTier.set(entry.tier, entry);
    }
  }

  let previousMin = -1;
  return TIER_ORDER.map((tier, index) => {
    const fallback = defaultFor(tier);
    const stored_ = byTier.get(tier);

    const label = typeof stored_?.label === 'string' && stored_.label.trim() ? stored_.label.trim() : fallback.label;
    const profile =
      typeof stored_?.profile === 'string' && stored_.profile.trim() ? stored_.profile.trim() : fallback.profile;
    const discountPercent = clamp(Number(stored_?.discountPercent ?? fallback.discountPercent), 0, MAX_DISCOUNT_PERCENT);

    // El primer escalón siempre arranca en cero, y cada uno siguiente tiene que
    // superar al anterior: si no, un tramo quedaría sin poder alcanzarse nunca.
    let minSpentUsd = index === 0 ? 0 : clamp(Number(stored_?.minSpentUsd ?? fallback.minSpentUsd), 0, 1_000_000);
    if (minSpentUsd <= previousMin) minSpentUsd = previousMin + 1;
    previousMin = minSpentUsd;

    return { tier, label, minSpentUsd, discountPercent, profile };
  });
}

/** Nivel que corresponde a un gasto acumulado, según la escalera dada. */
export function tierForSpend(totalSpentUsd: number, ladder: readonly TierDefinition[] = DEFAULT_TIERS): UserTier {
  const spent = Number.isFinite(totalSpentUsd) ? totalSpentUsd : 0;
  // De mayor a menor: el primero que alcanza es el suyo.
  for (let index = ladder.length - 1; index >= 0; index -= 1) {
    if (spent >= ladder[index].minSpentUsd) return ladder[index].tier;
  }
  return BASE_TIER;
}

/**
 * Descuento permanente del nivel, en porcentaje.
 *
 * Un nivel desconocido (un perfil viejo con un nombre que ya no existe) cae a
 * cero en vez de reventar: el usuario pierde el descuento hasta su próxima
 * compra, que es cuando se recalcula, y nunca se le cobra de menos.
 */
export function tierDiscountPercent(
  tier: UserTier,
  ladder: readonly TierDefinition[] = DEFAULT_TIERS
): number {
  return ladder.find((entry) => entry.tier === tier)?.discountPercent ?? 0;
}

export function tierDefinition(
  tier: UserTier,
  ladder: readonly TierDefinition[] = DEFAULT_TIERS
): TierDefinition {
  return ladder.find((entry) => entry.tier === tier) ?? defaultFor(tier);
}
