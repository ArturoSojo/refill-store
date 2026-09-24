/**
 * Separa los dos escaparates que comparten API y Firestore.
 *
 * Netlify conserva la tienda original, que sólo vende el catálogo de
 * Inefable. En `recargasrefillstore.com`, Free Fire usa Inefable y las demás
 * categorías usan FazerCards. La selección se hace en el servidor para que un enlace directo
 * a un producto no permita saltarse el filtro visual de la portada.
 */
import type { Request } from 'express';
import { notFound } from './errors';
import type { Game } from '../types/models';

export type Storefront = 'inefable' | 'fazercards';

export const INEFABLE_FREE_FIRE_ID = 'free-fire';
export const FAZER_FREE_FIRE_ID = 'fz-topup-free-fire-latam';

const NETLIFY_HOST = 'refill-store-ve.netlify.app';
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
  if (host === NETLIFY_HOST || host.endsWith(`--${NETLIFY_HOST}`)) return 'inefable';
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

  // Las llamadas antiguas y herramientas sin dominio conservan el catálogo
  // histórico, que es el de Inefable. Es el valor más seguro por defecto.
  return 'inefable';
}

export function belongsToStorefront(game: Game, storefront: Storefront): boolean {
  if (storefront === 'inefable') return (game.provider ?? 'inefable') === 'inefable';
  if (game.id === INEFABLE_FREE_FIRE_ID) return (game.provider ?? 'inefable') === 'inefable';
  if (game.id === FAZER_FREE_FIRE_ID) return false;
  return game.provider === 'fazercards';
}

export function assertStorefrontGame(req: Request, game: Game): void {
  if (!belongsToStorefront(game, resolveStorefront(req))) {
    throw notFound('Ese producto no está disponible en esta tienda.');
  }
}
