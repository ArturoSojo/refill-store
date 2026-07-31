/**
 * Catálogo inicial, transcrito del documento técnico de especificaciones.
 *
 * Los valores en `costUsd` son EXACTAMENTE los costos del proveedor que aparecen
 * en el PDF. El precio de venta (`priceUsd`) no viene dado allí: se calcula al
 * sembrar aplicando el margen por defecto de la configuración (25 %) y se puede
 * ajustar producto por producto —o en masa— desde el panel de administración.
 *
 * Sembrar es idempotente: los documentos usan IDs deterministas, así que volver
 * a ejecutarlo actualiza en lugar de duplicar. Por defecto NO pisa los precios
 * ya editados a mano (usa `overwritePrices: true` para forzarlo).
 */
import { games, products, now } from '../config/firebase';
import { applyMargin, round } from '../lib/money';
import { getConfig } from '../services/settings';
import type {
  DispatchCall,
  FulfillmentType,
  PlayerField,
  ProductKind,
} from '../types/models';

interface SeedGame {
  id: string;
  name: string;
  shortName: string;
  apiGameId: number;
  apiGameType: string;
  currencyLabel: string;
  currencyIcon: string;
  currencyIconUrl: string;
  playerFields: PlayerField[];
  validatesPlayerId: boolean;
  playerIdLabel: string;
  playerIdPattern: string;
  playerIdHelp: string;
  howToFindId: string[];
  logoUrl: string;
  coverUrl: string;
  accentColor: string;
  accentColorSecondary: string;
  sortOrder: number;
}

/** Campo de ID numérico, que es lo que piden casi todos los juegos. */
function idField(overrides: Partial<PlayerField> = {}): PlayerField {
  return {
    key: 'playerId',
    label: 'ID de Jugador',
    pattern: '^\\d{8,12}$',
    help: 'El ID tiene entre 8 y 12 dígitos, sólo números.',
    placeholder: 'Ej: 3363122817',
    type: 'number',
    providerField: 'player_id',
    required: true,
    sensitive: false,
    ...overrides,
  };
}

interface SeedProduct {
  id: string;
  gameId: string;
  sku: string;
  name: string;
  description: string;
  fulfillment: FulfillmentType;
  kind: ProductKind;
  amount: number;
  bonus: number;
  costUsd: number;
  calls: DispatchCall[];
  badge?: string | null;
  featured?: boolean;
  sortOrder: number;
}

// ---------------------------------------------------------------------------
// Juegos
// ---------------------------------------------------------------------------

export const SEED_GAMES: SeedGame[] = [
  {
    id: 'free-fire',
    name: 'Free Fire',
    shortName: 'Free Fire',
    apiGameId: -1,
    apiGameType: 'freefire_id',
    currencyLabel: 'Diamantes',
    currencyIcon: '💎',
    currencyIconUrl: '/coins/diamante-freefire.svg',
    // El único juego que rechaza un ID inexistente («Error de ID del jugador»).
    validatesPlayerId: true,
    playerFields: [
      idField({
        label: 'ID de Jugador',
        help: 'El ID de Free Fire tiene entre 8 y 12 dígitos, sólo números.',
      }),
    ],
    playerIdLabel: 'ID de Jugador',
    playerIdPattern: '^\\d{8,12}$',
    playerIdHelp: 'El ID de Free Fire tiene entre 8 y 12 dígitos, sólo números.',
    howToFindId: [
      'Abre Free Fire e ingresa a tu perfil (toca tu avatar arriba a la izquierda).',
      'Debajo de tu nombre aparece el ID de jugador.',
      'Toca el ícono de copiar y pégalo aquí.',
    ],
    logoUrl: '',
    coverUrl: '',
    accentColor: '#FF6B00',
    accentColorSecondary: '#FFB800',
    sortOrder: 1,
  },
  {
    id: 'blood-strike',
    name: 'Blood Strike',
    shortName: 'Blood Strike',
    apiGameId: 15,
    apiGameType: 'dynamic',
    currencyLabel: 'Gold',
    currencyIcon: '🪙',
    currencyIconUrl: '/coins/gold-bloodstrike.svg',
    validatesPlayerId: false,
    playerFields: [
      idField({
        label: 'ID de Jugador',
        help: 'El ID de Blood Strike tiene entre 8 y 12 dígitos, sólo números.',
      }),
    ],
    playerIdLabel: 'ID de Jugador',
    playerIdPattern: '^\\d{8,12}$',
    playerIdHelp: 'El ID de Blood Strike tiene entre 8 y 12 dígitos, sólo números.',
    howToFindId: [
      'Entra a Blood Strike y abre el menú de perfil.',
      'Tu ID numérico aparece junto a tu nombre de usuario.',
      'Cópialo y pégalo aquí sin espacios.',
    ],
    logoUrl: '',
    coverUrl: '',
    accentColor: '#E01E37',
    accentColorSecondary: '#8B0000',
    sortOrder: 2,
  },
  {
    id: 'mobile-legends',
    name: 'Mobile Legends',
    shortName: 'MLBB',
    apiGameId: 1,
    apiGameType: 'dynamic',
    currencyLabel: 'Diamantes',
    currencyIcon: '💎',
    currencyIconUrl: '/coins/diamante-mlbb.svg',
    validatesPlayerId: false,
    // Dos campos obligatorios: sin el Zone ID el proveedor responde
    // «Please insert Zone ID into input2» y la recarga no sale.
    playerFields: [
      idField({
        label: 'ID de Jugador',
        pattern: '^\\d{6,12}$',
        help: 'El ID de Mobile Legends tiene entre 6 y 12 dígitos.',
        placeholder: 'Ej: 123456789',
      }),
      {
        key: 'zoneId',
        label: 'Zone ID',
        pattern: '^\\d{3,6}$',
        help: 'El Zone ID es el número entre paréntesis, de 3 a 6 dígitos.',
        placeholder: 'Ej: 2345',
        type: 'number',
        providerField: 'player_id2',
        required: true,
        sensitive: false,
      },
    ],
    playerIdLabel: 'ID de Jugador',
    playerIdPattern: '^\\d{6,12}$',
    playerIdHelp: 'El ID de Mobile Legends tiene entre 6 y 12 dígitos.',
    howToFindId: [
      'Abre Mobile Legends y toca tu avatar arriba a la izquierda.',
      'En el perfil verás algo como «123456789 (2345)».',
      'El primer número es tu ID y el que va entre paréntesis es el Zone ID.',
    ],
    logoUrl: '',
    coverUrl: '',
    accentColor: '#2F80ED',
    accentColorSecondary: '#00C2FF',
    sortOrder: 3,
  },
  {
    id: 'honor-of-kings',
    name: 'Honor of Kings',
    shortName: 'HoK',
    apiGameId: 16,
    apiGameType: 'dynamic',
    currencyLabel: 'Tokens',
    currencyIcon: '🪙',
    currencyIconUrl: '/coins/token-hok.svg',
    validatesPlayerId: false,
    playerFields: [
      idField({
        label: 'ID de Jugador',
        pattern: '^\\d{6,14}$',
        help: 'El ID de Honor of Kings tiene entre 6 y 14 dígitos.',
      }),
    ],
    playerIdLabel: 'ID de Jugador',
    playerIdPattern: '^\\d{6,14}$',
    playerIdHelp: 'El ID de Honor of Kings tiene entre 6 y 14 dígitos.',
    howToFindId: [
      'Abre Honor of Kings y entra a tu perfil tocando tu avatar.',
      'Busca la opción «ID» debajo de tu nombre.',
      'Copia el número completo y pégalo aquí.',
    ],
    logoUrl: '',
    coverUrl: '',
    accentColor: '#C9A227',
    accentColorSecondary: '#8C6D1F',
    sortOrder: 4,
  },
  {
    id: 'marvel-rivals',
    name: 'Marvel Rivals',
    shortName: 'Marvel Rivals',
    apiGameId: 11,
    apiGameType: 'dynamic',
    currencyLabel: 'Lattices',
    currencyIcon: '🔷',
    currencyIconUrl: '/coins/lattice-marvel.svg',
    validatesPlayerId: false,
    playerFields: [
      idField({
        label: 'ID de Jugador',
        pattern: '^\\d{6,14}$',
        help: 'El ID de Marvel Rivals tiene entre 6 y 14 dígitos.',
      }),
    ],
    playerIdLabel: 'ID de Jugador',
    playerIdPattern: '^\\d{6,14}$',
    playerIdHelp: 'El ID de Marvel Rivals tiene entre 6 y 14 dígitos.',
    howToFindId: [
      'Abre Marvel Rivals y entra al menú de tu cuenta.',
      'Tu ID de jugador aparece junto al nombre de usuario.',
      'Cópialo y pégalo aquí sin espacios.',
    ],
    logoUrl: '',
    coverUrl: '',
    accentColor: '#5B6BF5',
    accentColorSecondary: '#9B5BF5',
    sortOrder: 5,
  },
];

// ---------------------------------------------------------------------------
// CATEGORÍA A — Recargas automáticas (API Inefable)
// ---------------------------------------------------------------------------

const FREE_FIRE_PACKAGES: SeedProduct[] = [
  {
    id: 'ff-d-110',
    gameId: 'free-fire',
    sku: 'FF-D-110',
    name: '100 + 10 Diamantes',
    description: 'Recarga directa de 110 diamantes a tu cuenta de Free Fire.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 100,
    bonus: 10,
    costUsd: 0.699,
    calls: [{ packageId: 1, quantity: 1 }],
    sortOrder: 10,
  },
  {
    id: 'ff-d-341',
    gameId: 'free-fire',
    sku: 'FF-D-341',
    name: '310 + 31 Diamantes',
    description: 'Recarga directa de 341 diamantes a tu cuenta de Free Fire.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 310,
    bonus: 31,
    costUsd: 2.11,
    calls: [{ packageId: 2, quantity: 1 }],
    badge: 'POPULAR',
    featured: true,
    sortOrder: 20,
  },
  {
    id: 'ff-d-572',
    gameId: 'free-fire',
    sku: 'FF-D-572',
    name: '520 + 52 Diamantes',
    description: 'Recarga directa de 572 diamantes a tu cuenta de Free Fire.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 520,
    bonus: 52,
    costUsd: 3.595,
    calls: [{ packageId: 3, quantity: 1 }],
    sortOrder: 30,
  },
  {
    id: 'ff-d-1166',
    gameId: 'free-fire',
    sku: 'FF-D-1166',
    name: '1.060 + 106 Diamantes',
    description: 'Recarga directa de 1.166 diamantes a tu cuenta de Free Fire.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 1060,
    bonus: 106,
    costUsd: 6.658,
    calls: [{ packageId: 4, quantity: 1 }],
    featured: true,
    sortOrder: 40,
  },
  {
    id: 'ff-d-2398',
    gameId: 'free-fire',
    sku: 'FF-D-2398',
    name: '2.180 + 218 Diamantes',
    description: 'Recarga directa de 2.398 diamantes a tu cuenta de Free Fire.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 2180,
    bonus: 218,
    costUsd: 13.1,
    calls: [{ packageId: 5, quantity: 1 }],
    sortOrder: 50,
  },
  {
    id: 'ff-d-6160',
    gameId: 'free-fire',
    sku: 'FF-D-6160',
    name: '5.600 + 560 Diamantes',
    description: 'Recarga directa de 6.160 diamantes a tu cuenta de Free Fire.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 5600,
    bonus: 560,
    costUsd: 34.1,
    calls: [{ packageId: 6, quantity: 1 }],
    badge: 'MÁXIMO',
    sortOrder: 60,
  },
];

/**
 * Combos: el backend ejecuta varias llamadas seguidas al proveedor.
 * `quantity: 2` sobre el mismo paquete = dos llamadas idénticas en secuencia.
 */
const FREE_FIRE_COMBOS: SeedProduct[] = [
  {
    id: 'ff-c-220',
    gameId: 'free-fire',
    sku: 'FF-C-220',
    name: '200 + 20 Diamantes',
    description: 'Combo de 220 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 200,
    bonus: 20,
    costUsd: 1.398,
    calls: [{ packageId: 1, quantity: 2 }],
    sortOrder: 15,
  },
  {
    id: 'ff-c-451',
    gameId: 'free-fire',
    sku: 'FF-C-451',
    name: '410 + 41 Diamantes',
    description: 'Combo de 451 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 410,
    bonus: 41,
    costUsd: 2.809,
    calls: [
      { packageId: 2, quantity: 1 },
      { packageId: 1, quantity: 1 },
    ],
    sortOrder: 25,
  },
  {
    id: 'ff-c-682',
    gameId: 'free-fire',
    sku: 'FF-C-682',
    name: '620 + 62 Diamantes',
    description: 'Combo de 682 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 620,
    bonus: 62,
    costUsd: 4.294,
    calls: [
      { packageId: 3, quantity: 1 },
      { packageId: 1, quantity: 1 },
    ],
    sortOrder: 35,
  },
  {
    id: 'ff-c-913',
    gameId: 'free-fire',
    sku: 'FF-C-913',
    name: '830 + 83 Diamantes',
    description: 'Combo de 913 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 830,
    bonus: 83,
    costUsd: 5.705,
    calls: [
      { packageId: 3, quantity: 1 },
      { packageId: 2, quantity: 1 },
    ],
    badge: 'COMBO',
    sortOrder: 45,
  },
];

const BLOOD_STRIKE_PACKAGES: SeedProduct[] = [
  {
    id: 'bs-g-56',
    gameId: 'blood-strike',
    sku: 'BS-G-56',
    name: '50 + 6 Gold',
    description: 'Recarga directa de 56 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 50,
    bonus: 6,
    costUsd: 0.5,
    calls: [{ packageId: 112, quantity: 1 }],
    sortOrder: 10,
  },
  {
    id: 'bs-g-105',
    gameId: 'blood-strike',
    sku: 'BS-G-105',
    name: '100 + 5 Gold',
    description: 'Recarga directa de 105 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 100,
    bonus: 5,
    costUsd: 0.75,
    calls: [{ packageId: 96, quantity: 1 }],
    sortOrder: 20,
  },
  {
    id: 'bs-g-320',
    gameId: 'blood-strike',
    sku: 'BS-G-320',
    name: '300 + 20 Gold',
    description: 'Recarga directa de 320 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 300,
    bonus: 20,
    costUsd: 2.28,
    calls: [{ packageId: 97, quantity: 1 }],
    badge: 'POPULAR',
    featured: true,
    sortOrder: 30,
  },
  {
    id: 'bs-g-540',
    gameId: 'blood-strike',
    sku: 'BS-G-540',
    name: '500 + 40 Gold',
    description: 'Recarga directa de 540 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 500,
    bonus: 40,
    costUsd: 3.76,
    calls: [{ packageId: 98, quantity: 1 }],
    sortOrder: 40,
  },
  {
    id: 'bs-g-1100',
    gameId: 'blood-strike',
    sku: 'BS-G-1100',
    name: '1.000 + 100 Gold',
    description: 'Recarga directa de 1.100 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 1000,
    bonus: 100,
    costUsd: 8.3,
    calls: [{ packageId: 99, quantity: 1 }],
    featured: true,
    sortOrder: 50,
  },
  {
    id: 'bs-g-2260',
    gameId: 'blood-strike',
    sku: 'BS-G-2260',
    name: '2.000 + 260 Gold',
    description: 'Recarga directa de 2.260 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 2000,
    bonus: 260,
    costUsd: 15.31,
    calls: [{ packageId: 100, quantity: 1 }],
    sortOrder: 60,
  },
  {
    id: 'bs-g-5800',
    gameId: 'blood-strike',
    sku: 'BS-G-5800',
    name: '5.000 + 800 Gold',
    description: 'Recarga directa de 5.800 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 5000,
    bonus: 800,
    costUsd: 37.35,
    calls: [{ packageId: 101, quantity: 1 }],
    badge: 'MÁXIMO',
    sortOrder: 70,
  },
];

// ---------------------------------------------------------------------------
// Juegos añadidos después del documento original
//
// Los `package_id` y los costos salen del catálogo vivo del proveedor
// (`GET /api/v1/products`), no del PDF: son los únicos que el API reconoce.
// ---------------------------------------------------------------------------

/** Genera los paquetes de un juego a partir de la tabla del proveedor. */
function packagesFor(
  gameId: string,
  skuPrefix: string,
  currency: string,
  rows: Array<{
    packageId: number;
    /** Cantidad base de moneda. */
    amount: number;
    bonus?: number;
    costUsd: number;
    /** Nombre propio cuando no es una cantidad de moneda (pases, tarjetas). */
    name?: string;
    badge?: string | null;
    featured?: boolean;
  }>
): SeedProduct[] {
  return rows.map((row, index) => {
    const isSpecial = Boolean(row.name);
    const total = row.amount + (row.bonus ?? 0);
    const name =
      row.name ??
      (row.bonus
        ? `${row.amount.toLocaleString('es-VE')} + ${row.bonus.toLocaleString('es-VE')} ${currency}`
        : `${row.amount.toLocaleString('es-VE')} ${currency}`);

    return {
      id: `${gameId}-${row.packageId}`,
      gameId,
      sku: `${skuPrefix}-${row.packageId}`,
      name,
      description: isSpecial
        ? `${row.name} para tu cuenta. Se acredita automáticamente.`
        : `Recarga directa de ${total.toLocaleString('es-VE')} ${currency} a tu cuenta.`,
      fulfillment: 'auto' as FulfillmentType,
      kind: (isSpecial ? 'special' : 'package') as ProductKind,
      amount: isSpecial ? 1 : row.amount,
      bonus: isSpecial ? 0 : (row.bonus ?? 0),
      costUsd: row.costUsd,
      calls: [{ packageId: row.packageId, quantity: 1 }],
      badge: row.badge ?? null,
      featured: row.featured ?? false,
      sortOrder: (index + 1) * 10,
    };
  });
}

const MOBILE_LEGENDS_PACKAGES = packagesFor('mobile-legends', 'ML-D', 'Diamantes', [
  { packageId: 1, amount: 78, bonus: 8, costUsd: 1.24 },
  { packageId: 2, amount: 156, bonus: 16, costUsd: 2.4, badge: 'POPULAR', featured: true },
  { packageId: 3, amount: 234, bonus: 23, costUsd: 3.63 },
  { packageId: 4, amount: 625, bonus: 81, costUsd: 9.55, featured: true },
  { packageId: 5, amount: 1860, bonus: 335, costUsd: 28.14 },
  { packageId: 6, amount: 3099, bonus: 589, costUsd: 46.93 },
  { packageId: 7, amount: 4649, bonus: 883, costUsd: 69.49 },
  { packageId: 8, amount: 7740, bonus: 1548, costUsd: 119.75, badge: 'MÁXIMO' },
  { packageId: 9, amount: 0, costUsd: 1.54, name: 'Pase de Diamantes' },
  { packageId: 49, amount: 0, costUsd: 7.84, name: 'Twilight Pass' },
]);

const HONOR_OF_KINGS_PACKAGES = packagesFor('honor-of-kings', 'HOK-T', 'Tokens', [
  { packageId: 102, amount: 16, costUsd: 0.22 },
  { packageId: 103, amount: 80, costUsd: 0.88 },
  { packageId: 104, amount: 240, costUsd: 2.65, badge: 'POPULAR', featured: true },
  { packageId: 105, amount: 400, costUsd: 4.64 },
  { packageId: 106, amount: 560, costUsd: 6.02 },
  { packageId: 107, amount: 800, costUsd: 9.07, featured: true },
  { packageId: 108, amount: 1200, costUsd: 13.12 },
  { packageId: 109, amount: 2400, costUsd: 26.65 },
  { packageId: 110, amount: 4000, costUsd: 45.29 },
  { packageId: 111, amount: 8000, costUsd: 90.53, badge: 'MÁXIMO' },
]);

const MARVEL_RIVALS_PACKAGES = packagesFor('marvel-rivals', 'MR-L', 'Lattices', [
  { packageId: 90, amount: 100, costUsd: 1.08 },
  { packageId: 91, amount: 500, costUsd: 4.78, badge: 'POPULAR', featured: true },
  { packageId: 92, amount: 1000, costUsd: 9.93, featured: true },
  { packageId: 93, amount: 2180, costUsd: 19.06 },
  { packageId: 94, amount: 5680, costUsd: 47.64 },
  { packageId: 95, amount: 11680, costUsd: 96.23, badge: 'MÁXIMO' },
]);

// ---------------------------------------------------------------------------
// CATEGORÍA B — Recargas manuales (se entregan por WhatsApp)
// ---------------------------------------------------------------------------

const MANUAL_PRODUCTS: SeedProduct[] = [
  // Free Fire
  {
    id: 'ff-m-pase-booyah',
    gameId: 'free-fire',
    sku: 'FF-M-BOOYAH',
    name: 'Pase Booyah',
    description: 'Pase Booyah de Free Fire. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 3.15,
    calls: [],
    sortOrder: 110,
  },
  {
    id: 'ff-m-tarjeta-semanal',
    gameId: 'free-fire',
    sku: 'FF-M-SEMANAL',
    name: 'Tarjeta Semanal',
    description: 'Tarjeta semanal de Free Fire. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 2.35,
    calls: [],
    badge: 'POPULAR',
    sortOrder: 120,
  },
  {
    id: 'ff-m-tarjeta-mensual',
    gameId: 'free-fire',
    sku: 'FF-M-MENSUAL',
    name: 'Tarjeta Mensual',
    description: 'Tarjeta mensual de Free Fire. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 10.56,
    calls: [],
    sortOrder: 130,
  },
  {
    id: 'ff-m-aumento-nivel',
    gameId: 'free-fire',
    sku: 'FF-M-NIVEL',
    name: 'Paquete Aumento de Nivel',
    description: 'Paquete de aumento de nivel. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 4.55,
    calls: [],
    sortOrder: 140,
  },
  // Blood Strike
  {
    id: 'bs-m-cofre-aspecto-ultra',
    gameId: 'blood-strike',
    sku: 'BS-M-COFRE',
    name: 'Cofre de Aspecto Ultra',
    description: 'Cofre de aspecto ultra. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 0.57,
    calls: [],
    sortOrder: 110,
  },
  {
    id: 'bs-m-pase-temporada',
    gameId: 'blood-strike',
    sku: 'BS-M-TEMPORADA',
    name: 'Pase de Temporada',
    description: 'Pase de temporada. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 1.15,
    calls: [],
    sortOrder: 120,
  },
  {
    id: 'bs-m-bolsa-suerte',
    gameId: 'blood-strike',
    sku: 'BS-M-BOLSA',
    name: 'Bolsa de la Suerte',
    description: 'Bolsa de la suerte. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 1.15,
    calls: [],
    sortOrder: 130,
  },
  {
    id: 'bs-m-pase-mejora',
    gameId: 'blood-strike',
    sku: 'BS-M-MEJORA',
    name: 'Pase de Mejora',
    description: 'Pase de mejora. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 2.6,
    calls: [],
    sortOrder: 140,
  },
  {
    id: 'bs-m-pase-elite',
    gameId: 'blood-strike',
    sku: 'BS-M-ELITE',
    name: 'Pase Elite',
    description: 'Pase elite. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 4.45,
    calls: [],
    sortOrder: 150,
  },
  {
    id: 'bs-m-pase-premium',
    gameId: 'blood-strike',
    sku: 'BS-M-PREMIUM',
    name: 'Pase Premium',
    description: 'Pase premium. Se gestiona con un asesor por WhatsApp.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 9.35,
    calls: [],
    sortOrder: 160,
  },
];

export const SEED_PRODUCTS: SeedProduct[] = [
  ...FREE_FIRE_PACKAGES,
  ...FREE_FIRE_COMBOS,
  ...BLOOD_STRIKE_PACKAGES,
  ...MOBILE_LEGENDS_PACKAGES,
  ...HONOR_OF_KINGS_PACKAGES,
  ...MARVEL_RIVALS_PACKAGES,
  ...MANUAL_PRODUCTS,
];

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export interface SeedResult {
  gamesCreated: number;
  gamesUpdated: number;
  productsCreated: number;
  productsUpdated: number;
  marginPercent: number;
}

export async function seedCatalog(
  options: { overwritePrices?: boolean } = {}
): Promise<SeedResult> {
  const config = await getConfig({ fresh: true });
  const margin = config.pricing.defaultMarginPercent;
  const roundStep = config.pricing.roundToUsd;
  const timestamp = now();

  const result: SeedResult = {
    gamesCreated: 0,
    gamesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    marginPercent: margin,
  };

  for (const game of SEED_GAMES) {
    const ref = games().doc(game.id);
    const snap = await ref.get();

    if (snap.exists) {
      // Sólo se refrescan los datos técnicos; lo visual (colores, imágenes,
      // textos) puede haber sido personalizado desde el panel y se respeta.
      const stored = snap.data() ?? {};
      const patch: Record<string, unknown> = {
        apiGameId: game.apiGameId,
        apiGameType: game.apiGameType,
        currencyLabel: game.currencyLabel,
        // Los campos del formulario SÍ son técnicos: si Mobile Legends se queda
        // sin su Zone ID, ninguna recarga de ese juego sale.
        playerFields: game.playerFields,
        validatesPlayerId: game.validatesPlayerId,
        updatedAt: timestamp,
      };

      // El ícono es decorativo: sólo se rellena si el juego aún no tiene uno,
      // para no pisar el que haya subido el administrador.
      if (!stored.currencyIconUrl) patch.currencyIconUrl = game.currencyIconUrl;

      await ref.set(patch, { merge: true });
      result.gamesUpdated += 1;
    } else {
      await ref.set({
        ...game,
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      result.gamesCreated += 1;
    }
  }

  for (const product of SEED_PRODUCTS) {
    const ref = products().doc(product.id);
    const snap = await ref.get();
    const priceUsd = applyMargin(product.costUsd, margin, roundStep);

    if (snap.exists) {
      const patch: Record<string, unknown> = {
        gameId: product.gameId,
        sku: product.sku,
        name: product.name,
        fulfillment: product.fulfillment,
        kind: product.kind,
        amount: product.amount,
        bonus: product.bonus,
        costUsd: round(product.costUsd, 4),
        calls: product.calls,
        updatedAt: timestamp,
      };
      if (options.overwritePrices) patch.priceUsd = priceUsd;

      await ref.set(patch, { merge: true });
      result.productsUpdated += 1;
    } else {
      await ref.set({
        gameId: product.gameId,
        sku: product.sku,
        name: product.name,
        description: product.description,
        fulfillment: product.fulfillment,
        kind: product.kind,
        amount: product.amount,
        bonus: product.bonus,
        costUsd: round(product.costUsd, 4),
        priceUsd,
        compareAtUsd: null,
        calls: product.calls,
        imageUrl: '',
        badge: product.badge ?? null,
        active: true,
        featured: product.featured ?? false,
        sortOrder: product.sortOrder,
        stock: null,
        deliveryEtaMinutes: product.fulfillment === 'auto' ? 2 : 15,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      result.productsCreated += 1;
    }
  }

  return result;
}
