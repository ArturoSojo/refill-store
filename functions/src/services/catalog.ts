/** Lectura y escritura del catálogo (juegos y productos). */
import { games, products, now } from '../config/firebase';
import { FieldPath } from 'firebase-admin/firestore';
import { notFound, failedPrecondition } from '../lib/errors';
import { applyMargin, round, usdToBs } from '../lib/money';
import { DEFAULT_PLAYER_FIELD } from '../types/models';
import { paginate, type Page } from '../lib/pagination';
import { FAZER_FREE_FIRE_ID, INEFABLE_FREE_FIRE_ID } from '../lib/storefront';
import { slugify } from '../lib/ids';
import { resolveFazerValidationCategory } from '../lib/validation';
import type { Game, PlayerField, Product, PublicProduct } from '../types/models';

export async function listGames(options: { onlyActive?: boolean } = {}): Promise<Game[]> {
  const snap = await games().orderBy('sortOrder', 'asc').get();
  const all = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Game);
  return options.onlyActive ? all.filter((game) => game.active) : all;
}

export type FazerFamily = 'topup' | 'gift_card' | 'game_key';

const HOME_PRIORITY: Partial<Record<FazerFamily, string[]>> = {
  topup: [
    FAZER_FREE_FIRE_ID,
    INEFABLE_FREE_FIRE_ID,
    'fz-topup-blood-strike',
    'fz-topup-pubg-mobile-auto',
    'fz-topup-mobile-legends-global',
    'fz-topup-delta-force',
    'fz-topup-genshin-impact-global',
    'fz-topup-farlight-84',
  ],
  gift_card: [
    'fz-gift_card-google-play-es',
    'fz-gift_card-app-store-itunes-es',
    'fz-gift_card-app-store-itunes-mx',
    'fz-gift_card-steam-wallet-mx',
    'fz-gift_card-roblox-global',
    'fz-gift_card-roblox-mx',
  ],
};

/** Busca categorías por el ID normalizado que genera la sincronización.
 * Firestore recorre únicamente el prefijo solicitado; no descarga el catálogo
 * completo para buscarlo en el teléfono. */
export async function searchFazerGamesByFamily(
  family: FazerFamily,
  search: string,
  options: { cursor?: string; limit: number }
): Promise<Page<Game>> {
  const prefix = `fz-${family}-${slugify(search)}`;
  const items: Game[] = [];
  let after = options.cursor?.startsWith(prefix) ? options.cursor : undefined;
  let exhausted = false;

  while (items.length <= options.limit && !exhausted) {
    let query = games()
      .orderBy(FieldPath.documentId())
      .endAt(`${prefix}\uf8ff`)
      .limit(Math.max(options.limit + 1, 30));
    query = after ? query.startAfter(after) : query.startAt(prefix);
    const snap = await query.get();
    exhausted = snap.empty || snap.size < Math.max(options.limit + 1, 30);
    for (const doc of snap.docs) {
      after = doc.id;
      const game = { id: doc.id, ...doc.data() } as Game;
      if (game.active && game.provider === 'fazercards' && game.providerFamily === family) {
        items.push(game);
        if (items.length > options.limit) break;
      }
    }
  }

  return {
    items: items.slice(0, options.limit),
    nextCursor: items.length > options.limit ? items[options.limit - 1].id : null,
  };
}

/** Lee sólo una familia activa del catálogo grande de FazerCards. */
export async function listFazerGamesByFamily(
  family: FazerFamily,
  limit?: number
): Promise<Game[]> {
  let query = games()
    .where('provider', '==', 'fazercards')
    .where('providerFamily', '==', family)
    .where('active', '==', true)
    .orderBy('sortOrder', 'asc')
    .orderBy(FieldPath.documentId(), 'asc');
  if (limit !== undefined) query = query.limit(limit);
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Game);
}

/** Portada: mantiene las categorías principales visibles sin leer la familia completa. */
export async function listFazerHomeGamesByFamily(family: FazerFamily, limit: number): Promise<Game[]> {
  const [firstPage, ...pinned] = await Promise.all([
    listFazerGamesByFamily(family, limit),
    ...(HOME_PRIORITY[family] ?? []).map(async (id) => {
      const snap = await games().doc(id).get();
      if (!snap.exists) return null;
      const game = { id: snap.id, ...snap.data() } as Game;
      const accepted = id === INEFABLE_FREE_FIRE_ID
        ? family === 'topup' && game.provider === 'inefable'
        : game.provider === 'fazercards' && game.providerFamily === family;
      return game.active && accepted ? game : null;
    }),
  ]);
  const rank = new Map((HOME_PRIORITY[family] ?? []).map((id, index) => [id, index]));
  const unique = new Map([...firstPage, ...pinned.filter((game): game is Game => Boolean(game))].map((game) => [game.id, game]));
  return [...unique.values()]
    .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      || (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
      || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * Juegos creados a mano desde el panel que despachan por Inefable.
 *
 * Las listas de la tienda principal sólo consultan `provider == 'fazercards'`,
 * así que estos juegos no aparecerían aunque estén activos. Son pocos, por eso
 * se leen por el flag `manual` (índice simple) y se filtran en memoria. Siempre
 * son recargas, así que sólo entran en la familia `topup`.
 */
export async function listManualInefableGames(): Promise<Game[]> {
  const snap = await games().where('manual', '==', true).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }) as Game)
    .filter((game) => game.active && (game.provider ?? 'inefable') === 'inefable')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
}

/** Cuenta categorías visibles sin leer cada documento del catálogo. */
export async function countFazerGamesByFamily(family: FazerFamily): Promise<number> {
  const result = await games().where('provider', '==', 'fazercards').where('providerFamily', '==', family)
    .where('active', '==', true).count().get();
  return result.data().count;
}

/** Lista una familia con cursor para que el catálogo grande no se lea completo. */
export async function pageFazerGamesByFamily(
  family: FazerFamily,
  options: { cursor?: string; limit: number }
): Promise<Page<Game>> {
  const query = games()
    .where('provider', '==', 'fazercards')
    .where('providerFamily', '==', family)
    .where('active', '==', true);
  const page = await paginate(
    query,
    { orderBy: 'sortOrder', direction: 'asc', cursor: options.cursor, limit: options.limit, withTotal: !options.cursor },
    (id, data) => ({ id, ...data }) as Game
  );
  return page;
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
  const knownCurrency: Record<string, { label: string; iconUrl: string }> = {
    [INEFABLE_FREE_FIRE_ID]: { label: 'Diamantes', iconUrl: '/coins/diamante-freefire.svg' },
    'fz-topup-blood-strike': { label: 'Oro', iconUrl: '/coins/gold-bloodstrike.svg' },
    'fz-topup-mobile-legends-global': { label: 'Diamantes', iconUrl: '/coins/diamante-mlbb.svg' },
    'fz-topup-honor-of-kings': { label: 'Tokens', iconUrl: '/coins/token-hok.svg' },
    'fz-topup-marvel-rivals': { label: 'Lattice', iconUrl: '/coins/lattice-marvel.svg' },
  };
  const known = knownCurrency[game.id];
  const currentIconUrl = game.currencyIconUrl?.trim() ?? '';
  const expiredCanvaIcon = game.id === INEFABLE_FREE_FIRE_ID && currentIconUrl.includes('media.canva.com');
  return {
    ...game,
    playerFields: resolvePlayerFields(game),
    currencyLabel: game.currencyLabel === 'Recargas' && known ? known.label : game.currencyLabel,
    currencyIconUrl: expiredCanvaIcon ? known?.iconUrl ?? '' : currentIconUrl || known?.iconUrl || '',
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
  if (game.requiresPlayerData === false) return [];
  const declared = Array.isArray(game.playerFields) ? game.playerFields : [];

  const validation = resolveFazerValidationCategory(game);
  if (
    validation?.categoryId === 'mobile_legends' ||
    validation?.categoryId === 'magic_chess_gogo_global' ||
    validation?.categoryId === 'magic_chess_gogo_ru'
  ) {
    const first = declared[0];
    const second = declared[1];
    return [
      {
        key: first?.key || 'player_id',
        label: 'User ID',
        pattern: first?.pattern || '^\\d{6,12}$',
        help: first?.help || 'Tu User ID del juego.',
        placeholder: first?.placeholder || 'Ej: 123456789',
        type: first?.type || 'number',
        providerField: first?.providerField || 'player_id',
        required: true,
        sensitive: false,
      },
      {
        key: second?.key || 'zone_id',
        label: 'Zone ID',
        pattern: second?.pattern || '^\\d{3,6}$',
        help: second?.help || 'El Zone ID es el número entre paréntesis.',
        placeholder: second?.placeholder || 'Ej: 2345',
        type: second?.type || 'number',
        providerField: second?.providerField || 'player_id2',
        required: true,
        sensitive: false,
      },
      ...declared.slice(2),
    ];
  }

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
  // Gift cards y game keys se entregan como código: no piden datos de una
  // cuenta y la orden conserva campos vacíos de forma explícita.
  if (fields.length === 0) return { playerId: '', playerId2: null, values: {} };
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

/**
 * Recalcula `productCount` y `minPriceUsd` de un juego creado a mano.
 *
 * La portada de FazerCards lee ese resumen del juego en lugar de sus productos;
 * en los juegos sincronizados lo escribe la sincronización, en los manuales se
 * mantiene aquí cada vez que el panel toca uno de sus productos.
 */
export async function refreshManualGameSummary(gameId: string): Promise<void> {
  const ref = games().doc(gameId);
  const snap = await ref.get();
  if (snap.data()?.manual !== true) return;
  const active = await listProducts({ gameId, onlyActive: true });
  await ref.set(
    {
      productCount: active.length,
      minPriceUsd: active.length ? round(Math.min(...active.map((item) => item.priceUsd)), 2) : null,
      updatedAt: now(),
    },
    { merge: true }
  );
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
