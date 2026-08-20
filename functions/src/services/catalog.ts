/** Lectura y escritura del catálogo (juegos y productos). */
import { games, products, now } from '../config/firebase';
import { notFound, failedPrecondition } from '../lib/errors';
import { applyMargin, round, usdToBs } from '../lib/money';
import { DEFAULT_PLAYER_FIELD } from '../types/models';
import type { Game, PlayerField, Product, PublicProduct } from '../types/models';

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

/**
 * Orden en que se muestran los productos de un juego.
 *
 * Se ordena por la CANTIDAD de moneda que entrega cada uno, de menor a mayor.
 * Antes mandaba un número puesto a mano (`sortOrder`) y eso se desordenaba solo:
 * cada producto creado desde el panel nacía con 99 y caía al final, así que un
 * combo de 200 aparecía después del paquete de 5.000. Ordenar por lo que el
 * cliente compara —cuántos diamantes recibe— no hay que mantenerlo nunca.
 *
 * Dos matices:
 *  - Los combos entran donde les toca por su cantidad, no en un bloque aparte:
 *    100, 200, 310… es como los busca el jugador.
 *  - Los especiales (pases, tarjetas) no son una cantidad de moneda comparable,
 *    así que van al final ordenados por precio.
 *
 * `sortOrder` sobrevive sólo para desempatar dos productos con la misma
 * cantidad.
 */
export function compareProducts(a: Product, b: Product): number {
  const aSpecial = a.kind === 'special' ? 1 : 0;
  const bSpecial = b.kind === 'special' ? 1 : 0;
  if (aSpecial !== bSpecial) return aSpecial - bSpecial;

  if (aSpecial === 1) {
    if (a.priceUsd !== b.priceUsd) return a.priceUsd - b.priceUsd;
    return a.sortOrder - b.sortOrder;
  }

  const totalA = a.amount + a.bonus;
  const totalB = b.amount + b.bonus;
  if (totalA !== totalB) return totalA - totalB;

  return a.sortOrder - b.sortOrder;
}

/**
 * Producto con los campos que pueden faltar ya resueltos.
 *
 * `manualFlow` se añadió después, así que los productos creados antes no lo
 * tienen. Se resuelve al leer y no con una migración obligatoria para que un
 * documento viejo nunca llegue al checkout con el campo en `undefined`.
 */
function toProduct(id: string, data: FirebaseFirestore.DocumentData): Product {
  return {
    id,
    ...data,
    manualFlow: (data.manualFlow as Product['manualFlow'] | undefined) ?? 'notify',
  } as Product;
}

export async function listProducts(
  options: { gameId?: string; onlyActive?: boolean } = {}
): Promise<Product[]> {
  const snap = options.gameId
    ? await products().where('gameId', '==', options.gameId).get()
    : await products().get();

  const all = snap.docs.map((doc) => toProduct(doc.id, doc.data()));
  const filtered = options.onlyActive ? all.filter((product) => product.active) : all;

  // Los productos de juegos distintos no se comparan entre sí: primero se
  // agrupan por juego y dentro de cada uno se ordena por cantidad.
  return filtered.sort((a, b) =>
    a.gameId === b.gameId ? compareProducts(a, b) : a.gameId.localeCompare(b.gameId)
  );
}

export async function getProduct(productId: string): Promise<Product> {
  const snap = await products().doc(productId).get();
  if (!snap.exists) throw notFound('Ese producto no existe.');
  return toProduct(snap.id, snap.data() ?? {});
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

/**
 * Juego tal como lo consume la tienda: con `playerFields` siempre resuelto.
 *
 * Así la interfaz no tiene que repetir la lógica de compatibilidad con los
 * juegos que se crearon cuando sólo existía un campo de ID.
 */
export function toPublicGame(game: Game): Game {
  return {
    ...game,
    playerFields: resolvePlayerFields(game),
    currencyIconUrl: game.currencyIconUrl ?? '',
    validatesPlayerId: game.validatesPlayerId ?? false,
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

// ---------------------------------------------------------------------------
// Campos que el juego le pide al comprador
// ---------------------------------------------------------------------------

/**
 * Lista de campos del juego, reconstruyendo uno solo para los juegos antiguos.
 *
 * Los juegos creados antes de que existiera `playerFields` sólo tienen las tres
 * propiedades sueltas del ID. Resolverlos aquí evita tener que migrar Firestore
 * y que un documento sin migrar rompa el checkout.
 */
export function resolvePlayerFields(game: Game): PlayerField[] {
  const declared = Array.isArray(game.playerFields) ? game.playerFields : [];
  if (declared.length > 0) return declared;

  return [
    {
      ...DEFAULT_PLAYER_FIELD,
      label: game.playerIdLabel || DEFAULT_PLAYER_FIELD.label,
      pattern: game.playerIdPattern || DEFAULT_PLAYER_FIELD.pattern,
      help: game.playerIdHelp || DEFAULT_PLAYER_FIELD.help,
    },
  ];
}

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    // Patrón mal escrito en el panel: se cae al del documento técnico en vez de
    // dejar pasar cualquier cosa.
    return /^\d{8,12}$/;
  }
}

export interface ResolvedPlayerData {
  /** Valor que viaja como `player_id`. */
  playerId: string;
  /** Valor que viaja como `player_id2`, si el juego declara uno. */
  playerId2: string | null;
  /** Todos los valores, por clave de campo. */
  values: Record<string, string>;
}

/**
 * Valida los datos del comprador contra los campos del juego y resuelve a qué
 * campo del proveedor va cada uno.
 *
 * Acepta tanto el formato nuevo (`{ playerId, zoneId }`) como el viejo (sólo la
 * cadena del ID), porque una pestaña abierta antes del despliegue seguiría
 * mandando el formato anterior.
 */
export function resolvePlayerData(
  input: Record<string, string> | string,
  game: Game
): ResolvedPlayerData {
  const fields = resolvePlayerFields(game);
  const raw =
    typeof input === 'string' ? { [fields[0]?.key ?? 'playerId']: input } : (input ?? {});

  const values: Record<string, string> = {};
  let playerId: string | null = null;
  let playerId2: string | null = null;

  for (const field of fields) {
    const value = (raw[field.key] ?? '').toString().trim();

    if (!value) {
      if (field.required) {
        throw failedPrecondition(`Falta completar «${field.label}».`);
      }
      continue;
    }

    if (!compile(field.pattern).test(value)) {
      throw failedPrecondition(field.help || `El valor de «${field.label}» no es válido.`);
    }

    values[field.key] = value;
    if (field.providerField === 'player_id') playerId = value;
    if (field.providerField === 'player_id2') playerId2 = value;
  }

  // Ningún campo se marcó como `player_id`: se usa el primero para no dejar la
  // orden sin identificador principal.
  if (playerId === null) {
    playerId = values[fields[0]?.key ?? 'playerId'] ?? '';
  }

  if (!playerId) throw failedPrecondition('Falta el identificador de la cuenta a recargar.');

  return { playerId, playerId2, values };
}

/** Valida el ID del jugador contra el patrón definido en el juego. */
export function assertValidPlayerId(playerId: string, game: Game): void {
  const field = resolvePlayerFields(game)[0];
  if (!compile(field.pattern).test(playerId)) {
    throw failedPrecondition(field.help || 'El ID de jugador no tiene un formato válido.');
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
