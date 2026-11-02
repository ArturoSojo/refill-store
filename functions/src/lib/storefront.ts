/**
 * Separa los dos escaparates que comparten API y Firestore.
 *
 * En `recargasrefillstore.com`, Free Fire se vende por Inefable (y por Central
 * One); las demás categorías vienen del catálogo sincronizado de Central One
 * (antes FazerCards, cuyos juegos quedan ocultos tras la migración pero siguen
 * pasando este filtro para los pedidos viejos). La selección se hace en el
 * servidor para que un enlace directo a un producto no permita saltarse el
 * filtro visual de la portada.
 *
 * El valor `'fazercards'` de `Storefront` es el NOMBRE de la tienda .com (lo
 * manda el frontend en `?storefront=`), no el proveedor: no se renombra para
 * no romper clientes con la pestaña abierta.
 */
import type { Request } from 'express';
import { notFound } from './errors';
import type { Game } from '../types/models';

export type Storefront = 'inefable' | 'fazercards';

export const INEFABLE_FREE_FIRE_ID = 'free-fire';
export const INEFABLE_FREE_FIRE_ID_NEW = 'freefire-id';
export const FAZER_FREE_FIRE_ID = 'fz-topup-free-fire-latam';

const FAZER_HOSTS = new Set([
  'recargasrefillstore.com',
  'www.recargasrefillstore.com',
  'refill-e254f.web.app',
  'refill-e254f.firebaseapp.com',
]);

function hostFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function fromHost(host: string | null | undefined): Storefront | null {
  if (!host) return null;
  if (FAZER_HOSTS.has(host) || host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
    return 'fazercards';
  }
  return null;
}

/**
 * El cliente añade `storefront` para que también funcione detrás de un proxy
 * que sustituye el Host por el de Cloud Functions. Origin/Referer prevalecen:
 * ninguna URL puede hacerse pasar por el otro dominio cambiando un query.
 */
export function resolveStorefront(req: Request): Storefront {
  const domainStorefront =
    fromHost(hostFromUrl(req.get('origin'))) ??
    fromHost(hostFromUrl(req.get('referer'))) ??
    fromHost(req.get('x-forwarded-host')?.split(',')[0]?.trim()) ??
    fromHost(req.hostname);

  if (domainStorefront) return domainStorefront;

  const requested = req.query.storefront;
  if (requested === 'fazercards' || requested === 'inefable') return requested;

  // Herramientas sin dominio (CLI, emulador): la tienda es la de FazerCards.
  return 'fazercards';
}

export function belongsToStorefront(game: Game, storefront: Storefront): boolean {
  if (storefront === 'inefable') return (game.provider ?? 'inefable') === 'inefable';
  if (game.id === INEFABLE_FREE_FIRE_ID || game.id === INEFABLE_FREE_FIRE_ID_NEW) return (game.provider ?? 'inefable') === 'inefable';
  // Creado a mano desde el panel: el proveedor sólo decide por dónde se
  // despacha, no en qué tienda se muestra.
  if (game.manual === true && (game.provider ?? 'inefable') === 'inefable') return true;
  // Catálogo sincronizado de Central One. Va DESPUÉS de las reglas de Inefable
  // a propósito: ningún juego de Inefable (free-fire, freefire-id, manuales)
  // cambia de tienda por esta línea.
  if (game.provider === 'centralone') return true;
  return game.provider === 'fazercards';
}

export function assertStorefrontGame(req: Request, game: Game): void {
  if (!belongsToStorefront(game, resolveStorefront(req))) {
    throw notFound('Ese producto no está disponible en esta tienda.');
  }
}
