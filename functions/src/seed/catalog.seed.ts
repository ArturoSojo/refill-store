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
  priceUsd?: number;
  compareAtUsd?: number | null;
  provider?: 'inefable' | 'fazercards' | 'centralone';
  active?: boolean;
  calls: DispatchCall[];
  centralOneProductId?: string | null;
  targetFields?: string[];
  /**
   * Icono propio del producto. Los pases y tarjetas lo necesitan: sin él la
   * tarjeta cae al ícono de la moneda del juego y un Pase Booyah aparece con un
   * diamante, que no es lo que entrega.
   */
  imageUrl?: string;
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
    // El juego base sigue usando Inefable game_id 1. Los paquetes de
    // «Free Fire 20%» (game_id 24) se seleccionan explícitamente por llamada.
    apiGameId: 1,
    apiGameType: 'dynamic',
    currencyLabel: 'Diamantes',
    currencyIcon: '💎',
    currencyIconUrl: '/coins/diamante-freefire.svg',
    // Lo que se paga por ese descuento: siendo `dynamic`, el proveedor ya no
    // comprueba el ID —devuelve `player_name` vacío— y acepta cualquier número.
    // Con `-1` sí lo rechazaba. Por eso la tienda exige confirmar los datos.
    validatesPlayerId: false,
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

/**
 * Paquetes de Free Fire.
 *
 * La ruta base de Free Fire usa los paquetes de `game_id 1`. El paquete de
 * 520+52 y los combos que lo incluyen usan `game_id 24` («Free fire 20%»),
 * seleccionado en cada llamada porque un `package_id` sólo tiene sentido
 * dentro de su juego.
 *
 * Ojo con el de 2.160: en la ruta `-1` ese paquete daba 2.180 diamantes y aquí
 * da 20 menos. El nombre tiene que decir lo que se entrega de verdad.
 */
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
    costUsd: 0.719,
    calls: [{ packageId: 6, quantity: 1 }],
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
    costUsd: 2.16,
    calls: [{ packageId: 3, quantity: 1 }],
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
    costUsd: 3.63,
    calls: [{ packageId: 171, quantity: 1, providerGameId: 24 }],
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
    costUsd: 6.77,
    calls: [{ packageId: 2, quantity: 1 }],
    featured: true,
    sortOrder: 40,
  },
  {
    // El id del documento se conserva («…-2398») aunque ahora entregue 2.378:
    // las órdenes ya emitidas apuntan a él y renombrarlo las dejaría huérfanas.
    id: 'ff-d-2398',
    gameId: 'free-fire',
    sku: 'FF-D-2378',
    name: '2.160 + 218 Diamantes',
    description: 'Recarga directa de 2.378 diamantes a tu cuenta de Free Fire.',
    fulfillment: 'auto',
    kind: 'package',
    amount: 2160,
    bonus: 218,
    costUsd: 13.45,
    calls: [{ packageId: 1, quantity: 1 }],
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
    costUsd: 34.3,
    calls: [{ packageId: 4, quantity: 1 }],
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
    id: 'ff-c-451',
    gameId: 'free-fire',
    sku: 'FF-C-451',
    name: '410 + 41 Diamantes',
    description: 'Combo de 451 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 410,
    bonus: 41,
    costUsd: 2.879,
    calls: [
      { packageId: 1, quantity: 1 },
      { packageId: 2, quantity: 1 },
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
    costUsd: 4.349,
    calls: [
      { packageId: 6, quantity: 1 },
      { packageId: 171, quantity: 1, providerGameId: 24 },
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
    costUsd: 5.79,
    calls: [
      { packageId: 3, quantity: 1 },
      { packageId: 171, quantity: 1, providerGameId: 24 },
    ],
    badge: 'COMBO',
    sortOrder: 45,
  },
  {
    id: 'ff-c-1738',
    gameId: 'free-fire',
    sku: 'FF-C-1738',
    name: '1.580 + 158 Diamantes',
    description: 'Combo de 1.738 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 1580,
    bonus: 158,
    costUsd: 10.40,
    calls: [
      { packageId: 2, quantity: 1 },
      { packageId: 171, quantity: 1, providerGameId: 24 },
    ],
    badge: 'COMBO',
    sortOrder: 48,
  },
  {
    id: 'ff-c-3542',
    gameId: 'free-fire',
    sku: 'FF-C-3542',
    name: '3.220 + 322 Diamantes',
    description: 'Combo de 3.542 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 3220,
    bonus: 322,
    costUsd: 20.22,
    calls: [
      { packageId: 1, quantity: 1 },
      { packageId: 2, quantity: 1 },
    ],
    badge: 'COMBO',
    sortOrder: 55,
  },
  {
    id: 'ff-c-8536',
    gameId: 'free-fire',
    sku: 'FF-C-8536',
    name: '7.760 + 776 Diamantes',
    description: 'Combo de 8.536 diamantes (se acredita en 2 recargas seguidas).',
    fulfillment: 'auto',
    kind: 'combo',
    amount: 7760,
    bonus: 776,
    costUsd: 47.75,
    calls: [
      { packageId: 4, quantity: 1 },
      { packageId: 1, quantity: 1 },
    ],
    badge: 'COMBO',
    sortOrder: 65,
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
    costUsd: 0.45,
    priceUsd: 0.75,
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
    provider: 'centralone',
    amount: 100,
    bonus: 5,
    costUsd: 0.7041,
    priceUsd: 0.95,
    calls: [{ packageId: 'ebc6b685-9d50-4d42-9aae-48e8c089a793', quantity: 1, provider: 'centralone' }],
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
    provider: 'centralone',
    amount: 300,
    bonus: 20,
    costUsd: 2.1172,
    priceUsd: 2.95,
    calls: [{ packageId: '35213545-bd4b-4e0b-8e76-b6ef476df25a', quantity: 1, provider: 'centralone' }],
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
    provider: 'centralone',
    amount: 500,
    bonus: 40,
    costUsd: 3.5278,
    priceUsd: 4.76,
    calls: [{ packageId: 'a4600212-f5a1-40ab-805a-5a549c3b5fba', quantity: 1, provider: 'centralone' }],
    sortOrder: 40,
  },
  {
    id: 'bs-g-645',
    gameId: 'blood-strike',
    sku: 'BS-G-645',
    name: '645 Gold',
    description: 'Recarga directa de 645 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    provider: 'centralone',
    amount: 600,
    bonus: 45,
    costUsd: 4.2319,
    priceUsd: 5.72,
    calls: [
      { packageId: 'a4600212-f5a1-40ab-805a-5a549c3b5fba', quantity: 1, provider: 'centralone' },
      { packageId: 'ebc6b685-9d50-4d42-9aae-48e8c089a793', quantity: 1, provider: 'centralone' },
    ],
    sortOrder: 45,
  },
  {
    id: 'bs-g-1100',
    gameId: 'blood-strike',
    sku: 'BS-G-1100',
    name: '1.000 + 100 Gold',
    description: 'Recarga directa de 1.100 Gold a tu cuenta de Blood Strike.',
    fulfillment: 'auto',
    kind: 'package',
    provider: 'centralone',
    amount: 1000,
    bonus: 100,
    costUsd: 7.0555,
    priceUsd: 9.52,
    calls: [{ packageId: '13f92eb4-f186-41d7-b4b0-432aa9b9f0d9', quantity: 1, provider: 'centralone' }],
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
    provider: 'centralone',
    amount: 2000,
    bonus: 260,
    costUsd: 14.1112,
    priceUsd: 18.99,
    calls: [{ packageId: '17b5a2e5-8820-440a-a8a5-b30913a6fad8', quantity: 1, provider: 'centralone' }],
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
    provider: 'centralone',
    amount: 5000,
    bonus: 800,
    costUsd: 35.2753,
    priceUsd: 47.00,
    calls: [{ packageId: '8f29be10-34de-456c-86e9-698353ede6bb', quantity: 1, provider: 'centralone' }],
    badge: 'MÁXIMO',
    sortOrder: 70,
  },
];

const BLOOD_STRIKE_COMBOS: SeedProduct[] = [
  {
    id: 'bs-c-425',
    gameId: 'blood-strike',
    sku: 'BS-C-425',
    name: '425 Gold',
    description: 'Combo de 425 Gold para Blood Strike (105 + 320 Gold). Recarga rápida y directa a tu cuenta.',
    fulfillment: 'auto',
    kind: 'combo',
    provider: 'centralone',
    amount: 400,
    bonus: 25,
    costUsd: 2.8213,
    priceUsd: 3.82,
    calls: [
      { packageId: 'ebc6b685-9d50-4d42-9aae-48e8c089a793', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
      { packageId: '35213545-bd4b-4e0b-8e76-b6ef476df25a', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
    ],
    badge: 'COMBO',
    sortOrder: 25,
  },
  {
    id: 'bs-c-860',
    gameId: 'blood-strike',
    sku: 'BS-C-860',
    name: '860 Gold',
    description: 'Combo de 860 Gold para Blood Strike (540 + 320 Gold). Recarga rápida y directa a tu cuenta.',
    fulfillment: 'auto',
    kind: 'combo',
    provider: 'centralone',
    amount: 800,
    bonus: 60,
    costUsd: 5.645,
    priceUsd: 7.60,
    calls: [
      { packageId: 'a4600212-f5a1-40ab-805a-5a549c3b5fba', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
      { packageId: '35213545-bd4b-4e0b-8e76-b6ef476df25a', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
    ],
    badge: 'COMBO',
    sortOrder: 48,
  },
  {
    id: 'bs-c-1620',
    gameId: 'blood-strike',
    sku: 'BS-C-1620',
    name: '1.640 Gold',
    description: 'Combo de 1.640 Gold para Blood Strike (1100 + 540 Gold). Recarga rápida y directa a tu cuenta.',
    fulfillment: 'auto',
    kind: 'combo',
    provider: 'centralone',
    amount: 1500,
    bonus: 140,
    costUsd: 10.5833,
    priceUsd: 14.28,
    calls: [
      { packageId: '13f92eb4-f186-41d7-b4b0-432aa9b9f0d9', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
      { packageId: 'a4600212-f5a1-40ab-805a-5a549c3b5fba', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
    ],
    badge: 'COMBO',
    sortOrder: 55,
  },
  {
    id: 'bs-c-3340',
    gameId: 'blood-strike',
    sku: 'BS-C-3340',
    name: '3.360 Gold',
    description: 'Combo de 3.360 Gold para Blood Strike (2260 + 1100 Gold). Recarga rápida y directa a tu cuenta.',
    fulfillment: 'auto',
    kind: 'combo',
    provider: 'centralone',
    amount: 3000,
    bonus: 360,
    costUsd: 21.1667,
    priceUsd: 28.51,
    calls: [
      { packageId: '17b5a2e5-8820-440a-a8a5-b30913a6fad8', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
      { packageId: '13f92eb4-f186-41d7-b4b0-432aa9b9f0d9', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
    ],
    badge: 'COMBO',
    sortOrder: 65,
  },
  {
    id: 'bs-c-8060',
    gameId: 'blood-strike',
    sku: 'BS-C-8060',
    name: '8.060 Gold',
    description: 'Combo de 8.060 Gold para Blood Strike (5800 + 2260 Gold). Recarga rápida y directa a tu cuenta.',
    fulfillment: 'auto',
    kind: 'combo',
    provider: 'centralone',
    amount: 7000,
    bonus: 1060,
    costUsd: 49.3865,
    priceUsd: 66.13,
    calls: [
      { packageId: '8f29be10-34de-456c-86e9-698353ede6bb', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
      { packageId: '17b5a2e5-8820-440a-a8a5-b30913a6fad8', quantity: 1, provider: 'centralone', targetFields: ['game_user_id'] },
    ],
    badge: 'COMBO',
    sortOrder: 75,
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
    name: 'Pase Booyah Premium',
    description: 'Pase Booyah Premium de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 2.1149,
    priceUsd: 3.30,
    calls: [
      {
        packageId: '7eed3f72-b3fb-45e6-b8e5-9503e4aafcfa',
        quantity: 1,
        provider: 'centralone',
      },
    ],
    imageUrl: '/products/pase-booyah.svg',
    sortOrder: 110,
    active: true,
  },
  {
    id: 'ff-m-basica',
    gameId: 'free-fire',
    sku: 'FF-M-BASICA',
    name: 'Tarjeta Semanal Básica',
    description: 'Tarjeta semanal básica de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 0.3518,
    priceUsd: 0.55,
    calls: [
      {
        packageId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
    targetFields: ['player_id'],
    imageUrl: 'https://storage.googleapis.com/refill-e254f-catalogo/catalog/productos/1793403535802-f8bf1e58.webp',
    sortOrder: 115,
    active: true,
  },
  {
    id: 'ff-m-tarjeta-semanal',
    gameId: 'free-fire',
    sku: 'FF-M-SEMANAL',
    name: 'Tarjeta Semanal',
    description: 'Tarjeta semanal de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 1.5075,
    priceUsd: 2.11,
    calls: [
      {
        packageId: 'e30be2a9-6490-4a21-a160-780aa679804c',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'e30be2a9-6490-4a21-a160-780aa679804c',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-semanal.svg',
    badge: 'POPULAR',
    sortOrder: 120,
    active: true,
  },
  {
    id: 'ff-m-tarjeta-mensual',
    gameId: 'free-fire',
    sku: 'FF-M-MENSUAL',
    name: 'Tarjeta Mensual',
    description: 'Tarjeta mensual de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 5.5491,
    priceUsd: 7.55,
    calls: [
      {
        packageId: 'ed068136-f25b-4486-bdc3-f4654b725030',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'ed068136-f25b-4486-bdc3-f4654b725030',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-mensual.svg',
    sortOrder: 130,
    active: true,
  },
  // Tarjetas para Free Fire ID (freefire-id) con Best-Price Routing
  {
    id: 'freefire-id--co-47bba141-8980-47f7-b4bd-2e264c2d9930',
    gameId: 'freefire-id',
    sku: 'FF-ID-CO-BASICA',
    name: 'Tarjeta Semanal Básica',
    description: 'Tarjeta semanal básica de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 0.3518,
    priceUsd: 0.55,
    calls: [
      {
        packageId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
    targetFields: ['player_id'],
    imageUrl: 'https://storage.googleapis.com/refill-e254f-catalogo/catalog/productos/1793403535802-f8bf1e58.webp',
    sortOrder: 115,
    active: true,
  },
  {
    id: 'freefire-id--co-e30be2a9-6490-4a21-a160-780aa679804c',
    gameId: 'freefire-id',
    sku: 'FF-ID-CO-SEMANAL',
    name: 'Tarjeta Semanal',
    description: 'Tarjeta semanal de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 1.5075,
    priceUsd: 2.11,
    calls: [
      {
        packageId: 'e30be2a9-6490-4a21-a160-780aa679804c',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'e30be2a9-6490-4a21-a160-780aa679804c',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-semanal.svg',
    badge: 'POPULAR',
    sortOrder: 120,
    active: true,
  },
  {
    id: 'freefire-id--co-6f98867c-a84e-418e-ab54-83f1da1fdee2',
    gameId: 'freefire-id',
    sku: 'FF-ID-CO-MENSUAL',
    name: 'Tarjeta Mensual',
    description: 'Tarjeta mensual de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 5.5491,
    priceUsd: 7.55,
    calls: [
      {
        packageId: 'ed068136-f25b-4486-bdc3-f4654b725030',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'ed068136-f25b-4486-bdc3-f4654b725030',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-mensual.svg',
    sortOrder: 130,
    active: true,
  },
  // Tarjetas para Free Fire LATAM (co-topup-free-fire-latam) con Best-Price Routing
  {
    id: 'co-topup-free-fire-latam--47bba141-8980-47f7-b4bd-2e264c2d9930',
    gameId: 'co-topup-free-fire-latam',
    sku: 'CO-FF-LATAM-BASICA',
    name: 'Tarjeta Semanal Básica',
    description: 'Tarjeta semanal básica de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 0.3518,
    priceUsd: 0.55,
    calls: [
      {
        packageId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
    targetFields: ['player_id'],
    imageUrl: 'https://storage.googleapis.com/refill-e254f-catalogo/catalog/productos/1793403535802-f8bf1e58.webp',
    sortOrder: 115,
    active: true,
  },
  {
    id: 'co-topup-free-fire-latam--e30be2a9-6490-4a21-a160-780aa679804c',
    gameId: 'co-topup-free-fire-latam',
    sku: 'CO-FF-LATAM-SEMANAL',
    name: 'Tarjeta Semanal',
    description: 'Tarjeta semanal de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 1.5075,
    priceUsd: 2.11,
    calls: [
      {
        packageId: 'e30be2a9-6490-4a21-a160-780aa679804c',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'e30be2a9-6490-4a21-a160-780aa679804c',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-semanal.svg',
    badge: 'POPULAR',
    sortOrder: 120,
    active: true,
  },
  {
    id: 'co-topup-free-fire-latam--6f98867c-a84e-418e-ab54-83f1da1fdee2',
    gameId: 'co-topup-free-fire-latam',
    sku: 'CO-FF-LATAM-MENSUAL',
    name: 'Tarjeta Mensual',
    description: 'Tarjeta mensual de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 5.5491,
    priceUsd: 7.55,
    calls: [
      {
        packageId: 'ed068136-f25b-4486-bdc3-f4654b725030',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'ed068136-f25b-4486-bdc3-f4654b725030',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-mensual.svg',
    sortOrder: 130,
    active: true,
  },
  // Tarjetas para Free Fire GLOBAL (co-topup-free-fire-global) con Best-Price Routing
  {
    id: 'co-topup-free-fire-global--63540ac0-e4bf-4ce2-afcc-567fa305418b',
    gameId: 'co-topup-free-fire-global',
    sku: 'CO-FF-GLOBAL-BASICA',
    name: 'Tarjeta Semanal Básica',
    description: 'Tarjeta semanal básica de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 0.3518,
    priceUsd: 0.55,
    calls: [
      {
        packageId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: '47bba141-8980-47f7-b4bd-2e264c2d9930',
    targetFields: ['player_id'],
    imageUrl: 'https://storage.googleapis.com/refill-e254f-catalogo/catalog/productos/1793403535802-f8bf1e58.webp',
    sortOrder: 115,
    active: true,
  },
  {
    id: 'co-topup-free-fire-global--10b8f3ff-4fe4-452e-adc5-f765b6b1ff1a',
    gameId: 'co-topup-free-fire-global',
    sku: 'CO-FF-GLOBAL-SEMANAL',
    name: 'Tarjeta Semanal',
    description: 'Tarjeta semanal de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 1.5075,
    priceUsd: 2.11,
    calls: [
      {
        packageId: 'e30be2a9-6490-4a21-a160-780aa679804c',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'e30be2a9-6490-4a21-a160-780aa679804c',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-semanal.svg',
    badge: 'POPULAR',
    sortOrder: 120,
    active: true,
  },
  {
    id: 'co-topup-free-fire-global--ed068136-f25b-4486-bdc3-f4654b725030',
    gameId: 'co-topup-free-fire-global',
    sku: 'CO-FF-GLOBAL-MENSUAL',
    name: 'Tarjeta Mensual',
    description: 'Tarjeta mensual de Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    provider: 'centralone',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 5.5491,
    priceUsd: 7.55,
    calls: [
      {
        packageId: 'ed068136-f25b-4486-bdc3-f4654b725030',
        quantity: 1,
        provider: 'centralone',
        targetFields: ['player_id'],
      },
    ],
    centralOneProductId: 'ed068136-f25b-4486-bdc3-f4654b725030',
    targetFields: ['player_id'],
    imageUrl: '/products/tarjeta-mensual.svg',
    sortOrder: 130,
    active: true,
  },
  {
    id: 'ff-m-aumento-nivel',
    gameId: 'free-fire',
    sku: 'FF-M-NIVEL',
    name: 'Paquete Aumento de Nivel',
    description: 'Paquete de aumento de nivel manual antiguo. Reemplazado por automatización Central One.',
    fulfillment: 'manual',
    kind: 'special',
    amount: 1,
    bonus: 0,
    costUsd: 4.55,
    calls: [],
    imageUrl: '/products/aumento-nivel.svg',
    sortOrder: 140,
    active: false,
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
    imageUrl: '/products/cofre.svg',
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
    imageUrl: '/products/pase-temporada.svg',
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
    imageUrl: '/products/bolsa-suerte.svg',
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
    imageUrl: '/products/pase-mejora.svg',
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
    imageUrl: '/products/pase-elite.svg',
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
    imageUrl: '/products/pase-premium.svg',
    sortOrder: 160,
  },
];

export const FREE_FIRE_LEVEL_UP_PACKAGES: SeedProduct[] = [
  {
    id: 'ff-co-nivel-6',
    gameId: 'free-fire',
    sku: 'FF-CO-NIVEL-6',
    name: 'Paquete Subida de Nivel 6',
    description: 'Paquete de mejora de nivel 6 para Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    kind: 'level_up',
    provider: 'centralone',
    amount: 6,
    bonus: 0,
    costUsd: 0.2018,
    priceUsd: 0.40,
    compareAtUsd: 0.60,
    calls: [
      {
        packageId: '00147efa-cc79-4767-8306-9b5dc45e2757',
        quantity: 1,
        provider: 'centralone',
      },
    ],
    imageUrl: '/products/aumento-nivel.svg',
    sortOrder: 201,
    active: true,
  },
  {
    id: 'ff-co-nivel-10',
    gameId: 'free-fire',
    sku: 'FF-CO-NIVEL-10',
    name: 'Paquete Subida de Nivel 10',
    description: 'Paquete de subida de nivel 10 para Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    kind: 'level_up',
    provider: 'centralone',
    amount: 10,
    bonus: 0,
    costUsd: 0.3323,
    priceUsd: 0.60,
    compareAtUsd: 0.90,
    calls: [
      {
        packageId: '0d351e69-6360-42bc-9b83-94de2c26b4be',
        quantity: 1,
        provider: 'centralone',
      },
    ],
    imageUrl: '/products/aumento-nivel.svg',
    sortOrder: 202,
    active: true,
  },
  {
    id: 'ff-co-nivel-15',
    gameId: 'free-fire',
    sku: 'FF-CO-NIVEL-15',
    name: 'Paquete Subida de Nivel 15',
    description: 'Paquete de subida de nivel 15 para Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    kind: 'level_up',
    provider: 'centralone',
    amount: 15,
    bonus: 0,
    costUsd: 0.3323,
    priceUsd: 0.60,
    compareAtUsd: 0.90,
    calls: [
      {
        packageId: '3e2b9bd8-2293-4bd4-8978-316603eec328',
        quantity: 1,
        provider: 'centralone',
      },
    ],
    imageUrl: '/products/aumento-nivel.svg',
    sortOrder: 203,
    active: true,
  },
  {
    id: 'ff-co-nivel-20',
    gameId: 'free-fire',
    sku: 'FF-CO-NIVEL-20',
    name: 'Paquete Subida de Nivel 20',
    description: 'Paquete de subida de nivel 20 para Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    kind: 'level_up',
    provider: 'centralone',
    amount: 20,
    bonus: 0,
    costUsd: 0.3323,
    priceUsd: 0.60,
    compareAtUsd: 0.90,
    calls: [
      {
        packageId: '549739d0-f988-4d5d-9b18-5357bd8de9fa',
        quantity: 1,
        provider: 'centralone',
      },
    ],
    imageUrl: '/products/aumento-nivel.svg',
    sortOrder: 204,
    active: true,
  },
  {
    id: 'ff-co-nivel-25',
    gameId: 'free-fire',
    sku: 'FF-CO-NIVEL-25',
    name: 'Paquete Subida de Nivel 25',
    description: 'Paquete de subida de nivel 25 para Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    kind: 'level_up',
    provider: 'centralone',
    amount: 25,
    bonus: 0,
    costUsd: 0.3323,
    priceUsd: 0.60,
    compareAtUsd: 0.90,
    calls: [
      {
        packageId: 'a9093b52-a726-4e9d-be8d-994df6ccd870',
        quantity: 1,
        provider: 'centralone',
      },
    ],
    imageUrl: '/products/aumento-nivel.svg',
    sortOrder: 205,
    active: true,
  },
  {
    id: 'ff-co-nivel-30',
    gameId: 'free-fire',
    sku: 'FF-CO-NIVEL-30',
    name: 'Paquete Subida de Nivel 30',
    description: 'Paquete de subida de nivel 30 para Free Fire. Se carga directamente a tu cuenta con tu ID.',
    fulfillment: 'auto',
    kind: 'level_up',
    provider: 'centralone',
    amount: 30,
    bonus: 0,
    costUsd: 0.5136,
    priceUsd: 0.90,
    compareAtUsd: 1.30,
    calls: [
      {
        packageId: '5d18dc6d-98be-45c4-a472-68266f6a3c9d',
        quantity: 1,
        provider: 'centralone',
      },
    ],
    imageUrl: '/products/aumento-nivel.svg',
    sortOrder: 206,
    active: true,
  },
  {
    id: 'ff-co-nivel-completo',
    gameId: 'free-fire',
    sku: 'FF-CO-NIVEL-ALL',
    name: 'Subida de Nivel Completo (6 al 30)',
    description: 'Aumento de nivel completo del nivel 6 al 30 para Free Fire. Se cargan los 6 paquetes de forma automática directamente con tu ID.',
    fulfillment: 'auto',
    kind: 'level_up',
    provider: 'centralone',
    amount: 1000,
    bonus: 0,
    costUsd: 2.0446,
    priceUsd: 3.40,
    compareAtUsd: 4.80,
    calls: [
      { packageId: '00147efa-cc79-4767-8306-9b5dc45e2757', quantity: 1, provider: 'centralone' },
      { packageId: '0d351e69-6360-42bc-9b83-94de2c26b4be', quantity: 1, provider: 'centralone' },
      { packageId: '3e2b9bd8-2293-4bd4-8978-316603eec328', quantity: 1, provider: 'centralone' },
      { packageId: '549739d0-f988-4d5d-9b18-5357bd8de9fa', quantity: 1, provider: 'centralone' },
      { packageId: 'a9093b52-a726-4e9d-be8d-994df6ccd870', quantity: 1, provider: 'centralone' },
      { packageId: '5d18dc6d-98be-45c4-a472-68266f6a3c9d', quantity: 1, provider: 'centralone' },
    ],
    imageUrl: '/products/aumento-nivel.svg',
    badge: 'COMBO COMPLETO',
    featured: false,
    sortOrder: 200,
    active: true,
  },
];

export const SEED_PRODUCTS: SeedProduct[] = [
  ...FREE_FIRE_PACKAGES,
  ...FREE_FIRE_COMBOS,
  ...FREE_FIRE_LEVEL_UP_PACKAGES,
  ...BLOOD_STRIKE_PACKAGES,
  ...BLOOD_STRIKE_COMBOS,
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

  const manualGames = new Set<string>();

  for (const game of SEED_GAMES) {
    const ref = games().doc(game.id);
    const snap = await ref.get();

    // Un juego creado a mano desde el panel no lo reescribe la siembra.
    if (snap.data()?.manual === true) {
      manualGames.add(game.id);
      continue;
    }

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
    if (manualGames.has(product.gameId)) continue;
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
        ...(product.provider ? { provider: product.provider } : {}),
        ...(product.centralOneProductId !== undefined ? { centralOneProductId: product.centralOneProductId } : {}),
        ...(product.targetFields !== undefined ? { targetFields: product.targetFields } : {}),
        ...(product.active !== undefined ? { active: product.active } : {}),
        ...(product.priceUsd !== undefined ? { priceUsd: product.priceUsd } : {}),
        ...(product.compareAtUsd !== undefined ? { compareAtUsd: product.compareAtUsd } : {}),
        ...(product.badge !== undefined ? { badge: product.badge } : {}),
        ...(product.featured !== undefined ? { featured: product.featured } : {}),
      };
      if (options.overwritePrices && product.priceUsd === undefined) patch.priceUsd = priceUsd;

      // El icono sólo se rellena si el producto no tiene uno: el administrador
      // puede haber subido el suyo desde el panel y sembrar no debe pisarlo.
      if (product.imageUrl && !snap.data()?.imageUrl) patch.imageUrl = product.imageUrl;

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
        priceUsd: product.priceUsd ?? priceUsd,
        compareAtUsd: product.compareAtUsd ?? null,
        ...(product.provider ? { provider: product.provider } : {}),
        ...(product.centralOneProductId !== undefined ? { centralOneProductId: product.centralOneProductId } : {}),
        ...(product.targetFields !== undefined ? { targetFields: product.targetFields } : {}),
        calls: product.calls,
        imageUrl: product.imageUrl ?? '',
        badge: product.badge ?? null,
        active: product.active ?? true,
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
