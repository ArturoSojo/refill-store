/** Lectura y escritura del catálogo (juegos y productos). */
import { games, products, now } from '../config/firebase';
import { notFound, failedPrecondition } from '../lib/errors';
import { applyMargin, round, usdToBs } from '../lib/money';
import type { Game, Product, PublicProduct } from '../types/models';

export async function listGames(options: { onlyActive?: boolean } = {}): Promise<Game[]> {
  const snap = await games().orderBy('sortOrder', 'asc').get();
  const all = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Game);
  return options.onlyActive ? all.filter((game) => game.active) : all;
}

export async function getGame(gameId: string): Promise<Game> {
  const snap = await games().doc(gameId).get();
  if (!snap.exists) throw notFound('Ese juego no existe.');
  return { id: snap.id, ...snap.data() } as Game;
}

export async function listProducts(
  options: { gameId?: string; onlyActive?: boolean } = {}
): Promise<Product[]> {
  const snap = options.gameId
    ? await products().where('gameId', '==', options.gameId).get()
    : await products().get();

  const all = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Product);
  const filtered = options.onlyActive ? all.filter((product) => product.active) : all;
  return filtered.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function getProduct(productId: string): Promise<Product> {
  const snap = await products().doc(productId).get();
  if (!snap.exists) throw notFound('Ese producto no existe.');
  return { id: snap.id, ...snap.data() } as Product;
}

/**
 * Quita del producto todo lo que el cliente no debe ver: el costo del proveedor
 * y la configuración de llamadas al API (que revelaría los `package_id`).
 */
export function toPublicProduct(product: Product, rate: number, roundToBs: number): PublicProduct {
  const {
    costUsd: _costUsd,
    calls: _calls,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = product;

  return {
    ...rest,
    priceBs: usdToBs(product.priceUsd, rate, roundToBs),
  };
}

/** Comprobaciones antes de dejar comprar un producto. */
export function assertPurchasable(product: Product, game: Game): void {
  if (!product.active) throw failedPrecondition('Ese producto no está disponible ahora.');
  if (!game.active) throw failedPrecondition('Ese juego no está disponible ahora.');
  if (product.stock !== null && product.stock <= 0) {
    throw failedPrecondition('Ese producto está agotado.');
  }
  if (product.fulfillment === 'auto' && product.calls.length === 0) {
    throw failedPrecondition(
      'Ese producto está mal configurado. Avísale al soporte, por favor.'
    );
  }
}

/** Valida el ID del jugador contra el patrón definido en el juego. */
export function assertValidPlayerId(playerId: string, game: Game): void {
  let pattern: RegExp;
  try {
    pattern = new RegExp(game.playerIdPattern);
  } catch {
    // Patrón mal escrito en el panel: se cae al patrón del documento técnico.
    pattern = /^\d{8,12}$/;
  }
  if (!pattern.test(playerId)) {
    throw failedPrecondition(
      game.playerIdHelp || 'El ID de jugador no tiene un formato válido.'
    );
  }
}

/** Descuenta stock tras una venta. Ignora los productos de stock ilimitado. */
export async function decrementStock(productId: string, quantity: number): Promise<void> {
  const ref = products().doc(productId);
  const snap = await ref.get();
  const stock = snap.data()?.stock as number | null | undefined;
  if (stock === null || stock === undefined) return;

  await ref.set({ stock: Math.max(0, stock - quantity), updatedAt: now() }, { merge: true });
}

/**
 * Recalcula el precio de venta de varios productos a partir de su costo y un
 * margen. Es la herramienta del panel para reaccionar a un cambio de costos del
 * proveedor sin editar producto por producto.
 */
export async function repriceProducts(options: {
  marginPercent: number;
  roundToUsd: number;
  gameId?: string;
  onlyIds?: string[];
}): Promise<{ updated: number; changes: Array<{ id: string; from: number; to: number }> }> {
  const all = await listProducts({ gameId: options.gameId });
  const target = options.onlyIds?.length
    ? all.filter((product) => options.onlyIds!.includes(product.id))
    : all;

  const changes: Array<{ id: string; from: number; to: number }> = [];
  const batch = products().firestore.batch();
  const timestamp = now();

  for (const product of target) {
    const next = applyMargin(product.costUsd, options.marginPercent, options.roundToUsd);
    if (round(next, 4) === round(product.priceUsd, 4)) continue;

    changes.push({ id: product.id, from: product.priceUsd, to: next });
    batch.set(
      products().doc(product.id),
      { priceUsd: next, updatedAt: timestamp },
      { merge: true }
    );
  }

  if (changes.length > 0) await batch.commit();
  return { updated: changes.length, changes };
}
