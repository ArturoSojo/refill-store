/**
 * Sincronización del catálogo de Central One con Refill Store.
 *
 * Central One entrega TODO su catálogo en una sola respuesta (`GET /catalog`,
 * unos 5 MB y miles de ítems): se pide una vez por sync. Cada
 * `(familia, product_family_id, región)` se convierte en un juego `co-*` y
 * cada `product_id` en un producto `${gameId}--${slug(product_id)}`.
 *
 * Reglas que conviene tener presentes al tocar esto:
 *
 *  - **El admin manda en la presentación.** Nombre, imágenes, colores, orden y
 *    `active` de un juego se escriben sólo al crearlo. En productos, el admin
 *    apaga con `adminDisabled` y fija precio con `priceLocked`; la sync nunca
 *    pisa esas decisiones (sólo sube el precio si el costo lo supera, para no
 *    vender a pérdida).
 *  - **Inefable no se toca.** Sólo se escriben docs `co-*` con
 *    `provider: 'centralone'`. Los productos de Central One sembrados dentro de
 *    `free-fire`/`blood-strike` no empiezan por `co-` y quedan fuera de todo.
 *    Lo único que se añade a `free-fire`/`freefire-id` son productos NUEVOS
 *    (extras de Free Fire), nunca se modifican los existentes ni su juego.
 *  - **Retirados sólo con sync completa.** Si el catálogo llega raro (freno de
 *    seguridad) o se acaba el tiempo, nada se marca `providerRemoved`, no se
 *    retira FazerCards y no se crean extras.
 *  - **Diff-only.** Se lee lo existente con `getAll` en lotes y sólo se
 *    escribe lo que cambió: una sync sin cambios no gasta escrituras.
 *  - Corre dentro del trigger `runCentralOneSync` (540 s): el presupuesto de
 *    480 s deja margen para cerrar el doc `providerSync/{id}`.
 */
import { FieldPath, FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import {
  db,
  games,
  now,
  privateCentralOneConfigDoc,
  privateCentralOneSyncLockDoc,
  products,
  providerSync,
} from '../config/firebase';
import { applyMargin, round } from '../lib/money';
import { slugify } from '../lib/ids';
import { log } from '../lib/logger';
import { resolveRegionInfo, extractPackageRegionNotice, calculateGameSortOrder } from '../lib/regions';
import { getConfig } from './settings';
import * as centralOne from './centralOne';
import type { CoCatalogItem } from './centralOne';
import * as adminAlerts from './adminAlerts';
import type {
  CentralOneSyncSummary,
  DispatchCall,
  Game,
  PlayerField,
  PlayerFieldOption,
  Product,
  ProductKind,
  ProviderSync,
  ProviderSyncTrigger,
} from '../types/models';

// ---------------------------------------------------------------------------
// Parámetros
// ---------------------------------------------------------------------------

/** El trigger tiene 540 s; se dejan 60 para cerrar el doc y registrar. */
const TIME_BUDGET_MS = 480_000;
/** Escrituras por batch de Firestore (tope de la plataforma: 500). */
const WRITE_BATCH_SIZE = 400;
/** Documentos por `getAll`: lotes chicos para no pasar el tamaño de petición. */
const READ_CHUNK_SIZE = 300;
/** Con al menos tantos juegos activos se exige conservar la mitad (freno). */
const SANITY_MIN_ACTIVE_GAMES = 20;

const FIELD_HELP = 'Revisa este dato antes de pagar: una entrega al identificador equivocado no se puede recuperar.';

/** Juegos de Inefable que reciben los extras de Free Fire (sólo productos nuevos). */
const INEFABLE_FREE_FIRE_GAME_IDS = ['free-fire', 'freefire-id'] as const;
const INEFABLE_FREE_FIRE_ID = 'free-fire';
const INEFABLE_FREE_FIRE_ID_NEW = 'freefire-id';
/** Combo sembrado «Subida de Nivel Completo (6 al 30)» del juego `free-fire`. */
const FREE_FIRE_LEVEL_COMBO_ID = 'ff-co-nivel-completo';
/** Juego de FazerCards cuya presentación hereda el Free Fire de Central One. */
const FAZER_FREE_FIRE_GAME_ID = 'fz-topup-free-fire-latam';

const FREE_FIRE_NAME = /free\s*fire/i;

export type CoFamily = 'topup' | 'gift_card';

const CO_CATEGORY_FAMILY: Record<string, CoFamily> = {
  gaming_topup: 'topup',
  gift_card: 'gift_card',
};

const FAMILY_META: Record<CoFamily, { label: string; icon: string; accent: string; accentSecondary: string }> = {
  topup: { label: 'Recargas', icon: '🎮', accent: '#F03030', accentSecondary: '#B01B1B' },
  gift_card: { label: 'Gift cards', icon: '🎁', accent: '#10B981', accentSecondary: '#059669' },
};

// ---------------------------------------------------------------------------
// Filtro regional (copia de `visibleInLatam` de fazerCatalogSync.ts)
// ---------------------------------------------------------------------------

// Se copia en lugar de importarse porque allá no se exporta y ese módulo queda
// congelado (FazerCards ya no sincroniza). Si cambia la regla, cambiar ambas.
const LATAM = new Set([
  'LATAM', 'GLOBAL', 'WORLD', 'WORLDWIDE', 'VE', 'CO', 'MX', 'AR', 'BR', 'CL', 'PE', 'EC', 'BO',
  'PY', 'UY', 'CR', 'PA', 'DO', 'GT', 'HN', 'SV', 'NI', 'PR', 'CU', 'AMERICAS',
]);

const FOREIGN_REGION = /\b(?:CIS|MENA|ASIA|SEA|EU|UK|US|CA|RU|UA|TR|IN|ID|MY|PH|TH|KR|JP|CN|TW|HK|AU|NZ|AFRICA|AE|SA)\b/i;

export function visibleInLatam(family: CoFamily, name: string, note: string | null, region: string | null): boolean {
  const source = `${region ?? ''} ${(name ?? '')} ${note ?? ''}`.toUpperCase();
  // Las gift cards estadounidenses se venden explícitamente desde el catálogo
  // del .com; las recargas siguen limitadas a regiones compatibles con
  // Latinoamérica.
  if (family === 'gift_card' && /\b(?:US|USA|UNITED STATES|ESTADOS UNIDOS)\b/i.test(source)) {
    return true;
  }
  const tokens = source.match(/\b[A-Z]{2,12}\b/g) ?? [];
  if (tokens.some((token) => LATAM.has(token))) return true;
  // Sin región declarada es común en recargas globales; se mantiene visible.
  return !FOREIGN_REGION.test(source);
}

// ---------------------------------------------------------------------------
// Ids y textos
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  return out === '' ? null : out;
}

/** `co-${family}-${slug(familyId-region)}`: mismo esquema que `fz-*` para que la búsqueda por prefijo funcione. */
export function coGameId(family: CoFamily, familyId: string, region: string): string {
  return `co-${family}-${slugify(`${familyId}-${region}`) || 'x'}`;
}

/** `products/{id}`: `${gameId}--${slug(product_id)}`. */
export function coProductId(gameId: string, productId: string): string {
  return `${gameId}--${slugify(productId) || 'x'}`;
}

function familyIdOf(item: Pick<CoCatalogItem, 'product_family_id' | 'product_family_name' | 'name'>): string {
  return text(item.product_family_id) ?? (slugify(String(item.product_family_name || item.name || '')) || 'sin-familia');
}

function coRegion(item: Pick<CoCatalogItem, 'region'>): string {
  return text(item.region)?.toUpperCase() ?? 'GLOBAL';
}

function asciiFold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** `Mobile Legends (LATAM)` → `mobile legends`: para emparejar con los juegos `fz-*`. */
export function normalizeGameBaseName(name: string): string {
  return asciiFold(name ?? '')
    .replace(/\([^()]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Nombre de la oferta sin el nombre del juego: `Free Fire (BR) · 110
 * Diamantes` → `110 Diamantes`; `Free Fire 110 Diamantes` → `110 Diamantes`.
 * Si el nombre no empieza por el juego se deja tal cual.
 */
export function centralOneOfferLabel(name: string, familyName: string): string {
  const full = (name ?? '').trim();
  const family = asciiFold((familyName ?? '').trim());
  if (!family) return full;
  const segments = full.split(/\s+·\s+/);
  if (segments.length > 1 && asciiFold(segments[0]).startsWith(family)) {
    const rest = segments.slice(1).join(' · ').trim();
    if (rest) return rest;
  }
  if (asciiFold(full).startsWith(family)) {
    const rest = full.slice(familyName.trim().length).replace(/^[\s·:\-–—]+/, '').trim();
    if (rest) return rest;
  }
  return full;
}

/** Nombres en inglés de las tarjetas de Free Fire → como las conoce el cliente. */
function spanishFreeFireName(label: string): string {
  const normalized = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/weekly\s+lite/.test(normalized)) return 'Tarjeta Semanal Lite';
  if (/weekly\s+(membership|card)/.test(normalized)) return 'Tarjeta Semanal';
  if (/monthly\s+(membership|card)/.test(normalized)) return 'Tarjeta Mensual';
  if (/booyah\s+pass\s+card/.test(normalized)) return 'Tarjeta Pase Booyah';
  return label;
}

/**
 * Cantidad y bono de la oferta: `7740 + 1548 Diamonds` → 7740/1548. Si no
 * empieza por número se toma el primero que aparezca (`Gold 100`); sin número
 * → `amount: null` (la oferta es un pase, tarjeta, etc.).
 */
export function parseOfferAmount(label: string): { amount: number | null; bonus: number } {
  const toInt = (raw: string | undefined) => {
    if (!raw) return 0;
    const n = Number.parseInt(raw.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  };
  const leading = (label ?? '').match(/^\s*(\d[\d.,]*)\s*(?:\+\s*(\d[\d.,]*))?/);
  if (leading) {
    const amount = toInt(leading[1]);
    return { amount: amount > 0 ? amount : null, bonus: toInt(leading[2]) };
  }
  const anywhere = (label ?? '').replace(/,/g, '').match(/\b(\d{1,7})\b/);
  if (anywhere) {
    const amount = Number(anywhere[1]);
    return { amount: amount > 0 ? amount : null, bonus: 0 };
  }
  return { amount: null, bonus: 0 };
}

/** Nivel de una subida de nivel (`Level Up 6`, `Subida de nivel 10`, `Lvl 30`). */
function levelOf(label: string): number | null {
  const match = label.match(/(?:nivel|level(?:\s*up)?|lvl)\s*(\d{1,3})/i);
  return match ? Number(match[1]) : null;
}

const LEVEL_UP_PASS = /level\s*up\s*pass/i;
const LEVEL_UP = /\b(level\s*up|subida\s+de\s+nivel|nivel\s*\d+|lvl\s*\d*)\b/i;
const SPECIAL_WORDS =
  /\b(pass|pase|membership|membres[ií]a|card|tarjeta|bundle|cofre|chest|bag|bolsa|evo|subscription|suscripci[oó]n|weekly|monthly|semanal|mensual)\b/i;

/**
 * Naturaleza comercial de una oferta (D5).
 *
 *  - `level_up`: subidas de nivel. El «Level Up Pass» de Blood Strike NO lo es
 *    (es un pase de temporada) y va como `special`.
 *  - `special`: pases, tarjetas, membresías, cofres… o cualquier oferta sin
 *    cantidad legible. Las gift cards siempre.
 *  - `package`: el resto (cantidades de moneda del juego).
 */
export function classifyCentralOneKind(label: string, family: CoFamily = 'topup'): ProductKind {
  if (family === 'gift_card') return 'special';
  const name = label ?? '';
  if (LEVEL_UP_PASS.test(name)) return 'special';
  if (LEVEL_UP.test(name)) return 'level_up';
  if (SPECIAL_WORDS.test(name)) return 'special';
  return parseOfferAmount(name).amount === null ? 'special' : 'package';
}

/**
 * Tarjeta o membresía semanal/mensual de Free Fire (incluida la «básica
 * semanal»). Se crean apagadas (`adminDisabled`) en los tres Free Fire: el
 * cliente decide cuándo venderlas.
 */
export function isFreeFireCard(familyName: string, label: string): boolean {
  return FREE_FIRE_NAME.test(familyName ?? '') && /\b(weekly|monthly|semanal|mensual)\b/i.test(label ?? '');
}

/** Orden inicial en portada por nombre (sólo al crear; luego manda el admin). */
const SORT_PRIORITY: Record<CoFamily, Array<[RegExp, number]>> = {
  topup: [
    [/free\s*fire/i, 10],
    [/blood\s*strike/i, 20],
    [/pubg/i, 30],
    [/mobile\s*legends/i, 40],
    [/delta\s*force/i, 50],
    [/genshin/i, 60],
    [/farlight/i, 70],
  ],
  gift_card: [
    [/google\s*play/i, 10],
    [/app\s*store|itunes/i, 20],
    [/steam/i, 40],
    [/roblox/i, 50],
  ],
};

export function centralOneGameSortOrder(family: CoFamily, name: string): number {
  for (const [pattern, order] of SORT_PRIORITY[family]) {
    if (pattern.test(name)) return order;
  }
  return 100;
}

/** Moneda del juego (palabra que acompaña la cantidad) → etiqueta e icono. */
const CURRENCY_WORDS: Record<string, { label: string; icon: string }> = {
  diamond: { label: 'Diamantes', icon: '💎' },
  diamonds: { label: 'Diamantes', icon: '💎' },
  diamantes: { label: 'Diamantes', icon: '💎' },
  gold: { label: 'Oro', icon: '🪙' },
  oro: { label: 'Oro', icon: '🪙' },
  uc: { label: 'UC', icon: '🪙' },
  cp: { label: 'CP', icon: '🪙' },
  coin: { label: 'Monedas', icon: '🪙' },
  coins: { label: 'Monedas', icon: '🪙' },
  monedas: { label: 'Monedas', icon: '🪙' },
  gem: { label: 'Gemas', icon: '💎' },
  gems: { label: 'Gemas', icon: '💎' },
  gemas: { label: 'Gemas', icon: '💎' },
  token: { label: 'Tokens', icon: '🎟️' },
  tokens: { label: 'Tokens', icon: '🎟️' },
  crystal: { label: 'Cristales', icon: '🔮' },
  crystals: { label: 'Cristales', icon: '🔮' },
  primogems: { label: 'Protogemas', icon: '💎' },
  points: { label: 'Puntos', icon: '🎯' },
  credits: { label: 'Créditos', icon: '🪙' },
};

/** Icono de moneda ya publicado en la tienda para los juegos conocidos. */
const KNOWN_CURRENCY_ICON: Array<[RegExp, string]> = [
  [/free\s*fire/i, '/coins/diamante-freefire.svg'],
  [/blood\s*strike/i, '/coins/gold-bloodstrike.svg'],
  [/mobile\s*legends/i, '/coins/diamante-mlbb.svg'],
];

function currencyFor(family: CoFamily, familyName: string, labels: string[]): { label: string; icon: string; iconUrl: string } {
  const iconUrl = KNOWN_CURRENCY_ICON.find(([pattern]) => pattern.test(familyName))?.[1] ?? '';
  if (family === 'gift_card') return { label: FAMILY_META.gift_card.label, icon: FAMILY_META.gift_card.icon, iconUrl: '' };
  const counts = new Map<string, number>();
  for (const label of labels) {
    const match = label.match(/^\s*\d[\d.,]*\s*(?:\+\s*\d[\d.,]*)?\s+([A-Za-zÁÉÍÓÚáéíóú]+)/);
    const word = match?.[1]?.toLowerCase();
    if (word && CURRENCY_WORDS[word]) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [word, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = word;
  }
  const meta = best ? CURRENCY_WORDS[best] : { label: FAMILY_META.topup.label, icon: FAMILY_META.topup.icon };
  return { ...meta, iconUrl };
}

// ---------------------------------------------------------------------------
// Campos del comprador (D7)
// ---------------------------------------------------------------------------

/** Un campo tal como lo declara Central One (`target_schema`), ya filtrado por `target_fields`. */
export interface CentralOneFieldSpec {
  key: string;
  label?: string | null;
  type?: string | null;
  options?: unknown;
}

/** Clave del proveedor → etiqueta, cuando `target_schema` trae `label: null` (pasa a menudo). */
const FIELD_KEY_LABELS: Record<string, string> = {
  player_id: 'ID de jugador',
  game_user_id: 'ID de jugador',
  server_id: 'Servidor / Zone ID',
  zone_id: 'Servidor / Zone ID',
  game_zone_id: 'Servidor / Zone ID',
  riot_id: 'Riot ID',
  username: 'Usuario',
  email: 'Correo',
};

function humanizeKey(key: string): string {
  const words = key.replace(/[_\-.]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOptions(raw: unknown): PlayerFieldOption[] {
  if (!Array.isArray(raw)) return [];
  const out: PlayerFieldOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let value: string | null = null;
    let label: string | null = null;
    if (typeof item === 'string' || typeof item === 'number') {
      value = String(item);
      label = String(item);
    } else if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      value = text(obj.value ?? obj.id ?? obj.key ?? obj.code);
      label = text(obj.label ?? obj.name ?? obj.title) ?? value;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label: label ?? value });
  }
  return out;
}

function defaultPattern(key: string, options: PlayerFieldOption[]): string {
  if (options.length > 0) return `^(${options.map((option) => escapeRegex(option.value)).join('|')})$`;
  const lower = key.toLowerCase();
  return lower.includes('id') && !lower.includes('riot') ? '^\\d{1,30}$' : '^.{1,120}$';
}

export function isBloodStrike(idOrName?: string | null): boolean {
  if (!idOrName) return false;
  const s = idOrName.toLowerCase();
  return (
    s === 'blood-strike' ||
    s === 'bloodstrike' ||
    s.includes('blood-strike') ||
    s.includes('bloodstrike') ||
    s.includes('blood_strike') ||
    /blood\s*strike/i.test(s)
  );
}

/**
 * Campos del comprador de un juego de Central One.
 *
 * `key` es la clave del proveedor tal cual (`player_id`, `server_id`…): así
 * `order.playerFields` ya viaja con los nombres que pide `target_payload`.
 * La primera clave alimenta `order.playerId` y la segunda `order.playerId2`
 * (lo que usan la UI antigua, el chatbot y la caché de validación).
 *
 * Si el juego ya existe se conserva lo que editó el admin por clave (etiqueta,
 * ayuda, placeholder, patrón, obligatorio, sensible); el proveedor manda en
 * `type`/`options` y en qué claves se piden. Las claves que el proveedor ya no
 * pide se quitan; los campos que añadió el admin y que no son claves de Central
 * One (`knownProviderKeys`) se conservan al final.
 */
export function buildCentralOnePlayerFields(
  specs: CentralOneFieldSpec[],
  existing: PlayerField[] = [],
  knownProviderKeys: Iterable<string> = [],
  gameId?: string
): PlayerField[] {
  if (isBloodStrike(gameId)) {
    const previous = existing[0];
    return [
      {
        key: 'game_user_id',
        label: previous?.label || 'ID de jugador',
        pattern: previous?.pattern || '^\\d{1,30}$',
        help: previous?.help || 'Revisa este dato antes de pagar: una entrega al identificador equivocado no se puede recuperar.',
        placeholder: previous?.placeholder || 'Ej: 3363122817',
        type: 'text',
        providerField: 'player_id',
        required: true,
        sensitive: false,
      },
    ];
  }
  const previousByKey = new Map(existing.map((field) => [field.key, field]));
  const providerKeys = new Set<string>();
  const fields: PlayerField[] = [];

  for (const spec of specs) {
    const key = text(spec?.key);
    if (!key || providerKeys.has(key)) continue;
    providerKeys.add(key);
    const index = providerKeys.size - 1;
    const options = spec.type === 'select' ? normalizeOptions(spec.options) : [];
    const isSelect = options.length > 0;
    const autoPattern = defaultPattern(key, options);
    const previous = previousByKey.get(key);
    const field: PlayerField = {
      key,
      label: previous?.label || text(spec.label) || FIELD_KEY_LABELS[key] || humanizeKey(key),
      // Con lista cerrada el patrón sale de las opciones: si el proveedor
      // añade una, un patrón viejo rechazaría un valor válido.
      pattern: isSelect ? autoPattern : previous?.pattern || autoPattern,
      help: previous?.help ?? FIELD_HELP,
      placeholder: previous?.placeholder ?? '',
      type: isSelect ? 'select' : 'text',
      providerField: index === 0 ? 'player_id' : index === 1 ? 'player_id2' : null,
      required: previous?.required ?? true,
      sensitive: previous?.sensitive ?? false,
    };
    if (isSelect) field.options = options;
    fields.push(field);
  }

  const known = new Set(knownProviderKeys);
  const taken = new Set(fields.map((field) => field.providerField).filter(Boolean));
  for (const extra of existing) {
    if (providerKeys.has(extra.key) || known.has(extra.key)) continue;
    // Un campo del admin no puede quitarle el `player_id` al del proveedor:
    // el despacho y la caché leerían el dato equivocado.
    const collides = extra.providerField !== null && taken.has(extra.providerField);
    fields.push(collides ? { ...extra, providerField: null } : extra);
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Catálogo → juegos y productos (función pura)
// ---------------------------------------------------------------------------

/** Una oferta de Central One lista para escribirse como producto. */
export interface CentralOneOffer {
  /** Id del doc `products/{id}`. */
  docId: string;
  /** `product_id` de Central One. */
  productId: string;
  sku: string;
  label: string;
  description: string;
  costUsd: number;
  stock: number | null;
  /** `status === 'active'` y con stock (o stock no informado). */
  providerAvailable: boolean;
  kind: ProductKind;
  amount: number;
  bonus: number;
  /** Claves de `target_payload` (`[]` en gift cards). */
  targetFields: string[];
  isFreeFireCard: boolean;
  sortOrder: number;
  badge: string | null;
  deliveryEtaMinutes: number;
}

/** Un juego de Central One listo para escribirse. */
export interface CentralOneGamePlan {
  id: string;
  family: CoFamily;
  familyId: string;
  familyName: string;
  region: string;
  /** Nombre al crear (después manda el admin). */
  name: string;
  apiGameId: string;
  /** Free Fire LATAM de Central One: se crea apagado y recibe los extras. */
  isFreeFireLatam: boolean;
  playerFields: PlayerField[];
  /** Unión de las claves pedidas por sus productos, en orden. */
  targetFields: string[];
  validatesPlayerId: boolean;
  currency: { label: string; icon: string; iconUrl: string };
  sortOrder: number;
  offers: CentralOneOffer[];
  /** Firmas de campos distintas entre sus productos (diagnóstico). */
  fieldSignatures: number;
}

export interface CentralOneMapping {
  games: CentralOneGamePlan[];
  /** Docs de productos cuyo ítem está inactivo en Central One (se apagan si existen). */
  inactiveProductIds: string[];
  /** Ítems descartados por motivo. */
  skipped: Record<string, number>;
  itemsMapped: number;
  gamesByFamily: Record<CoFamily, number>;
  freeFireLatamGameId: string | null;
}

/** Lo que ya existe y la función pura necesita para no pisar al admin. */
export interface CentralOneExisting {
  /** Juegos `co-*` publicados, por id de doc (sólo se usan sus `playerFields`). */
  games?: ReadonlyMap<string, Pick<Game, 'playerFields'> | Partial<Game>>;
}

function needsPassword(item: Pick<CoCatalogItem, 'target_fields' | 'target_schema'>): boolean {
  const keys = [
    ...(Array.isArray(item.target_fields) ? item.target_fields : []),
    ...(Array.isArray(item.target_schema) ? item.target_schema.map((field) => field?.key) : []),
  ];
  return keys.some((key) => typeof key === 'string' && /password/i.test(key));
}

function targetFieldsOf(item: Pick<CoCatalogItem, 'target_fields'>): string[] {
  if (!Array.isArray(item.target_fields)) return [];
  const out: string[] = [];
  for (const key of item.target_fields) {
    const clean = text(key);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function stockOf(item: Pick<CoCatalogItem, 'in_stock' | 'available_stock'>): number | null {
  if (item.in_stock === false) return 0;
  const available = item.available_stock;
  // `null` = Central One no informa el inventario (no es «cero»).
  return typeof available === 'number' && Number.isFinite(available) ? Math.max(0, Math.floor(available)) : null;
}

function offerDescription(family: CoFamily, kind: ProductKind, gameName: string): string {
  if (family === 'gift_card') return 'Código digital para canjear en la región indicada.';
  if (kind === 'level_up') return `Subida de nivel automática de ${gameName}. Se carga directamente a tu cuenta con tu ID.`;
  return `Recarga automática de ${gameName}.`;
}

/**
 * Convierte el catálogo de Central One en juegos y productos de la tienda.
 * Pura: no lee ni escribe nada.
 *
 *  - Un juego por `(familia, product_family_id, región)`. Nombre = el de la
 *    familia, con « (REGIÓN)» si no es GLOBAL o si la familia se vende en más
 *    de una región visible. El Free Fire LATAM se llama sólo «Free Fire».
 *  - Descarta (y cuenta en `skipped`): sin `product_id`, inactivos, categoría
 *    desconocida, regiones fuera de Latinoamérica, los que piden contraseña,
 *    recargas sin campos, moneda distinta de USD, duplicados y precio inválido.
 *  - Free Fire LATAM NO se excluye (a diferencia de Erylax): pasa a ser el
 *    Free Fire de Central One, que se crea apagado.
 *  - Los campos del juego son la unión de los que piden sus productos; cada
 *    producto manda sólo los suyos (`targetFields`).
 */
export function mapCentralOneCatalog(
  items: CoCatalogItem[],
  coverageIds: Iterable<string> = [],
  existing: CentralOneExisting = {}
): CentralOneMapping {
  const covered = new Set(coverageIds);
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  // Todas las claves que Central One usa en algún producto: sirve para
  // distinguir un campo del proveedor que dejó de pedirse de uno del admin.
  const knownProviderKeys = new Set<string>();
  const regionsByFamily = new Map<string, Set<string>>();
  const groups = new Map<string, { family: CoFamily; familyId: string; region: string; items: CoCatalogItem[] }>();
  const seenIds = new Set<string>();
  const inactiveProductIds = new Set<string>();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') {
      skip('invalid');
      continue;
    }
    for (const key of targetFieldsOf(item)) knownProviderKeys.add(key);
    if (Array.isArray(item.target_schema)) {
      for (const spec of item.target_schema) {
        const key = text(spec?.key);
        if (key) knownProviderKeys.add(key);
      }
    }

    const productId = text(item.product_id);
    if (!productId) {
      skip('no_product_id');
      continue;
    }
    const family = CO_CATEGORY_FAMILY[String(item.category ?? '')];
    if (item.status !== 'active') {
      skip('inactive');
      // Si ya se publicó, se apaga (no se marca retirado: sigue en el catálogo).
      if (family) inactiveProductIds.add(coProductId(coGameId(family, familyIdOf(item), coRegion(item)), productId));
      continue;
    }
    if (!family) {
      skip('unknown_category');
      continue;
    }
    const familyId = familyIdOf(item);
    const region = coRegion(item);
    const familyName = text(item.product_family_name) ?? text(item.name) ?? familyId;
    if (!visibleInLatam(family, familyName, null, region)) {
      skip('region');
      continue;
    }
    // Regiones visibles por familia (antes de los demás filtros) para decidir
    // el sufijo del nombre: «Free Fire (BR)» sólo si hay más de una.
    const familyKey = `${family}|${familyId}`;
    if (!regionsByFamily.has(familyKey)) regionsByFamily.set(familyKey, new Set());
    regionsByFamily.get(familyKey)!.add(region);

    if (needsPassword(item)) {
      skip('password_field');
      continue;
    }
    if (family === 'topup' && targetFieldsOf(item).length === 0) {
      skip('no_target');
      continue;
    }
    const currency = (text(item.currency) ?? 'USD').toUpperCase();
    if (currency !== 'USD') {
      // `costUsd` asume dólares: un precio en otra moneda saldría mal.
      skip('currency');
      continue;
    }
    if (seenIds.has(productId)) {
      skip('duplicate');
      continue;
    }
    seenIds.add(productId);

    const groupKey = `${family}|${familyId}|${region}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { family, familyId, region, items: [] });
    groups.get(groupKey)!.items.push(item);
  }

  const plans: CentralOneGamePlan[] = [];
  let itemsMapped = 0;

  for (const group of groups.values()) {
    const { family, familyId, region } = group;
    const id = coGameId(family, familyId, region);
    const familyName = text(group.items[0].product_family_name) ?? familyId;
    const isFreeFireLatam = family === 'topup' && FREE_FIRE_NAME.test(familyName) && region === 'LATAM';
    const isBloodStrikeGame = family === 'topup' && isBloodStrike(`${id} ${familyId} ${familyName}`);
    const multiRegion = (regionsByFamily.get(`${family}|${familyId}`)?.size ?? 1) > 1;
    const name = isFreeFireLatam
      ? 'Free Fire'
      : region !== 'GLOBAL' || multiRegion
        ? `${familyName} (${region})`
        : familyName;

    const specs: CentralOneFieldSpec[] = [];
    const specKeys = new Set<string>();
    const signatures = new Set<string>();
    const offers: CentralOneOffer[] = [];
    let validates = false;

    for (const item of group.items) {
      const costUsd = centralOne.parseAmount(item.reseller_price);
      if (costUsd === null || costUsd <= 0) {
        skip('invalid_price');
        continue;
      }
      const targetFields = family === 'topup' ? targetFieldsOf(item) : [];
      if (family === 'topup') {
        signatures.add(targetFields.join(','));
        if (isBloodStrikeGame) {
          if (!specKeys.has('game_user_id')) {
            specKeys.add('game_user_id');
            specs.push({ key: 'game_user_id', label: 'ID de jugador', type: 'text', options: null });
          }
        } else {
          const schema = Array.isArray(item.target_schema) ? item.target_schema : [];
          // Orden de `target_schema`, restringido a lo que de verdad se manda.
          const ordered = [
            ...schema.map((spec) => text(spec?.key)).filter((key): key is string => !!key && targetFields.includes(key)),
            ...targetFields,
          ];
          for (const key of ordered) {
            if (specKeys.has(key)) continue;
            specKeys.add(key);
            const spec = schema.find((candidate) => text(candidate?.key) === key);
            specs.push({ key, label: spec?.label ?? null, type: spec?.type ?? 'text', options: spec?.options ?? null });
          }
        }
        if (covered.has(item.product_id)) validates = true;
      }

      const rawLabel = centralOneOfferLabel(String(item.name ?? ''), familyName) || String(item.name ?? '');
      const card = isFreeFireCard(familyName, `${item.name ?? ''} ${rawLabel}`);
      const label = FREE_FIRE_NAME.test(familyName) ? spanishFreeFireName(rawLabel) : rawLabel;
      const kind = classifyCentralOneKind(rawLabel, family);
      const parsed = parseOfferAmount(rawLabel);
      const amount =
        family === 'gift_card'
          ? 1
          : kind === 'level_up'
            ? levelOf(rawLabel) ?? parsed.amount ?? 0
            : parsed.amount ?? 0;
      const stock = stockOf(item);
      offers.push({
        docId: coProductId(id, item.product_id),
        productId: item.product_id,
        sku: `CO-${family === 'topup' ? 'TOP' : 'GIFT'}-${item.product_id}`.slice(0, 40),
        label,
        description: offerDescription(family, kind, isFreeFireLatam ? 'Free Fire' : familyName),
        costUsd,
        stock,
        providerAvailable: stock === null || stock > 0,
        kind,
        amount,
        bonus: family === 'topup' ? parsed.bonus : 0,
        targetFields,
        isFreeFireCard: card,
        sortOrder: family === 'topup' ? amount || 99 : 99,
        badge: family === 'gift_card' ? 'GIFT CARD' : null,
        deliveryEtaMinutes: family === 'topup' ? 2 : 5,
      });
    }
    if (offers.length === 0) continue;
    offers.sort((a, b) => a.costUsd - b.costUsd || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    itemsMapped += offers.length;

    const previousFields = (existing.games?.get(id)?.playerFields ?? []) as PlayerField[];
    plans.push({
      id,
      family,
      familyId,
      familyName,
      region,
      name,
      apiGameId: `co-${familyId}-${region}`,
      isFreeFireLatam,
      playerFields: family === 'topup' ? buildCentralOnePlayerFields(specs, previousFields, knownProviderKeys, id) : [],
      targetFields: family === 'topup' ? specs.map((spec) => spec.key) : [],
      validatesPlayerId: family === 'topup' && validates,
      currency: currencyFor(family, familyName, offers.map((offer) => offer.label)),
      sortOrder: centralOneGameSortOrder(family, familyName),
      offers,
      fieldSignatures: signatures.size,
    });
  }

  plans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Si Central One tuviera dos familias «Free Fire» en LATAM, gana la de más
  // ofertas: es la que recibe los extras y la que se guarda como referencia.
  const freeFire = plans
    .filter((plan) => plan.isFreeFireLatam)
    .sort((a, b) => b.offers.length - a.offers.length)[0];

  return {
    games: plans,
    inactiveProductIds: Array.from(inactiveProductIds),
    skipped,
    itemsMapped,
    gamesByFamily: {
      topup: plans.filter((plan) => plan.family === 'topup').length,
      gift_card: plans.filter((plan) => plan.family === 'gift_card').length,
    },
    freeFireLatamGameId: freeFire?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Freno de seguridad
// ---------------------------------------------------------------------------

export interface CentralOneSanityVerdict {
  /** Motivo para no escribir NADA (`empty_catalog`, `catalog_suspicious`) o `null`. */
  abort: string | null;
  message: string | null;
  /** Familias sin ninguna categoría mapeada: no se marcan retirados en ellas. */
  skipRemoval: CoFamily[];
}

/**
 * Red de seguridad antes de escribir: un catálogo vacío o que de golpe trae
 * menos de la mitad de los juegos que hoy se venden huele a fallo del
 * proveedor, no a que retiró media tienda.
 */
export function centralOneSanityCheck(input: {
  itemsReceived: number;
  mappedByFamily: Record<CoFamily, number>;
  /** Juegos `co-*` activos y no retirados, por familia. */
  activeByFamily: Record<CoFamily, number>;
}): CentralOneSanityVerdict {
  if (input.itemsReceived === 0) {
    return {
      abort: 'empty_catalog',
      message: 'Central One devolvió un catálogo vacío; se conservó el catálogo anterior.',
      skipRemoval: ['topup', 'gift_card'],
    };
  }
  const skipRemoval: CoFamily[] = [];
  for (const family of ['topup', 'gift_card'] as CoFamily[]) {
    const mapped = input.mappedByFamily[family] ?? 0;
    const active = input.activeByFamily[family] ?? 0;
    if (active >= SANITY_MIN_ACTIVE_GAMES && mapped < active * 0.5) {
      return {
        abort: 'catalog_suspicious',
        message: `Central One trae ${mapped} juegos de ${FAMILY_META[family].label} y hoy hay ${active} activos; se conservó el catálogo anterior.`,
        skipRemoval: ['topup', 'gift_card'],
      };
    }
    if (mapped === 0) skipRemoval.push(family);
  }
  return { abort: null, message: null, skipRemoval };
}

// ---------------------------------------------------------------------------
// Presentación heredada de FazerCards
// ---------------------------------------------------------------------------

export interface GamePresentation {
  logoUrl: string;
  coverUrl: string;
  accentColor: string;
  accentColorSecondary: string;
  currencyIconUrl: string;
}

/**
 * Imágenes y colores para un juego NUEVO de Central One (no trae imágenes):
 * se copian del juego `fz-*` del mismo nombre, prefiriendo misma familia y
 * región y uno con logo. El Free Fire LATAM hereda de `fz-topup-free-fire-latam`.
 */
export function pickFazerPresentation(
  plan: Pick<CentralOneGamePlan, 'family' | 'familyName' | 'region' | 'isFreeFireLatam'>,
  fazerGames: ReadonlyMap<string, Partial<Game>>
): Partial<GamePresentation> | null {
  let source: Partial<Game> | undefined;
  if (plan.isFreeFireLatam) source = fazerGames.get(FAZER_FREE_FIRE_GAME_ID);
  if (!source) {
    const target = normalizeGameBaseName(plan.familyName);
    if (!target) return null;
    const candidates = Array.from(fazerGames.values()).filter(
      (game) => normalizeGameBaseName(String(game.name ?? '')) === target
    );
    if (candidates.length === 0) return null;
    const score = (game: Partial<Game>) =>
      (game.providerFamily === plan.family ? 4 : 0) +
      (String(game.region ?? '').trim().toUpperCase() === plan.region ? 2 : 0) +
      (game.logoUrl ? 1 : 0);
    source = candidates.sort((a, b) => score(b) - score(a))[0];
  }
  const out: Partial<GamePresentation> = {};
  if (source.logoUrl) out.logoUrl = source.logoUrl;
  if (source.coverUrl) out.coverUrl = source.coverUrl;
  if (source.accentColor) out.accentColor = source.accentColor;
  if (source.accentColorSecondary) out.accentColorSecondary = source.accentColorSecondary;
  if (source.currencyIconUrl) out.currencyIconUrl = source.currencyIconUrl;
  return out;
}

// ---------------------------------------------------------------------------
// Extras de Free Fire (D10, planificación pura)
// ---------------------------------------------------------------------------

/** Producto existente de un juego, lo mínimo para decidir y clonar. */
export type ExistingProduct = Partial<Product> & { id: string };

export interface FreeFireExtrasInput {
  /** Familia Free Fire LATAM de Central One; `null` = no hay y no se hace nada. */
  freeFire: Pick<CentralOneGamePlan, 'id' | 'targetFields' | 'offers'> | null;
  /** Productos actuales de `free-fire` y `freefire-id` (`null` = el juego no existe). */
  inefableProducts: Record<string, ExistingProduct[] | null>;
  /** Ids de productos que ya existen fuera de esas listas (p. ej. el combo del juego CO). */
  existingIds: ReadonlySet<string>;
  /** Marcador `privateConfig/centralOne.extras`: lo que ya se creó una vez. */
  marker: ReadonlySet<string>;
  pricing: { marginPercent: number; roundToUsd: number };
  timestamp: unknown;
}

export interface PlannedExtra {
  id: string;
  gameId: string;
  /** `catalog` = oferta de Central One (b), `combo` = nivel completo (c), `clone` = copia de `free-fire` (d). */
  source: 'catalog' | 'combo' | 'clone';
  data: Record<string, unknown>;
}

export interface FreeFireExtrasPlan {
  creates: PlannedExtra[];
  notes: string[];
}

function packageIdsOf(product: Pick<Product, 'calls'> | Partial<Product>): string[] {
  return Array.isArray(product.calls) ? product.calls.map((call) => String(call?.packageId ?? '')).filter(Boolean) : [];
}

function extraImage(label: string, kind: ProductKind): string {
  if (kind === 'level_up') return '/products/aumento-nivel.svg';
  if (/weekly|semanal/i.test(label)) return '/products/tarjeta-semanal.svg';
  if (/monthly|mensual/i.test(label)) return '/products/tarjeta-mensual.svg';
  if (/booyah/i.test(label)) return '/products/pase-booyah.svg';
  return '';
}

/** Copia de un producto de `free-fire` para otro juego, sin campos de sistema. */
function cloneProduct(
  source: ExistingProduct,
  gameId: string,
  timestamp: unknown,
  calls: DispatchCall[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const { id: _id, createdAt: _c, updatedAt: _u, providerSyncedAt: _p, ...rest } = source;
  void _id;
  void _c;
  void _u;
  void _p;
  return {
    ...rest,
    gameId,
    sku: `${source.sku ?? 'FF-CO'}-${gameId === INEFABLE_FREE_FIRE_ID_NEW ? 'ID' : 'CO'}`.slice(0, 40),
    provider: 'centralone',
    calls,
    centralOneExtra: true,
    centralOneLinkedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}

/**
 * Decide qué productos extra de Free Fire crear (D10). Pura.
 *
 *  b) Cada subida de nivel o pase/tarjeta de la familia Free Fire LATAM de
 *     Central One se añade a `free-fire` y `freefire-id` como
 *     `${gameId}--co-${slug(product_id)}`, salvo que el juego ya tenga un
 *     producto con ese `packageId` (p. ej. los `ff-co-nivel-*` sembrados). Sin
 *     `targetFields`: el despacho usa la heurística de Free Fire con el ID.
 *  c) El combo `ff-co-nivel-completo` se clona a `freefire-id` y al Free Fire
 *     de Central One (este con `targetFields`, porque su id no dice «free-fire»
 *     y la heurística por slug no lo reconocería).
 *  d) Los `ff-co-nivel-*` y `ff-m-pase-booyah` de `free-fire` se clonan a
 *     `freefire-id` si nada de lo anterior ya cubre su `packageId`.
 *
 * Nunca se recrea lo que está en el marcador (si el admin lo borró, se
 * respeta) ni se pisa un doc existente.
 */
export function planFreeFireExtras(input: FreeFireExtrasInput): FreeFireExtrasPlan {
  const creates: PlannedExtra[] = [];
  const notes: string[] = [];
  if (!input.freeFire) {
    notes.push('Central One no trae Free Fire LATAM: no se crearon extras.');
    return { creates, notes };
  }
  const ff = input.freeFire;
  const ts = input.timestamp;
  const blocked = (id: string) =>
    input.marker.has(id) || input.existingIds.has(id) || creates.some((planned) => planned.id === id);

  // packageIds ya cubiertos por juego (existentes + planificados en esta pasada).
  const covered = new Map<string, Set<string>>();
  for (const gameId of INEFABLE_FREE_FIRE_GAME_IDS) {
    const list = input.inefableProducts[gameId];
    const set = new Set<string>();
    for (const product of list ?? []) {
      for (const packageId of packageIdsOf(product)) set.add(packageId);
      // El doc existe aunque no esté en `existingIds`.
    }
    covered.set(gameId, set);
  }
  const existsInGame = (gameId: string, id: string) =>
    (input.inefableProducts[gameId] ?? []).some((product) => product.id === id);
  // Lo que el marcador dice que ya se creó una vez también cubre su
  // `packageId`, aunque el admin haya borrado el doc: si no, b) y d) se
  // relevan y uno recrea con otro id lo que el admin quitó del otro. El
  // marcador sólo guarda ids, así que el `packageId` se deduce de cómo se
  // nombra cada extra (`--co-${slug(product_id)}` en b, `--${idOriginal}` en d).
  const freeFireSources = (input.inefableProducts[INEFABLE_FREE_FIRE_ID] ?? []).filter(
    (product) =>
      (product.id.startsWith('ff-co-nivel-') && product.id !== FREE_FIRE_LEVEL_COMBO_ID) ||
      product.id === 'ff-m-pase-booyah'
  );
  const catalogExtraId = (gameId: string, packageId: string) => `${gameId}--co-${slugify(packageId) || 'x'}`;
  {
    const idSet = covered.get(INEFABLE_FREE_FIRE_ID_NEW);
    if (idSet) {
      for (const source of freeFireSources) {
        if (!input.marker.has(`${INEFABLE_FREE_FIRE_ID_NEW}--${source.id}`)) continue;
        for (const packageId of packageIdsOf(source)) idSet.add(packageId);
      }
    }
  }

  // --- b) Ofertas de Central One ---
  const extras = ff.offers.filter((offer) => offer.kind === 'level_up' || offer.kind === 'special');
  for (const gameId of INEFABLE_FREE_FIRE_GAME_IDS) {
    if (input.inefableProducts[gameId] === null) {
      notes.push(`El juego ${gameId} no existe: no se le añadieron extras.`);
      continue;
    }
    const set = covered.get(gameId)!;
    let specialIndex = 0;
    for (const offer of extras) {
      const order = offer.kind === 'level_up' ? offer.amount || 99 : 900 + specialIndex++;
      if (set.has(offer.productId)) continue;
      const id = catalogExtraId(gameId, offer.productId);
      if (input.marker.has(id)) {
        // Ya se creó una vez (quizá el admin lo borró): cubre su `packageId`
        // para que d) no lo traiga de vuelta como clon.
        set.add(offer.productId);
        continue;
      }
      if (blocked(id) || existsInGame(gameId, id)) continue;
      if (!offer.providerAvailable) {
        // Un extra no tiene `providerSyncedAt` y la sync no lo vuelve a mirar:
        // creado hoy quedaría a la venta aunque Central One no lo entregue.
        // Se espera a que haya stock (no entra al marcador, así que una sync
        // posterior lo crea) y mientras tanto cubre su `packageId` para que d)
        // tampoco ponga a la venta en `freefire-id` algo que no se entrega.
        set.add(offer.productId);
        notes.push(`${id}: Central One no tiene disponible ${offer.productId}; se creará cuando haya stock.`);
        continue;
      }
      set.add(offer.productId);
      const calls: DispatchCall[] = [{ packageId: offer.productId, quantity: 1, provider: 'centralone' }];
      creates.push({
        id,
        gameId,
        source: 'catalog',
        data: {
          gameId,
          sku: `CO-FF-${offer.productId}`.slice(0, 40),
          name: offer.label,
          description:
            offer.kind === 'level_up'
              ? 'Subida de nivel de Free Fire. Se carga directamente a tu cuenta con tu ID.'
              : `${offer.label} de Free Fire. Se carga directamente a tu cuenta con tu ID.`,
          fulfillment: 'auto',
          manualFlow: 'notify',
          kind: offer.kind,
          amount: offer.amount,
          bonus: 0,
          costUsd: offer.costUsd,
          priceUsd: applyMargin(offer.costUsd, input.pricing.marginPercent, input.pricing.roundToUsd),
          compareAtUsd: null,
          calls,
          imageUrl: extraImage(offer.label, offer.kind),
          badge: null,
          active: !offer.isFreeFireCard,
          adminDisabled: offer.isFreeFireCard,
          featured: false,
          sortOrder: order,
          // Sin `providerSyncedAt` la sync no vuelve a mirarlo: un stock de
          // hoy congelado para siempre lo dejaría agotado. Se deja ilimitado.
          stock: null,
          deliveryEtaMinutes: 2,
          provider: 'centralone',
          providerOfferId: offer.productId,
          centralOneExtra: true,
          centralOneLinkedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        },
      });
    }
  }

  // --- c) Combo «Subida de Nivel Completo (6 al 30)» ---
  const combo = (input.inefableProducts[INEFABLE_FREE_FIRE_ID] ?? []).find(
    (product) => product.id === FREE_FIRE_LEVEL_COMBO_ID
  );
  if (combo) {
    const baseCalls = (combo.calls ?? []).map((call) => ({
      packageId: call.packageId,
      quantity: 1,
      provider: 'centralone' as const,
    }));
    const comboFields = { kind: 'level_up', sortOrder: combo.sortOrder ?? 200 };
    const idTarget = `${INEFABLE_FREE_FIRE_ID_NEW}--co-nivel-completo`;
    if (input.inefableProducts[INEFABLE_FREE_FIRE_ID_NEW] && !blocked(idTarget) && !existsInGame(INEFABLE_FREE_FIRE_ID_NEW, idTarget)) {
      creates.push({
        id: idTarget,
        gameId: INEFABLE_FREE_FIRE_ID_NEW,
        source: 'combo',
        data: cloneProduct(combo, INEFABLE_FREE_FIRE_ID_NEW, ts, baseCalls, comboFields),
      });
    }
    const coTarget = `${ff.id}--nivel-completo`;
    if (!blocked(coTarget)) {
      const targetFields = [...ff.targetFields];
      creates.push({
        id: coTarget,
        gameId: ff.id,
        source: 'combo',
        data: cloneProduct(
          combo,
          ff.id,
          ts,
          baseCalls.map((call) => ({ ...call, targetFields })),
          { ...comboFields, targetFields }
        ),
      });
    }
  } else {
    notes.push(`No existe ${FREE_FIRE_LEVEL_COMBO_ID} en free-fire: no se clonó el combo de nivel.`);
  }

  // --- d) Clones de los productos de Central One sembrados en free-fire ---
  if (input.inefableProducts[INEFABLE_FREE_FIRE_ID_NEW]) {
    const set = covered.get(INEFABLE_FREE_FIRE_ID_NEW)!;
    for (const source of freeFireSources) {
      const target = `${INEFABLE_FREE_FIRE_ID_NEW}--${source.id}`;
      const packageIds = packageIdsOf(source);
      if (packageIds.length === 0 || packageIds.some((packageId) => set.has(packageId))) continue;
      // Un extra de b) con el mismo `packageId` que se creó y el admin borró
      // (aunque la oferta ya no esté en el catálogo): se respeta.
      if (packageIds.some((packageId) => input.marker.has(catalogExtraId(INEFABLE_FREE_FIRE_ID_NEW, packageId)))) {
        continue;
      }
      if (blocked(target) || existsInGame(INEFABLE_FREE_FIRE_ID_NEW, target)) continue;
      for (const packageId of packageIds) set.add(packageId);
      // El doc vivo de `ff-m-pase-booyah` perdió `provider` en su call: la
      // copia lo lleva explícito para no caer al proveedor por defecto.
      const calls = (source.calls ?? []).map((call) => ({
        packageId: call.packageId,
        quantity: 1,
        provider: 'centralone' as const,
      }));
      creates.push({
        id: target,
        gameId: INEFABLE_FREE_FIRE_ID_NEW,
        source: 'clone',
        data: cloneProduct(source, INEFABLE_FREE_FIRE_ID_NEW, ts, calls),
      });
    }
  }

  return { creates, notes };
}

/**
 * Extras activos de `free-fire`/`freefire-id` cuyo costo en Central One (la
 * suma de sus llamadas, una unidad cada una) ya alcanza su precio. Pura.
 *
 * Los extras no se resincronizan (D10: sin `providerSyncedAt`, ni la sync ni
 * el webhook los tocan), así que una subida de costo los dejaría vendiéndose a
 * pérdida en silencio. No se corrige el precio (el juego es de Inefable y el
 * doc es del admin): se avisa.
 */
export function findExtrasAtLoss(
  inefableProducts: Record<string, ExistingProduct[] | null>,
  offers: Array<Pick<CentralOneOffer, 'productId' | 'costUsd'>>
): string[] {
  const costOf = new Map(offers.map((offer) => [offer.productId, offer.costUsd]));
  const out: string[] = [];
  for (const gameId of INEFABLE_FREE_FIRE_GAME_IDS) {
    for (const product of inefableProducts[gameId] ?? []) {
      if (product.centralOneExtra !== true || product.active === false) continue;
      const packageIds = packageIdsOf(product);
      if (packageIds.length === 0 || !packageIds.every((packageId) => costOf.has(packageId))) continue;
      const cost = packageIds.reduce((sum, packageId) => sum + (costOf.get(packageId) ?? 0), 0);
      const price = Number(product.priceUsd ?? 0);
      if (cost >= price) out.push(product.id);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Combos de Central One (Free Fire LATAM y Blood Strike)
// ---------------------------------------------------------------------------

export interface CentralOneComboSpec {
  idSuffix: string;
  legacyId?: string;
  skuSuffix: string;
  name: string;
  description: string;
  amount: number;
  bonus: number;
  sortOrder: number;
  badge?: string | null;
  /** Cantidades base que componen el combo */
  baseRequirements: number[];
}

export const BLOOD_STRIKE_COMBO_SPECS: CentralOneComboSpec[] = [
  {
    idSuffix: 'c-425',
    legacyId: 'bs-c-425',
    skuSuffix: 'C-425',
    name: '425 Gold',
    description: 'Combo de 425 Gold para Blood Strike (105 + 320 Gold). Recarga rápida y directa a tu cuenta.',
    amount: 400,
    bonus: 25,
    sortOrder: 25,
    badge: 'COMBO',
    baseRequirements: [100, 300], // 105 Gold + 320 Gold
  },
  {
    idSuffix: 'c-860',
    legacyId: 'bs-c-860',
    skuSuffix: 'C-860',
    name: '860 Gold',
    description: 'Combo de 860 Gold para Blood Strike (540 + 320 Gold). Recarga rápida y directa a tu cuenta.',
    amount: 800,
    bonus: 60,
    sortOrder: 48,
    badge: 'COMBO',
    baseRequirements: [500, 300], // 540 Gold + 320 Gold
  },
  {
    idSuffix: 'c-1640',
    legacyId: 'bs-c-1620',
    skuSuffix: 'C-1640',
    name: '1.640 Gold',
    description: 'Combo de 1.640 Gold para Blood Strike (1100 + 540 Gold). Recarga rápida y directa a tu cuenta.',
    amount: 1500,
    bonus: 140,
    sortOrder: 55,
    badge: 'COMBO',
    baseRequirements: [1000, 500], // 1100 Gold + 540 Gold
  },
  {
    idSuffix: 'c-3360',
    legacyId: 'bs-c-3340',
    skuSuffix: 'C-3360',
    name: '3.360 Gold',
    description: 'Combo de 3.360 Gold para Blood Strike (2260 + 1100 Gold). Recarga rápida y directa a tu cuenta.',
    amount: 3000,
    bonus: 360,
    sortOrder: 65,
    badge: 'COMBO',
    baseRequirements: [2000, 1000], // 2260 Gold + 1100 Gold
  },
  {
    idSuffix: 'c-8060',
    legacyId: 'bs-c-8060',
    skuSuffix: 'C-8060',
    name: '8.060 Gold',
    description: 'Combo de 8.060 Gold para Blood Strike (5800 + 2260 Gold). Recarga rápida y directa a tu cuenta.',
    amount: 7000,
    bonus: 1060,
    sortOrder: 75,
    badge: 'COMBO',
    baseRequirements: [5000, 2000], // 5800 Gold + 2260 Gold
  },
];

export const FREE_FIRE_LATAM_COMBO_SPECS: CentralOneComboSpec[] = [
  {
    idSuffix: 'c-451',
    skuSuffix: 'C-451',
    name: '410 + 41 Diamantes',
    description: 'Combo de 451 diamantes (se acredita en 2 recargas seguidas).',
    amount: 410,
    bonus: 41,
    sortOrder: 25,
    badge: 'COMBO',
    baseRequirements: [310, 100],
  },
  {
    idSuffix: 'c-682',
    skuSuffix: 'C-682',
    name: '620 + 62 Diamantes',
    description: 'Combo de 682 diamantes (se acredita en 2 recargas seguidas).',
    amount: 620,
    bonus: 62,
    sortOrder: 35,
    badge: 'COMBO',
    baseRequirements: [520, 100],
  },
  {
    idSuffix: 'c-913',
    skuSuffix: 'C-913',
    name: '830 + 83 Diamantes',
    description: 'Combo de 913 diamantes (se acredita en 2 recargas seguidas).',
    amount: 830,
    bonus: 83,
    sortOrder: 45,
    badge: 'COMBO',
    baseRequirements: [520, 310],
  },
  {
    idSuffix: 'c-1738',
    skuSuffix: 'C-1738',
    name: '1.580 + 158 Diamantes',
    description: 'Combo de 1.738 diamantes (se acredita en 2 recargas seguidas).',
    amount: 1580,
    bonus: 158,
    sortOrder: 48,
    badge: 'COMBO',
    baseRequirements: [1060, 520],
  },
  {
    idSuffix: 'c-3542',
    skuSuffix: 'C-3542',
    name: '3.220 + 322 Diamantes',
    description: 'Combo de 3.542 diamantes (se acredita en 2 recargas seguidas).',
    amount: 3220,
    bonus: 322,
    sortOrder: 55,
    badge: 'COMBO',
    baseRequirements: [2180, 1060],
  },
  {
    idSuffix: 'c-8536',
    skuSuffix: 'C-8536',
    name: '7.760 + 776 Diamantes',
    description: 'Combo de 8.536 diamantes (se acredita en 2 recargas seguidas).',
    amount: 7760,
    bonus: 776,
    sortOrder: 65,
    badge: 'COMBO',
    baseRequirements: [5600, 2180],
  },
];

/**
 * Busca una oferta base dentro del catálogo de Central One según el monto requerido.
 */
export function findBaseOfferForRequirement(
  offers: Array<Pick<CentralOneOffer, 'productId' | 'amount' | 'costUsd' | 'stock' | 'providerAvailable' | 'kind'> & { label?: string }>,
  requiredAmount: number,
  isBloodStrike = false
): (Pick<CentralOneOffer, 'productId' | 'amount' | 'costUsd' | 'stock' | 'providerAvailable' | 'kind'> & { label?: string }) | undefined {
  if (isBloodStrike) {
    const bsUuidMap: Record<number, string> = {
      100: 'ebc6b685-9d50-4d42-9aae-48e8c089a793',
      300: '35213545-bd4b-4e0b-8e76-b6ef476df25a',
      500: 'a4600212-f5a1-40ab-805a-5a549c3b5fba',
      1000: '13f92eb4-f186-41d7-b4b0-432aa9b9f0d9',
      2000: '17b5a2e5-8820-440a-a8a5-b30913a6fad8',
      5000: '8f29be10-34de-456c-86e9-698353ede6bb',
    };
    const targetUuid = bsUuidMap[requiredAmount];
    if (targetUuid) {
      const byUuid = offers.find((o) => o.productId === targetUuid);
      if (byUuid) return byUuid;
    }
    return offers.find((o) => {
      if (o.kind !== 'package') return false;
      const amt = o.amount;
      if (requiredAmount === 100) return amt === 100 || amt === 105;
      if (requiredAmount === 300) return amt === 300 || amt === 320;
      if (requiredAmount === 500) return amt === 500 || amt === 540;
      if (requiredAmount === 1000) return amt === 1000 || amt === 1100;
      if (requiredAmount === 2000) return amt === 2000 || amt === 2260;
      if (requiredAmount === 5000) return amt === 5000 || amt === 5800;
      return amt === requiredAmount;
    });
  }

  // Free Fire:
  return offers.find((o) => {
    if (o.kind !== 'package') return false;
    const amt = o.amount;
    if (requiredAmount === 100) return amt === 100 || amt === 110;
    if (requiredAmount === 310) return amt === 310 || amt === 341;
    if (requiredAmount === 520) return amt === 520 || amt === 572;
    if (requiredAmount === 1060) return amt === 1060 || amt === 1166;
    if (requiredAmount === 2180) return amt === 2180 || amt === 2398;
    if (requiredAmount === 5600) return amt === 5600 || amt === 6160;
    return amt === requiredAmount;
  });
}

export interface CentralOneComboPlanInput {
  plan: Pick<CentralOneGamePlan, 'id' | 'offers' | 'targetFields' | 'familyName'>;
  specs: CentralOneComboSpec[];
  targetGameId: string;
  existingProducts: ReadonlyMap<string, DocData> | Record<string, DocData | undefined>;
  pricing: { marginPercent: number; roundToUsd: number };
  timestamp: unknown;
}

/**
 * Planifica los combos de Central One aplicando todas las reglas de arquitectura:
 *  1. `quantity: 1` estricto en cada llamada (NUNCA quantity > 1).
 *  2. `costUsd` = suma exacta de reseller_price de las ofertas base.
 *  3. Sin stock si alguna oferta base no tiene stock o providerAvailable es false.
 *  4. Respeta precio fijado / personalizado salvo si el costo supera al precio.
 */
export function planCentralOneCombos(input: CentralOneComboPlanInput): {
  combos: DocData[];
  seenIds: string[];
} {
  const combos: DocData[] = [];
  const seenIds: string[] = [];
  const isBloodStrike = /blood\s*strike/i.test(input.plan.familyName);
  const targetFields = isBloodStrike
    ? (input.plan.targetFields.length > 0 ? input.plan.targetFields : ['game_user_id'])
    : (input.plan.targetFields.length > 0 ? input.plan.targetFields : ['player_id']);

  const getExisting = (id: string): DocData | undefined => {
    if (input.existingProducts instanceof Map) {
      return input.existingProducts.get(id);
    }
    return (input.existingProducts as Record<string, DocData | undefined>)[id];
  };

  for (const spec of input.specs) {
    let docId: string;
    if (input.targetGameId === 'blood-strike') {
      const preferredLegacy = spec.legacyId ? getExisting(spec.legacyId) : undefined;
      docId = preferredLegacy ? spec.legacyId! : (spec.legacyId || `bs-${spec.idSuffix}`);
    } else if (input.targetGameId === 'free-fire') {
      docId = `ff-${spec.idSuffix}`;
    } else if (input.targetGameId === 'freefire-id') {
      docId = `freefire-id--${spec.idSuffix}`;
    } else {
      docId = `${input.targetGameId}--${spec.idSuffix}`;
    }

    seenIds.push(docId);
    const current = getExisting(docId);

    // Encontrar ofertas base correspondientes
    const matchedOffers: Array<Pick<CentralOneOffer, 'productId' | 'amount' | 'costUsd' | 'stock' | 'providerAvailable' | 'kind'>> = [];
    let hasAllOffers = true;
    for (const req of spec.baseRequirements) {
      const offer = findBaseOfferForRequirement(input.plan.offers, req, isBloodStrike);
      if (!offer) {
        hasAllOffers = false;
        break;
      }
      matchedOffers.push(offer);
    }
    if (!hasAllOffers) continue;

    // Regla estricta quantity: 1 en TODAS las llamadas
    const calls: DispatchCall[] = matchedOffers.map((offer) => ({
      packageId: offer.productId,
      quantity: 1,
      provider: 'centralone',
      targetFields: [...targetFields],
    }));

    // Costo: suma exacta de reseller_price
    const costUsd = round(
      matchedOffers.reduce((sum, offer) => sum + offer.costUsd, 0),
      4
    );

    // Stock: si alguno no tiene stock o providerAvailable es false, sin stock
    const inStock = matchedOffers.every(
      (offer) => offer.providerAvailable && (offer.stock === null || offer.stock > 0)
    );

    const freshPrice = applyMargin(costUsd, input.pricing.marginPercent, input.pricing.roundToUsd);
    let priceUsd = freshPrice;
    if (current && typeof current.priceUsd === 'number') {
      const currentPrice = current.priceUsd;
      // Respeta precios personalizados o fijados por el admin, salvo si el costo supera al precio
      if (costUsd > currentPrice) {
        priceUsd = freshPrice;
      } else {
        priceUsd = currentPrice;
      }
    }

    const adminDisabled = current?.adminDisabled === true;
    const active = inStock && !adminDisabled;
    const stock = inStock ? null : 0;

    const data: DocData = {
      id: docId,
      gameId: input.targetGameId,
      sku: `${input.targetGameId.startsWith('co-') ? 'CO-' : ''}${spec.skuSuffix}`.slice(0, 40),
      name: spec.name,
      description: spec.description,
      fulfillment: 'auto',
      manualFlow: 'notify',
      kind: 'combo',
      amount: spec.amount,
      bonus: spec.bonus,
      costUsd,
      priceUsd,
      compareAtUsd: current?.compareAtUsd ?? null,
      calls,
      targetFields: [...targetFields],
      provider: 'centralone',
      imageUrl: '',
      badge: spec.badge ?? 'COMBO',
      active,
      adminDisabled,
      priceLocked: current?.priceLocked === true,
      featured: current?.featured ?? false,
      sortOrder: spec.sortOrder,
      stock,
      deliveryEtaMinutes: 2,
      providerRemoved: false,
      providerSyncedAt: input.timestamp,
      updatedAt: input.timestamp,
    };

    if (!current) {
      data.createdAt = input.timestamp;
    }

    combos.push(data);
  }

  return { combos, seenIds };
}

// ---------------------------------------------------------------------------
// Escritura por lotes
// ---------------------------------------------------------------------------

class BatchWriter {
  private batch = db.batch();
  private pending = 0;
  private commits: Promise<unknown>[] = [];
  writes = 0;

  /**
   * Añade una escritura. Al llenarse el lote se confirma en segundo plano y
   * se abre otro: así ningún lote supera el tope de la plataforma.
   */
  set(ref: DocumentReference, data: Record<string, unknown>, merge = true): void {
    this.batch.set(ref, data, { merge });
    this.pending += 1;
    this.writes += 1;
    if (this.pending >= WRITE_BATCH_SIZE) this.rotate();
  }

  private rotate(): void {
    if (this.pending === 0) return;
    const current = this.batch;
    this.batch = db.batch();
    this.pending = 0;
    const commit = current.commit();
    // Se le engancha un manejador ya: entre una rotación y el `flush` hay
    // lecturas lentas (p. ej. los productos `fz-*` del retiro) y un lote que
    // fallara ahí sería un rechazo sin manejar, que en Node 22 tumba la
    // instancia sin cerrar la sync ni avisar. El error no se pierde: `flush`
    // espera esta misma promesa con `Promise.all` y lo relanza.
    commit.catch(() => undefined);
    this.commits.push(commit);
  }

  /** Espera a los lotes en vuelo cuando se acumulan demasiados. */
  async maybeFlush(): Promise<void> {
    if (this.commits.length >= 4) await this.flush();
  }

  /** Confirma lo pendiente y espera a que terminen los lotes en vuelo. */
  async flush(): Promise<void> {
    this.rotate();
    const inFlight = this.commits;
    this.commits = [];
    await Promise.all(inFlight);
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Timestamp && right instanceof Timestamp) return left.toMillis() === right.toMillis();
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = Object.keys(left).filter((key) => (left as Record<string, unknown>)[key] !== undefined);
    const otherKeys = Object.keys(right).filter((key) => (right as Record<string, unknown>)[key] !== undefined);
    return (
      keys.length === otherKeys.length &&
      keys.every((key) =>
        sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
      )
    );
  }
  return false;
}

/** Sólo los campos propuestos que difieren de lo guardado. */
function changedPatch(current: Record<string, unknown>, proposed: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(proposed).filter(([key, value]) => !sameValue(current[key], value)));
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>;

/** `getAll` en lotes (con unos pocos en paralelo): miles de docs en segundos. */
async function readDocs(refs: DocumentReference[]): Promise<Map<string, DocData>> {
  const out = new Map<string, DocData>();
  const chunks: DocumentReference[][] = [];
  for (let i = 0; i < refs.length; i += READ_CHUNK_SIZE) chunks.push(refs.slice(i, i + READ_CHUNK_SIZE));
  for (let i = 0; i < chunks.length; i += 4) {
    const snaps = await Promise.all(chunks.slice(i, i + 4).map((chunk) => db.getAll(...chunk)));
    for (const list of snaps) {
      for (const snap of list) {
        if (snap.exists) out.set(snap.id, snap.data() as DocData);
      }
    }
  }
  return out;
}

async function readGamesByProvider(provider: 'centralone' | 'fazercards'): Promise<Map<string, DocData>> {
  const snap = await games().where('provider', '==', provider).get();
  return new Map(snap.docs.map((doc) => [doc.id, doc.data() as DocData]));
}

// ---------------------------------------------------------------------------
// Contexto
// ---------------------------------------------------------------------------

interface SyncContext {
  timestamp: Timestamp;
  deadlineMs: number;
  marginPercent: number;
  roundToUsd: number;
  writer: BatchWriter;
  summary: CentralOneSyncSummary;
  /**
   * `false` si `GET /player/validate/coverage` falló en esta sync: entonces no
   * se sabe qué ofertas validan y los juegos existentes conservan su
   * `validatesPlayerId` (un fallo pasajero no apaga la validación de toda la
   * tienda ni gasta escrituras de ida y vuelta).
   */
  coverageKnown: boolean;
  outOfTime(): boolean;
}

function emptySummary(startedAt: Date): CentralOneSyncSummary {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    completed: false,
    aborted: null,
    itemsReceived: 0,
    itemsMapped: 0,
    skipped: {},
    gamesCreated: 0,
    gamesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    gamesRemoved: 0,
    productsRemoved: 0,
    fazerRetired: null,
    extrasCreated: [],
    freeFireLatamGameId: null,
    errors: [],
  };
}

function priceFor(ctx: SyncContext, costUsd: number): number {
  return applyMargin(costUsd, ctx.marginPercent, ctx.roundToUsd);
}

// ---------------------------------------------------------------------------
// Upsert de juegos y productos
// ---------------------------------------------------------------------------

/**
 * Documento completo de un juego de Central One que se crea por primera vez.
 * Pura. Nombre, imágenes, colores, orden y `active` sólo se escriben aquí:
 * después manda el admin.
 */
export function newCentralOneGameDoc(
  plan: CentralOneGamePlan,
  providerControlled: DocData,
  presentation: Partial<GamePresentation> | null,
  timestamp: unknown
): DocData {
  const meta = FAMILY_META[plan.family];
  const first = plan.playerFields[0];
  return {
    ...providerControlled,
    name: plan.name,
    shortName: plan.name,
    currencyLabel: plan.currency.label,
    currencyIcon: plan.currency.icon,
    currencyIconUrl: presentation?.currencyIconUrl || plan.currency.iconUrl,
    playerIdLabel: first?.label ?? '',
    playerIdPattern: first?.pattern ?? '',
    playerIdHelp: first?.help ?? '',
    howToFindId: plan.family === 'topup' ? ['Abre el juego y copia los datos que solicita el formulario.'] : [],
    logoUrl: presentation?.logoUrl ?? '',
    coverUrl: presentation?.coverUrl ?? presentation?.logoUrl ?? '',
    accentColor: presentation?.accentColor ?? meta.accent,
    accentColorSecondary: presentation?.accentColorSecondary ?? meta.accentSecondary,
    // El Free Fire de Central One convive con los dos de Inefable: nace
    // apagado y el cliente lo enciende cuando decida.
    active: !plan.isFreeFireLatam,
    sortOrder: calculateGameSortOrder({
      regionCode: plan.region,
      name: plan.name,
      providerFamily: plan.family,
      salesCount: 0,
    }),
    salesCount: 0,
    hiddenReason: null,
    providerSyncedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Escribe un juego y sus productos (sólo lo que cambió). */
function upsertGame(
  ctx: SyncContext,
  plan: CentralOneGamePlan,
  existingGame: DocData | undefined,
  existingProducts: Map<string, DocData>,
  fazerGames: Map<string, Partial<Game>>
): void {
  const ts = ctx.timestamp;
  const presentation = existingGame ? null : pickFazerPresentation(plan, fazerGames);
  const gameImage = existingGame
    ? String(existingGame.coverUrl || existingGame.logoUrl || '')
    : presentation?.coverUrl || presentation?.logoUrl || '';

  const regionInfo = resolveRegionInfo(plan.region, plan.name, plan.familyName);

  const sold: number[] = [];
  for (const offer of plan.offers) {
    const current = existingProducts.get(offer.docId);
    const calls: DispatchCall[] = [
      { packageId: offer.productId, quantity: 1, provider: 'centralone', targetFields: [...offer.targetFields] },
    ];
    const freshPrice = priceFor(ctx, offer.costUsd);
    const productNotice = extractPackageRegionNotice(offer.label) || (regionInfo.isRegionRestricted ? regionInfo.regionWarning : undefined);

    if (!current) {
      const adminDisabled = false;
      const active = offer.providerAvailable;
      ctx.writer.set(
        products().doc(offer.docId),
        {
          gameId: plan.id,
          sku: offer.sku,
          name: offer.label,
          description: offer.description,
          fulfillment: 'auto',
          manualFlow: 'notify',
          kind: offer.kind,
          amount: offer.amount,
          bonus: offer.bonus,
          costUsd: offer.costUsd,
          priceUsd: freshPrice,
          compareAtUsd: null,
          calls,
          targetFields: [...offer.targetFields],
          provider: 'centralone',
          providerOfferId: offer.productId,
          imageUrl: plan.family === 'gift_card' ? gameImage : extraImage(offer.label, offer.kind),
          badge: offer.badge,
          region: plan.region,
          regionCode: regionInfo.regionCode,
          regionLabel: regionInfo.regionLabel,
          regionBadge: regionInfo.regionBadge,
          isRegionRestricted: regionInfo.isRegionRestricted,
          regionWarning: regionInfo.regionWarning,
          regionNotice: productNotice,
          isRegionLocked: regionInfo.isRegionRestricted,
          active,
          adminDisabled,
          priceLocked: false,
          featured: false,
          sortOrder: offer.sortOrder,
          stock: offer.stock,
          deliveryEtaMinutes: offer.deliveryEtaMinutes,
          providerRemoved: false,
          providerSyncedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        },
        false
      );
      ctx.summary.productsCreated += 1;
      if (active) sold.push(freshPrice);
      continue;
    }

    const adminDisabled = current.adminDisabled === true;
    const currentPrice = typeof current.priceUsd === 'number' ? current.priceUsd : 0;
    let priceUsd = freshPrice;
    if (current.priceLocked === true) {
      // Precio fijado por el admin: se respeta salvo que ahora se venda a pérdida.
      priceUsd = currentPrice;
      if (offer.costUsd > currentPrice) {
        priceUsd = freshPrice;
        log.warn('Precio fijado por el admin por debajo del costo de Central One; se recalcula', {
          productId: offer.docId,
          costUsd: offer.costUsd,
          lockedPriceUsd: currentPrice,
          newPriceUsd: freshPrice,
        });
      }
    }
    const active = offer.providerAvailable && !adminDisabled;
    const desiredImageUrl = (current.imageUrl as string | undefined) || (plan.family === 'gift_card' ? gameImage : extraImage(offer.label, offer.kind));
    const changed = changedPatch(current, {
      provider: 'centralone',
      providerOfferId: offer.productId,
      calls,
      targetFields: [...offer.targetFields],
      costUsd: offer.costUsd,
      priceUsd,
      stock: offer.stock,
      active,
      imageUrl: desiredImageUrl,
      region: plan.region,
      regionCode: regionInfo.regionCode,
      regionLabel: regionInfo.regionLabel,
      regionBadge: regionInfo.regionBadge,
      isRegionRestricted: regionInfo.isRegionRestricted,
      regionWarning: regionInfo.regionWarning,
      regionNotice: productNotice,
      isRegionLocked: regionInfo.isRegionRestricted,
      providerRemoved: false,
    });
    if (Object.keys(changed).length > 0) {
      ctx.writer.set(products().doc(offer.docId), { ...changed, providerSyncedAt: ts, updatedAt: ts });
      ctx.summary.productsUpdated += 1;
    }
    if (active) sold.push(priceUsd);
  }

  const isBs = isBloodStrike(`${plan.id} ${plan.name}`);
  const finalPlayerFields = isBs
    ? (Array.isArray(existingGame?.playerFields) && existingGame.playerFields.length === 1
        ? existingGame.playerFields
        : plan.playerFields.slice(0, 1))
    : plan.playerFields;

  const providerControlled: DocData = {
    provider: 'centralone',
    providerFamily: plan.family,
    apiGameId: plan.apiGameId,
    apiGameType: plan.family,
    requiresPlayerData: plan.family === 'topup',
    region: plan.region,
    regionCode: regionInfo.regionCode,
    regionLabel: regionInfo.regionLabel,
    regionBadge: regionInfo.regionBadge,
    isRegionRestricted: regionInfo.isRegionRestricted,
    regionWarning: regionInfo.regionWarning,
    platform: null,
    playerFields: finalPlayerFields,
    validatesPlayerId: plan.validatesPlayerId,
    productCount: sold.length,
    minPriceUsd: sold.length > 0 ? round(Math.min(...sold), 2) : null,
    providerRemoved: false,
  };

  if (!existingGame) {
    ctx.writer.set(games().doc(plan.id), newCentralOneGameDoc(plan, providerControlled, presentation, ts), false);
    ctx.summary.gamesCreated += 1;
    return;
  }

  const proposed: DocData = { ...providerControlled };
  if (!ctx.coverageKnown) delete proposed.validatesPlayerId;
  // Sólo vuelve solo lo que ocultó la sync por desaparecido; lo que apagó el
  // admin o el retiro de FazerCards no se toca.
  if (existingGame.hiddenReason === 'provider_removed') {
    proposed.active = true;
    proposed.hiddenReason = null;
  }
  const changed = changedPatch(existingGame, proposed);
  if (Object.keys(changed).length > 0) {
    ctx.writer.set(games().doc(plan.id), { ...changed, providerSyncedAt: ts, updatedAt: ts });
    ctx.summary.gamesUpdated += 1;
  }
}

/**
 * Desaparecidos: juegos y productos `co-*` de Central One con
 * `providerSyncedAt` que esta sync completa no vio. Se ocultan, no se borran
 * (las órdenes viejas los citan).
 */
async function markRemoved(
  ctx: SyncContext,
  coGames: Map<string, DocData>,
  seenGames: Set<string>,
  seenProducts: Set<string>,
  protectedGames: Set<string>,
  skipFamilies: CoFamily[]
): Promise<void> {
  const inSkippedFamily = (id: string) => skipFamilies.some((family) => id.startsWith(`co-${family}-`));
  for (const [id, game] of coGames) {
    if (!id.startsWith('co-') || !game.providerSyncedAt || seenGames.has(id) || protectedGames.has(id)) continue;
    if (inSkippedFamily(id)) continue;
    if (game.providerRemoved === true && game.active === false) continue;
    const patch: DocData = { providerRemoved: true, updatedAt: ctx.timestamp };
    // Si el admin ya lo había apagado se respeta su motivo: así no vuelve solo.
    if (game.active !== false) {
      patch.active = false;
      patch.hiddenReason = 'provider_removed';
    }
    ctx.writer.set(games().doc(id), patch);
    ctx.summary.gamesRemoved += 1;
    await ctx.writer.maybeFlush();
  }

  const snap = await products()
    .where('provider', '==', 'centralone')
    .select('active', 'providerRemoved', 'providerSyncedAt', 'gameId')
    .get();
  for (const doc of snap.docs) {
    const id = doc.id;
    const data = doc.data();
    if (!id.startsWith('co-') || !data.providerSyncedAt || seenProducts.has(id)) continue;
    if (protectedGames.has(String(data.gameId ?? '')) || inSkippedFamily(id)) continue;
    if (data.providerRemoved === true && data.active === false) continue;
    ctx.writer.set(products().doc(id), { providerRemoved: true, active: false, updatedAt: ctx.timestamp });
    ctx.summary.productsRemoved += 1;
    await ctx.writer.maybeFlush();
  }
  await ctx.writer.flush();
}

// ---------------------------------------------------------------------------
// Retiro de FazerCards (D9, una sola vez)
// ---------------------------------------------------------------------------

/**
 * Apaga todo lo de FazerCards (`fz-*`, salvo juegos `manual`) la primera vez
 * que Central One sincroniza completo. No borra nada: las órdenes viejas y el
 * espejo de WhatsApp los citan, y el despacho/consulta de FazerCards sigue
 * vivo para esas órdenes.
 */
async function retireFazerCards(
  ctx: SyncContext,
  fazerGames: Map<string, DocData>
): Promise<{ games: number; products: number }> {
  const retired = new Set<string>();
  for (const [id, game] of fazerGames) {
    if (!id.startsWith('fz-') || game.manual === true) continue;
    retired.add(id);
    if (game.active === false && game.providerRemoved === true && game.hiddenReason === 'provider_migrated') continue;
    ctx.writer.set(games().doc(id), {
      active: false,
      providerRemoved: true,
      hiddenReason: 'provider_migrated',
      updatedAt: ctx.timestamp,
    });
    await ctx.writer.maybeFlush();
  }

  // Los productos de FazerCards no llevan `provider`: se recorren por prefijo
  // de id (`fz-…`), que es el del juego.
  const snap = await products()
    .where(FieldPath.documentId(), '>=', 'fz-')
    .where(FieldPath.documentId(), '<', 'fz.')
    .select('gameId', 'active', 'providerRemoved')
    .get();
  let productCount = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    if (!retired.has(String(data.gameId ?? ''))) continue;
    productCount += 1;
    if (data.active === false && data.providerRemoved === true) continue;
    ctx.writer.set(products().doc(doc.id), { active: false, providerRemoved: true, updatedAt: ctx.timestamp });
    await ctx.writer.maybeFlush();
  }
  await ctx.writer.flush();
  return { games: retired.size, products: productCount };
}

// ---------------------------------------------------------------------------
// Extras de Free Fire (D10, escritura)
// ---------------------------------------------------------------------------

async function createFreeFireExtras(
  ctx: SyncContext,
  freeFire: CentralOneGamePlan | null,
  marker: Set<string>,
  previousAtLoss: string[]
): Promise<void> {
  if (!freeFire) {
    ctx.summary.errors.push('Central One no trae Free Fire LATAM: no se crearon extras de Free Fire.');
    return;
  }
  const inefableProducts: Record<string, ExistingProduct[] | null> = {};
  for (const gameId of INEFABLE_FREE_FIRE_GAME_IDS) {
    const [gameSnap, productSnap] = await Promise.all([
      games().doc(gameId).get(),
      products().where('gameId', '==', gameId).get(),
    ]);
    inefableProducts[gameId] = gameSnap.exists
      ? productSnap.docs.map((doc) => ({ ...(doc.data() as Partial<Product>), id: doc.id }))
      : null;
  }
  const atLoss = findExtrasAtLoss(inefableProducts, freeFire.offers);
  ctx.summary.extrasAtLoss = atLoss;
  // Un aviso por extra que ENTRA en pérdida, no uno por hora mientras siga así.
  const newlyAtLoss = atLoss.filter((id) => !previousAtLoss.includes(id));
  if (newlyAtLoss.length > 0) {
    log.warn('Extras de Free Fire con costo de Central One igual o mayor que su precio', { ids: newlyAtLoss });
    await adminAlerts
      .alert({
        kind: 'provider_down',
        severity: 'warning',
        title: 'Extras de Free Fire a pérdida',
        body: [
          `Central One subió el costo de ${newlyAtLoss.length} producto(s) extra de Free Fire por encima de su precio:`,
          newlyAtLoss.join(', '),
          'La sincronización no cambia los precios de los juegos de Inefable: súbelos o apágalos desde Productos.',
        ].join('\n'),
        link: '/admin/productos',
        data: { ids: newlyAtLoss },
      })
      .catch(() => undefined);
  }

  const comboRef = products().doc(`${freeFire.id}--nivel-completo`);
  const comboSnap = await comboRef.get();
  const existingIds = new Set<string>(comboSnap.exists ? [comboSnap.id] : []);

  const plan = planFreeFireExtras({
    freeFire,
    inefableProducts,
    existingIds,
    marker,
    pricing: { marginPercent: ctx.marginPercent, roundToUsd: ctx.roundToUsd },
    timestamp: ctx.timestamp,
  });
  for (const note of plan.notes) log.info('Extras de Free Fire', { note });
  if (plan.creates.length === 0) return;

  for (const extra of plan.creates) {
    ctx.writer.set(products().doc(extra.id), extra.data, false);
    await ctx.writer.maybeFlush();
  }
  await ctx.writer.flush();
  // El marcador se escribe DESPUÉS de crear: si la escritura falló, la
  // próxima sync lo intenta de nuevo; si quedó creado, nunca se recrea.
  const extras: Record<string, Timestamp> = {};
  for (const extra of plan.creates) extras[extra.id] = ctx.timestamp;
  await privateCentralOneConfigDoc().set({ extras }, { merge: true });
  ctx.summary.extrasCreated.push(...plan.creates.map((extra) => extra.id));
  log.info('Extras de Free Fire creados', {
    count: plan.creates.length,
    ids: plan.creates.map((extra) => extra.id),
  });
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

async function writeProgress(syncId: string | null | undefined, summary: CentralOneSyncSummary): Promise<void> {
  if (!syncId) return;
  await providerSync()
    .doc(syncId)
    .set({ summary }, { merge: true })
    .catch(() => undefined);
}

/** Una sync en cola o corriendo con más de esto se da por muerta. */
export const CENTRAL_ONE_SYNC_STALE_MS = 15 * 60_000;

/**
 * Encola una sync (crea `providerSync/{id}` en `queued`, lo que dispara
 * `runCentralOneSync`) salvo que ya haya una viva.
 *
 * Mirar «¿hay alguna en cola?» y luego añadir no basta: el cron de la hora y
 * un clic en «Sincronizar ahora» al mismo tiempo veían las dos que no había
 * ninguna y encolaban dos, que corrían a la vez sobre los mismos docs. Aquí la
 * consulta y la creación van en una transacción sobre un candado único
 * (`privateConfig/centralOneSyncLock`), así que sólo una de las dos gana.
 */
/**
 * Registra un juego como eliminado por el admin para que la sincronización
 * automática de Central One no lo vuelva a crear en el futuro.
 */
export async function recordDeletedGame(gameId: string): Promise<void> {
  await privateCentralOneConfigDoc().set(
    { deletedGameIds: FieldValue.arrayUnion(gameId) },
    { merge: true }
  );
}

/**
 * Remueve un juego de la lista de eliminados si el admin lo crea de nuevo explícitamente.
 */
export async function unrecordDeletedGame(gameId: string): Promise<void> {
  await privateCentralOneConfigDoc().set(
    { deletedGameIds: FieldValue.arrayRemove(gameId) },
    { merge: true }
  );
}

export async function enqueueCentralOneSync(input: {
  trigger: ProviderSyncTrigger;
  actorUid?: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; activeId: string }> {
  const lockRef = privateCentralOneSyncLockDoc();
  return db.runTransaction(async (tx) => {
    const lock = (await tx.get(lockRef)).data() as { syncId?: string; createdAt?: Timestamp } | undefined;
    const lockedAt = lock?.createdAt && typeof lock.createdAt.toMillis === 'function' ? lock.createdAt.toMillis() : 0;
    if (lock?.syncId && Date.now() - lockedAt < CENTRAL_ONE_SYNC_STALE_MS) {
      const active = await tx.get(providerSync().doc(lock.syncId));
      const status = active.get('status') as string | undefined;
      if (active.exists && (status === 'queued' || status === 'running')) {
        return { ok: false as const, activeId: lock.syncId };
      }
    }
    const ref = providerSync().doc();
    const timestamp = now();
    const doc: Omit<ProviderSync, 'id'> = {
      provider: 'centralone',
      status: 'queued',
      trigger: input.trigger,
      actorUid: input.actorUid ?? null,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
    };
    tx.create(ref, doc);
    tx.set(lockRef, { syncId: ref.id, createdAt: timestamp });
    return { ok: true as const, id: ref.id };
  });
}

/**
 * Sincroniza el catálogo de Central One. Nunca lanza: todo desemboca en el
 * resumen (el trigger lo guarda en `providerSync/{id}` y marca `error` si
 * `aborted`). Lee el catálogo UNA vez; la cobertura de validación es opcional.
 */
export async function runCentralOneSync(opts: {
  trigger: ProviderSyncTrigger;
  actorUid?: string | null;
  syncId?: string | null;
}): Promise<CentralOneSyncSummary> {
  const startedAt = new Date();
  const summary = emptySummary(startedAt);
  const deadlineMs = Date.now() + TIME_BUDGET_MS;
  let mappingRan = false;
  let previousState: DocData = {};

  log.info('Sync de Central One: inicio', { trigger: opts.trigger, syncId: opts.syncId ?? null });

  try {
    const [config, privateSnap] = await Promise.all([
      getConfig({ fresh: true }),
      privateCentralOneConfigDoc().get(),
    ]);
    previousState = (privateSnap.data() ?? {}) as DocData;
    const ctx: SyncContext = {
      timestamp: now(),
      deadlineMs,
      marginPercent: config.pricing.defaultMarginPercent,
      roundToUsd: config.pricing.roundToUsd,
      writer: new BatchWriter(),
      summary,
      coverageKnown: false,
      outOfTime: () => Date.now() > deadlineMs,
    };

    const catalog = await centralOne.getCatalog();
    if (!catalog.ok) {
      summary.aborted = catalog.code || 'catalog_error';
      summary.errors.push(catalog.message);
      return await finish(opts, summary, previousState, mappingRan);
    }
    summary.itemsReceived = catalog.items.length;

    // Sin cobertura se sigue: los juegos que ya existen conservan su
    // `validatesPlayerId` (ver `upsertGame`) y los nuevos nacen sin él hasta
    // la próxima sync; el checkout pide confirmar el ID.
    const coverage = await centralOne.getCoverage();
    const coverageIds = coverage.ok ? coverage.productIds : new Set<string>();
    ctx.coverageKnown = coverage.ok;
    if (!coverage.ok) {
      summary.errors.push(`Cobertura de validación no disponible: ${coverage.message}`);
      log.warn('No se pudo leer la cobertura de validación de Central One; se sincroniza sin ella');
    }

    const [coGames, fazerGamesRaw] = await Promise.all([
      readGamesByProvider('centralone'),
      readGamesByProvider('fazercards'),
    ]);
    const fazerGames = fazerGamesRaw as Map<string, Partial<Game>>;

    const mapping = mapCentralOneCatalog(catalog.items, coverageIds, {
      games: coGames as Map<string, Partial<Game>>,
    });
    mappingRan = true;
    summary.itemsMapped = mapping.itemsMapped;
    summary.skipped = mapping.skipped;
    summary.freeFireLatamGameId = mapping.freeFireLatamGameId;
    const mixed = mapping.games.filter((plan) => plan.fieldSignatures > 1).map((plan) => plan.id);
    log.info('Catálogo de Central One leído', {
      items: catalog.items.length,
      games: mapping.games.length,
      byFamily: mapping.gamesByFamily,
      itemsMapped: mapping.itemsMapped,
      skipped: mapping.skipped,
      mixedFieldGames: mixed.length,
    });

    // --- Freno de seguridad (antes de escribir nada) ---
    const activeByFamily: Record<CoFamily, number> = { topup: 0, gift_card: 0 };
    for (const [id, game] of coGames) {
      if (!id.startsWith('co-') || game.active !== true || game.providerRemoved === true) continue;
      const family: CoFamily = id.startsWith('co-gift_card-') ? 'gift_card' : 'topup';
      activeByFamily[family] += 1;
    }
    const verdict = centralOneSanityCheck({
      itemsReceived: catalog.items.length,
      mappedByFamily: mapping.gamesByFamily,
      activeByFamily,
    });
    if (verdict.abort) {
      summary.aborted = verdict.abort;
      if (verdict.message) summary.errors.push(verdict.message);
      return await finish(opts, summary, previousState, mappingRan);
    }

    // --- Lectura de productos existentes (sólo los ids que importan) ---
    const productIds = new Set<string>(mapping.inactiveProductIds);
    for (const plan of mapping.games) {
      for (const offer of plan.offers) productIds.add(offer.docId);
      const isBS = /blood\s*strike/i.test(plan.familyName);
      const isFF = plan.isFreeFireLatam;
      if (isBS) {
        for (const spec of BLOOD_STRIKE_COMBO_SPECS) {
          productIds.add(`${plan.id}--${spec.idSuffix}`);
          if (spec.legacyId) productIds.add(spec.legacyId);
          productIds.add(`bs-${spec.idSuffix}`);
        }
      }
      if (isFF) {
        for (const spec of FREE_FIRE_LATAM_COMBO_SPECS) {
          productIds.add(`${plan.id}--${spec.idSuffix}`);
          productIds.add(`ff-${spec.idSuffix}`);
          productIds.add(`freefire-id--${spec.idSuffix}`);
        }
      }
    }
    const existingProducts = await readDocs(Array.from(productIds).map((id) => products().doc(id)));
    const linkedGameDocs = await readDocs(['blood-strike', 'free-fire', 'freefire-id'].map((id) => games().doc(id)));

    // --- Upsert ---
    const seenGames = new Set<string>();
    const seenProducts = new Set<string>();
    const protectedGames = new Set<string>();
    for (const [id, game] of coGames) if (game.manual === true) protectedGames.add(id);

    // Juegos explícitamente eliminados por el admin para que la sincronización no los vuelva a crear:
    const deletedGameIds = new Set<string>(
      Array.isArray(previousState.deletedGameIds) ? previousState.deletedGameIds : []
    );
    for (const id of deletedGameIds) protectedGames.add(id);
    // Un doc con el mismo id que NO es de Central One (un juego creado a mano
    // desde el panel con otro proveedor, por ejemplo) no aparece en `coGames`
    // y se tomaría por inexistente: se crearía encima con `merge: false`,
    // borrando nombre, imágenes y `manual`. Se protege igual que uno manual.
    const unknownIds = mapping.games.map((plan) => plan.id).filter((id) => !coGames.has(id));
    const foreignGames = await readDocs(unknownIds.map((id) => games().doc(id)));
    for (const [id, game] of foreignGames) {
      protectedGames.add(id);
      log.warn('Juego con id de Central One que no es de la sync: no se toca', {
        gameId: id,
        provider: game.provider ?? null,
        manual: game.manual === true,
      });
    }

    let timedOut = false;
    for (const plan of mapping.games) {
      if (ctx.outOfTime()) {
        timedOut = true;
        break;
      }
      seenGames.add(plan.id);
      for (const offer of plan.offers) seenProducts.add(offer.docId);
      // Un juego creado a mano desde el panel con el mismo id es del admin: la
      // sync no lo pisa ni toca sus productos.
      if (protectedGames.has(plan.id)) {
        summary.skipped.manual_game = (summary.skipped.manual_game ?? 0) + 1;
        continue;
      }
      upsertGame(ctx, plan, coGames.get(plan.id), existingProducts, fazerGames);

      // Sincronización de Combos para Central One (Blood Strike y Free Fire LATAM)
      const isBS = /blood\s*strike/i.test(plan.familyName);
      const isFF = plan.isFreeFireLatam;
      if (isBS || isFF) {
        const specs = isBS ? BLOOD_STRIKE_COMBO_SPECS : FREE_FIRE_LATAM_COMBO_SPECS;
        // 1. Combo en el juego de Central One
        const plannedCo = planCentralOneCombos({
          plan,
          specs,
          targetGameId: plan.id,
          existingProducts,
          pricing: { marginPercent: ctx.marginPercent, roundToUsd: ctx.roundToUsd },
          timestamp: ctx.timestamp,
        });
        for (const id of plannedCo.seenIds) seenProducts.add(id);
        if (isFF) seenProducts.add(`${plan.id}--nivel-completo`);
        for (const combo of plannedCo.combos) {
          const id = combo.id as string;
          const current = existingProducts.get(id);
          if (!current) {
            ctx.writer.set(products().doc(id), combo, false);
            ctx.summary.productsCreated += 1;
          } else {
            const patch = changedPatch(current, combo);
            if (Object.keys(patch).length > 0) {
              ctx.writer.set(products().doc(id), { ...patch, providerSyncedAt: ctx.timestamp, updatedAt: ctx.timestamp });
              ctx.summary.productsUpdated += 1;
            }
          }
        }

        // 2. Combos en juegos vinculados si existen en Firestore
        const targets = isBS ? ['blood-strike'] : ['free-fire', 'freefire-id'];
        for (const targetId of targets) {
          if (linkedGameDocs.has(targetId)) {
            const plannedLinked = planCentralOneCombos({
              plan,
              specs,
              targetGameId: targetId,
              existingProducts,
              pricing: { marginPercent: ctx.marginPercent, roundToUsd: ctx.roundToUsd },
              timestamp: ctx.timestamp,
            });
            for (const combo of plannedLinked.combos) {
              const id = combo.id as string;
              const current = existingProducts.get(id);
              if (!current) {
                ctx.writer.set(products().doc(id), combo, false);
                ctx.summary.productsCreated += 1;
              } else {
                const patch = changedPatch(current, combo);
                if (Object.keys(patch).length > 0) {
                  ctx.writer.set(products().doc(id), { ...patch, providerSyncedAt: ctx.timestamp, updatedAt: ctx.timestamp });
                  ctx.summary.productsUpdated += 1;
                }
              }
            }
          }
        }
      }
      await ctx.writer.maybeFlush();
    }

    // Ítems inactivos en Central One que ya se vendían: se apagan.
    for (const id of mapping.inactiveProductIds) {
      const current = existingProducts.get(id);
      if (!current || seenProducts.has(id)) continue;
      seenProducts.add(id);
      if (current.provider !== 'centralone' || protectedGames.has(String(current.gameId ?? ''))) continue;
      if (current.active === false) continue;
      ctx.writer.set(products().doc(id), { active: false, updatedAt: ctx.timestamp });
      summary.productsUpdated += 1;
      await ctx.writer.maybeFlush();
    }
    await ctx.writer.flush();

    if (timedOut) {
      summary.errors.push('Se agotó el tiempo de la sync: no se marcaron retirados ni se retiró FazerCards.');
      return await finish(opts, summary, previousState, mappingRan);
    }
    summary.completed = true;
    await writeProgress(opts.syncId, summary);

    // --- Desaparecidos ---
    await markRemoved(ctx, coGames, seenGames, seenProducts, protectedGames, verdict.skipRemoval);

    // --- Retiro de FazerCards (una sola vez, con ambas familias mapeadas) ---
    const bothFamilies = mapping.gamesByFamily.topup > 0 && mapping.gamesByFamily.gift_card > 0;
    if (!previousState.fazerRetiredAt && bothFamilies) {
      const counts = await retireFazerCards(ctx, fazerGamesRaw);
      await privateCentralOneConfigDoc().set(
        { fazerRetiredAt: ctx.timestamp, fazerRetired: counts },
        { merge: true }
      );
      summary.fazerRetired = counts;
      log.info('FazerCards retirado de la tienda', counts);
    } else if (!previousState.fazerRetiredAt) {
      summary.errors.push('FazerCards no se retiró: falta una de las familias (recargas o gift cards) en Central One.');
    }

    // --- Extras de Free Fire ---
    const marker = new Set(Object.keys((previousState.extras as Record<string, unknown> | undefined) ?? {}));
    const freeFire = mapping.games.find((plan) => plan.id === mapping.freeFireLatamGameId) ?? null;
    try {
      const previousSummary = previousState.lastSyncSummary as CentralOneSyncSummary | undefined;
      await createFreeFireExtras(ctx, freeFire, marker, previousSummary?.extrasAtLoss ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`Extras de Free Fire: ${message.slice(0, 200)}`);
      log.warn('No se pudieron crear los extras de Free Fire', { error: message });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.completed = false;
    summary.aborted = summary.aborted ?? 'exception';
    summary.errors.push(message.slice(0, 300));
    log.error('Sync de Central One: excepción', { error: message });
  }

  return finish(opts, summary, previousState, mappingRan);
}

/**
 * Cierra la sync: guarda el resumen en `privateConfig/centralOne` y avisa al
 * equipo si se frenó. El aviso sale sólo al CAMBIAR de motivo (la sync corre
 * cada hora y repetir el mismo aviso 24 veces al día sólo hace ruido).
 */
async function finish(
  opts: { trigger: ProviderSyncTrigger; actorUid?: string | null; syncId?: string | null },
  summary: CentralOneSyncSummary,
  previousState: DocData,
  mappingRan: boolean
): Promise<CentralOneSyncSummary> {
  summary.finishedAt = new Date().toISOString();
  try {
    const patch: DocData = { lastSyncAt: now(), lastSyncSummary: summary };
    if (mappingRan) patch.freeFireLatamGameId = summary.freeFireLatamGameId;
    await privateCentralOneConfigDoc().set(patch, { merge: true });
  } catch (error) {
    log.warn('No se pudo guardar el resumen de la sync de Central One', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const previousAbort = (previousState.lastSyncSummary as CentralOneSyncSummary | undefined)?.aborted ?? null;
  if (summary.aborted && summary.aborted !== previousAbort) {
    await adminAlerts
      .alert({
        kind: 'provider_down',
        severity: summary.aborted === 'catalog_suspicious' || summary.aborted === 'empty_catalog' ? 'warning' : 'critical',
        title: 'La sincronización de Central One se detuvo',
        body: `${summary.aborted}: ${summary.errors[0] ?? 'sin detalle'}`,
        link: '/admin/configuracion',
        data: { trigger: opts.trigger, syncId: opts.syncId ?? null, aborted: summary.aborted },
      })
      .catch(() => undefined);
  }

  log.info('Sync de Central One: fin', {
    trigger: opts.trigger,
    completed: summary.completed,
    aborted: summary.aborted,
    itemsReceived: summary.itemsReceived,
    itemsMapped: summary.itemsMapped,
    gamesCreated: summary.gamesCreated,
    gamesUpdated: summary.gamesUpdated,
    productsCreated: summary.productsCreated,
    productsUpdated: summary.productsUpdated,
    gamesRemoved: summary.gamesRemoved,
    productsRemoved: summary.productsRemoved,
    fazerRetired: summary.fazerRetired,
    extrasCreated: summary.extrasCreated.length,
  });
  return summary;
}
