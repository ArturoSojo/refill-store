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
/** Familia del catálogo sincronizado de la tienda .com (FazerCards o Central One). */
export type StorefrontFamily = FazerFamily;

/**
 * Proveedores cuyo catálogo sincronizado se lista en la tienda .com.
 *
 * FazerCards sigue aquí aunque sus juegos queden ocultos tras la migración:
 * la consulta filtra por `active`, así que no se muestran, y si el panel
 * reactiva uno a mano vuelve a aparecer sin tocar código. Central One es el
 * catálogo nuevo. Nunca se añade `inefable`: sus juegos entran por las reglas
 * propias (Free Fire y manuales) y contarlos aquí los duplicaría.
 */
export const STOREFRONT_PROVIDERS = ['fazercards', 'centralone'] as const;
type StorefrontProvider = (typeof STOREFRONT_PROVIDERS)[number];

function isStorefrontProvider(provider: Game['provider']): provider is StorefrontProvider {
  return provider === 'fazercards' || provider === 'centralone';
}

/** Prefijo del id de documento que genera cada sincronización. */
const STOREFRONT_ID_PREFIXES: Record<StorefrontProvider, string> = {
  fazercards: 'fz-',
  centralone: 'co-',
};

/**
 * Juegos fijados al inicio de la portada, en este orden.
 *
 * Los ids de Central One no se fijan aquí: dependen del `product_family_id`
 * del proveedor y la sincronización ya les asigna `sortOrder` por prioridad
 * (Free Fire 10, Blood Strike 20…), que es el desempate tras estos fijos.
 * Los `fz-*` quedan para la convivencia previa al corte: inactivos, se
 * descartan solos.
 */
const HOME_PRIORITY: Partial<Record<FazerFamily, string[]>> = {
  topup: [
    FAZER_FREE_FIRE_ID,
    'freefire-id',
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

/** Juego del catálogo sincronizado, visible y de la familia pedida. */
function isListedStorefrontGame(game: Game, family: FazerFamily): boolean {
  return game.active && isStorefrontProvider(game.provider) && game.providerFamily === family;
}

/**
 * Busca categorías por el ID normalizado que genera la sincronización.
 * Firestore recorre únicamente los prefijos solicitados (`co-…` y `fz-…`); no
 * descarga el catálogo completo para buscarlo en el teléfono.
 *
 * El cursor es el id del último documento devuelto. Los rangos se recorren en
 * orden de id (`co-` < `fz-`), así que un cursor de un rango posterior salta
 * los anteriores y uno de un rango anterior empieza el siguiente desde cero:
 * ninguna categoría se repite ni se pierde entre páginas.
 */
export async function searchStorefrontGamesByFamily(
  family: FazerFamily,
  search: string,
  options: { cursor?: string; limit: number }
): Promise<Page<Game>> {
  const slug = slugify(search);
  const prefixes = STOREFRONT_PROVIDERS.map((provider) => `${STOREFRONT_ID_PREFIXES[provider]}${family}-${slug}`).sort();
  const batchSize = Math.max(options.limit + 1, 30);
  const items: Game[] = [];

  for (const prefix of prefixes) {
    if (items.length > options.limit) break;
    const end = `${prefix}\uf8ff`;
    // El cursor ya pasó este rango completo.
    if (options.cursor && !options.cursor.startsWith(prefix) && options.cursor > end) continue;
    let after = options.cursor?.startsWith(prefix) ? options.cursor : undefined;
    let exhausted = false;

    while (items.length <= options.limit && !exhausted) {
      let query = games()
        .orderBy(FieldPath.documentId())
        .endAt(end)
        .limit(batchSize);
      query = after ? query.startAfter(after) : query.startAt(prefix);
      const snap = await query.get();
      exhausted = snap.empty || snap.size < batchSize;
      for (const doc of snap.docs) {
        after = doc.id;
        const game = { id: doc.id, ...doc.data() } as Game;
        if (isListedStorefrontGame(game, family)) {
          items.push(game);
          if (items.length > options.limit) break;
        }
      }
    }
  }

  return {
    items: items.slice(0, options.limit),
    nextCursor: items.length > options.limit ? items[options.limit - 1].id : null,
  };
}

/** Lee sólo una familia activa del catálogo sincronizado (FazerCards y Central One). */
export async function listStorefrontGamesByFamily(
  family: FazerFamily,
  limit?: number
): Promise<Game[]> {
  // `in` usa el mismo índice compuesto que la igualdad (provider, providerFamily,
  // active, sortOrder, __name__): no hace falta un índice nuevo.
  let query = games()
    .where('provider', 'in', [...STOREFRONT_PROVIDERS])
    .where('providerFamily', '==', family)
    .where('active', '==', true)
    .orderBy('sortOrder', 'asc')
    .orderBy(FieldPath.documentId(), 'asc');
  if (limit !== undefined) query = query.limit(limit);
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Game);
}

/** Portada: mantiene las categorías principales visibles sin leer la familia completa. */
export async function listStorefrontHomeGamesByFamily(family: FazerFamily, limit: number): Promise<Game[]> {
  const [firstPage, ...pinned] = await Promise.all([
    listStorefrontGamesByFamily(family, limit),
    ...(HOME_PRIORITY[family] ?? []).map(async (id) => {
      const snap = await games().doc(id).get();
      if (!snap.exists) return null;
      const game = { id: snap.id, ...snap.data() } as Game;
      const accepted = id === INEFABLE_FREE_FIRE_ID || id === 'freefire-id' || (game.manual && game.provider === 'inefable')
        ? family === 'topup' && (game.provider ?? 'inefable') === 'inefable'
        : isStorefrontProvider(game.provider) && game.providerFamily === family;
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
 * Las listas de la tienda principal sólo consultan el catálogo sincronizado
 * (`provider in ['fazercards','centralone']`), así que estos juegos no
 * aparecerían aunque estén activos. Son pocos, por eso se leen por el flag
 * `manual` (índice simple) y se filtran en memoria. Siempre son recargas, así
 * que sólo entran en la familia `topup`.
 */
export async function listManualInefableGames(): Promise<Game[]> {
  const snap = await games().where('manual', '==', true).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }) as Game)
    .filter((game) => game.active && (game.provider ?? 'inefable') === 'inefable')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Cuenta categorías visibles sin leer cada documento del catálogo.
 *
 * Una sola agregación con `in`: cada juego cuenta una vez aunque haya dos
 * proveedores. Los juegos de Inefable (Free Fire y manuales) no entran aquí;
 * los suma `GET /catalog`, que es quien los añade a la lista.
 */
export async function countStorefrontGamesByFamily(family: FazerFamily): Promise<number> {
  const result = await games().where('provider', 'in', [...STOREFRONT_PROVIDERS]).where('providerFamily', '==', family)
    .where('active', '==', true).count().get();
  return result.data().count;
}

/** Lista una familia con cursor para que el catálogo grande no se lea completo. */
export async function pageStorefrontGamesByFamily(
  family: FazerFamily,
  options: { cursor?: string; limit: number }
): Promise<Page<Game>> {
  const query = games()
    .where('provider', 'in', [...STOREFRONT_PROVIDERS])
    .where('providerFamily', '==', family)
    .where('active', '==', true);
  const page = await paginate(
    query,
    { orderBy: 'sortOrder', direction: 'asc', cursor: options.cursor, limit: options.limit, withTotal: !options.cursor },
    (id, data) => ({ id, ...data }) as Game
  );
  return page;
}

// Nombres anteriores, cuando el catálogo .com era sólo FazerCards. Se conservan
// como alias para no romper a quien los importe; ya cubren ambos proveedores.
export const searchFazerGamesByFamily = searchStorefrontGamesByFamily;
export const listFazerGamesByFamily = listStorefrontGamesByFamily;
export const listFazerHomeGamesByFamily = listStorefrontHomeGamesByFamily;
export const countFazerGamesByFamily = countStorefrontGamesByFamily;
export const pageFazerGamesByFamily = pageStorefrontGamesByFamily;

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

  const aLevelUp = a.kind === 'level_up' ? 1 : 0;
  const bLevelUp = b.kind === 'level_up' ? 1 : 0;
  if (aLevelUp !== bLevelUp) return aLevelUp - bLevelUp;

  if (aLevelUp === 1) {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.priceUsd - b.priceUsd;
  }

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
type KnownCurrency = { label: string; iconUrl: string };

const FREE_FIRE_CURRENCY: KnownCurrency = { label: 'Diamantes', iconUrl: '/coins/diamante-freefire.svg' };
const BLOOD_STRIKE_CURRENCY: KnownCurrency = { label: 'Oro', iconUrl: '/coins/gold-bloodstrike.svg' };
const MLBB_CURRENCY: KnownCurrency = { label: 'Diamantes', iconUrl: '/coins/diamante-mlbb.svg' };
const HOK_CURRENCY: KnownCurrency = { label: 'Tokens', iconUrl: '/coins/token-hok.svg' };
const MARVEL_CURRENCY: KnownCurrency = { label: 'Lattice', iconUrl: '/coins/lattice-marvel.svg' };

const KNOWN_CURRENCY_BY_ID: Record<string, KnownCurrency> = {
  [INEFABLE_FREE_FIRE_ID]: FREE_FIRE_CURRENCY,
  'freefire-id': FREE_FIRE_CURRENCY,
  'fz-topup-blood-strike': BLOOD_STRIKE_CURRENCY,
  'fz-topup-mobile-legends-global': MLBB_CURRENCY,
  'fz-topup-honor-of-kings': HOK_CURRENCY,
  'fz-topup-marvel-rivals': MARVEL_CURRENCY,
};

/**
 * Los ids de Central One salen del `product_family_id` del proveedor y no se
 * conocen de antemano (`co-topup-free-fire-latam`, `co-topup-blood-strike-global`…),
 * así que su moneda se reconoce por el nombre. Sólo aplica a sus recargas:
 * una gift card «Free Fire» no entrega diamantes con ese icono.
 */
const KNOWN_CURRENCY_BY_NAME: Array<[RegExp, KnownCurrency]> = [
  [/free\s*fire/i, FREE_FIRE_CURRENCY],
  [/blood\s*strike/i, BLOOD_STRIKE_CURRENCY],
  [/mobile\s*legends|\bmlbb\b/i, MLBB_CURRENCY],
  [/honor\s*of\s*kings/i, HOK_CURRENCY],
  [/marvel\s*rivals/i, MARVEL_CURRENCY],
];

export function knownCurrencyFor(game: Pick<Game, 'id' | 'name' | 'provider' | 'providerFamily'>): KnownCurrency | undefined {
  const byId = KNOWN_CURRENCY_BY_ID[game.id];
  if (byId) return byId;
  if (game.provider !== 'centralone' || (game.providerFamily ?? 'topup') !== 'topup') return undefined;
  const name = game.name ?? '';
  return KNOWN_CURRENCY_BY_NAME.find(([pattern]) => pattern.test(name))?.[1];
}

export function toPublicGame(game: Game): Game {
  const known = knownCurrencyFor(game);
  const currentIconUrl = game.currencyIconUrl?.trim() ?? '';
  const expiredCanvaIcon = game.id === INEFABLE_FREE_FIRE_ID && currentIconUrl.includes('media.canva.com');
  return {
    ...game,
    playerFields: resolvePlayerFields(game),
    // «Recargas» es la etiqueta genérica de las sincronizaciones; un juego de
    // Central One recién creado puede llegar además sin etiqueta. Lo que el
    // admin escriba a mano siempre manda.
    currencyLabel:
      known && (game.currencyLabel === 'Recargas' || (game.provider === 'centralone' && !game.currencyLabel?.trim()))
        ? known.label
        : game.currencyLabel,
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

/**
 * Máximo de unidades por orden.
 *
 * Una recarga de Central One a un mismo jugador no se multiplica: cada unidad
 * sería un pedido aparte al proveedor y un pase o una subida de nivel repetida
 * falla (o se cobra dos veces). Las gift cards sí admiten varias unidades, con
 * el tope de stock que ya revisa `createOrder`. El resto conserva el tope
 * general de la ruta.
 *
 * El tope se limita al catálogo nuevo: los juegos `co-*` que crea la
 * sincronización y los extras que ella misma cuelga de Free Fire
 * (`centralOneExtra`). Los productos sembrados de Central One en juegos de
 * Inefable (oro de `blood-strike`, `ff-co-nivel-*`, `ff-m-pase-booyah`) ya se
 * vendían de a varias unidades —cada una sale con su llave y `quantity: 1`—
 * y no deben cambiar con la migración.
 */
export function maxOrderQuantity(product: Product, game: Game): number | null {
  const family = game.providerFamily ?? 'topup';
  if (family === 'gift_card' || family === 'game_key') return null;
  if (game.provider === 'centralone' || product.centralOneExtra === true) return 1;
  return null;
}

/** Oferta de Central One con la que se puede consultar `POST /player/validate`. */
export interface CentralOneValidationTarget {
  product: Product;
  /** `product_id` de Central One. */
  productId: string;
  /** Claves de `target_payload` que declara la oferta, en orden. */
  targetFields: string[];
}

function toValidationTarget(product: Product, game: Game): CentralOneValidationTarget | null {
  if (product.gameId !== game.id || !product.active || product.providerRemoved === true) return null;
  if (product.fulfillment !== 'auto') return null;
  const call = product.calls?.[0];
  if ((call?.provider ?? product.provider ?? game.provider) !== 'centralone') return null;
  const productId = String(product.providerOfferId ?? call?.packageId ?? '').trim();
  if (!productId) return null;
  // Producto (lo protege del PATCH del panel) → call → campos del juego, que en
  // los juegos de Central One usan las mismas claves que el proveedor.
  const targetFields = Array.isArray(product.targetFields)
    ? product.targetFields
    : Array.isArray(call?.targetFields)
      ? call.targetFields
      : resolvePlayerFields(game).map((field) => field.key);
  return { product, productId, targetFields };
}

/**
 * Elige la oferta con la que validar el ID en un juego de Central One: la que
 * eligió el comprador si sirve; si no, la primera activa en el orden de la
 * tienda (los paquetes de moneda más baratos van primero, que son los que
 * Central One suele cubrir). La cuenta del jugador es la misma para todas las
 * ofertas del juego, así que cualquiera vale. Función pura.
 */
export function pickCentralOneValidationTarget(
  game: Game,
  list: Product[],
  preferredProductId?: string | null
): CentralOneValidationTarget | null {
  if (preferredProductId) {
    const chosen = list.find((product) => product.id === preferredProductId);
    const target = chosen ? toValidationTarget(chosen, game) : null;
    if (target) return target;
  }
  for (const product of list) {
    const target = toValidationTarget(product, game);
    if (target) return target;
  }
  return null;
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

  // Los juegos de Central One ya traen sus campos del `target_schema` del
  // proveedor (claves, etiquetas, opciones de servidor): forzar aquí el molde
  // «User ID / Zone ID» de MLBB pisaría lo que pide el producto real.
  const validation = game.provider === 'centralone' ? null : resolveFazerValidationCategory(game);
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
        key: second?.key || 'server_id',
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
 *
 * En las ofertas que mantiene la sync de Central One el precio nuevo queda
 * fijado (`priceLocked`), igual que al editarlo a mano (D6): si no, la
 * siguiente sync lo devolvía al margen por defecto sin avisar. Se escribe en
 * lotes de 400: un recálculo de todo el catálogo pasa de miles de productos.
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
  const timestamp = now();
  let batch = products().firestore.batch();
  let pending = 0;

  for (const product of target) {
    const next = applyMargin(product.costUsd, options.marginPercent, options.roundToUsd);
    if (round(next, 4) === round(product.priceUsd, 4)) continue;

    changes.push({ id: product.id, from: product.priceUsd, to: next });
    const syncedCentralOne = product.provider === 'centralone' && Boolean(product.providerSyncedAt);
    batch.set(
      products().doc(product.id),
      { priceUsd: next, ...(syncedCentralOne ? { priceLocked: true } : {}), updatedAt: timestamp },
      { merge: true }
    );
    pending += 1;
    if (pending >= 400) {
      await batch.commit();
      batch = products().firestore.batch();
      pending = 0;
    }
  }

  if (pending > 0) await batch.commit();
  return { updated: changes.length, changes };
}
