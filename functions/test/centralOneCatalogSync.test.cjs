const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// Sólo se prueban las funciones puras del módulo. Firestore se sustituye por
// un doble vacío para no inicializar el Admin SDK al importar.
// ---------------------------------------------------------------------------
const mockDb = {
  collection: () => ({ doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }) }),
  batch: () => ({ set: () => {}, commit: async () => {} }),
  getAll: async () => [],
};

const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    COLLECTIONS: { playerIdCache: 'playerIdCache' },
    now: () => Timestamp.now(),
    Timestamp,
    playerIdCache: () => mockDb.collection('playerIdCache'),
    games: () => mockDb.collection('games'),
    products: () => mockDb.collection('products'),
    providerSync: () => mockDb.collection('providerSync'),
    privateCentralOneConfigDoc: () => mockDb.collection('privateConfig').doc('centralOne'),
    configDoc: () => mockDb.collection('config').doc('app'),
    adminAlerts: () => mockDb.collection('adminAlerts'),
  },
};

const sync = require('../lib/services/centralOneCatalogSync.js');

/** Ítem de catálogo con valores por defecto razonables. */
function item(overrides) {
  return {
    product_id: 'p-1',
    sku: 'SKU',
    name: 'Free Fire · 100 Diamantes',
    category: 'gaming_topup',
    product_type: 'topup',
    market: 'LATAM',
    region: 'LATAM',
    currency: 'USD',
    reseller_price: '1.0000',
    status: 'active',
    updated_at: '2026-11-01T00:00:00Z',
    product_family_id: 'fam-ff',
    product_family_name: 'Free Fire',
    requires_target: true,
    target_fields: ['player_id'],
    target_schema: [{ key: 'player_id', label: null, type: 'text', options: null }],
    in_stock: true,
    available_stock: null,
    price_updated_at: null,
    ...overrides,
  };
}

const ffLatamId = sync.coGameId('topup', 'fam-ff', 'LATAM');

// ---------------------------------------------------------------------------
// mapCentralOneCatalog
// ---------------------------------------------------------------------------

test('mapCentralOneCatalog: agrupa por familia + región, nombra y filtra', () => {
  const items = [
    item({ product_id: 'ff-100', name: 'Free Fire · 100 Diamantes', reseller_price: '0.9500' }),
    item({ product_id: 'ff-week', name: 'Free Fire · Weekly Membership', reseller_price: '1.8000' }),
    item({ product_id: 'ff-lvl6', name: 'Free Fire · Level Up 6', reseller_price: '0.2018' }),
    item({ product_id: 'ff-br-100', region: 'br', name: 'Free Fire (BR) · 100 Diamantes' }),
    item({
      product_id: 'pubg-60',
      name: 'PUBG Mobile 60 UC',
      region: '',
      product_family_id: 'fam-pubg',
      product_family_name: 'PUBG Mobile',
      target_fields: ['game_user_id'],
      target_schema: [{ key: 'game_user_id', label: null, type: 'text', options: null }],
    }),
    item({
      product_id: 'gp-10',
      name: 'Google Play 10 USD',
      category: 'gift_card',
      region: 'US',
      product_family_id: 'fam-gp',
      product_family_name: 'Google Play',
      target_fields: [],
      target_schema: [],
      available_stock: 3,
    }),
    // Fuera: región extranjera (recarga), gift card europea, contraseña,
    // inactivo, categoría desconocida, otra moneda, duplicado, sin campos,
    // precio inválido.
    item({ product_id: 'ff-id', region: 'ID' }),
    item({
      product_id: 'steam-eu',
      category: 'gift_card',
      region: 'EU',
      product_family_id: 'fam-steam',
      product_family_name: 'Steam Wallet',
      target_fields: [],
      target_schema: [],
    }),
    item({
      product_id: 'acc-1',
      product_family_id: 'fam-acc',
      product_family_name: 'Cuenta',
      target_fields: ['email', 'password'],
    }),
    item({ product_id: 'ff-old', status: 'inactive' }),
    item({ product_id: 'x-1', category: 'software' }),
    item({ product_id: 'ff-eur', currency: 'EUR' }),
    item({ product_id: 'ff-100' }),
    item({ product_id: 'ff-notarget', target_fields: [] }),
    item({ product_id: 'ff-free', reseller_price: '0' }),
    item({ product_id: '' }),
  ];

  const mapping = sync.mapCentralOneCatalog(items, ['ff-100']);
  const ids = mapping.games.map((game) => game.id).sort();
  assert.deepEqual(ids, [
    sync.coGameId('gift_card', 'fam-gp', 'US'),
    sync.coGameId('topup', 'fam-ff', 'BR'),
    ffLatamId,
    sync.coGameId('topup', 'fam-pubg', 'GLOBAL'),
  ].sort());
  assert.equal(ffLatamId, 'co-topup-fam-ff-latam');

  const byId = new Map(mapping.games.map((game) => [game.id, game]));
  const ff = byId.get(ffLatamId);
  assert.equal(ff.name, 'Free Fire', 'el Free Fire LATAM de Central One se llama sólo «Free Fire»');
  assert.equal(ff.isFreeFireLatam, true);
  assert.equal(ff.apiGameId, 'co-fam-ff-LATAM');
  assert.equal(ff.validatesPlayerId, true, 'un producto en la cobertura activa la validación');
  assert.equal(ff.sortOrder, 10);
  assert.equal(byId.get(sync.coGameId('topup', 'fam-ff', 'BR')).name, 'Free Fire (BR)', 'familia multi-región lleva sufijo');
  assert.equal(byId.get(sync.coGameId('topup', 'fam-pubg', 'GLOBAL')).name, 'PUBG Mobile', 'GLOBAL de una sola región, sin sufijo');
  assert.equal(byId.get(sync.coGameId('gift_card', 'fam-gp', 'US')).name, 'Google Play (US)');
  assert.equal(mapping.freeFireLatamGameId, ffLatamId);
  assert.deepEqual(mapping.gamesByFamily, { topup: 3, gift_card: 1 });

  // Ofertas del Free Fire LATAM: ordenadas por costo, con kind y nombre limpio.
  assert.deepEqual(
    ff.offers.map((offer) => [offer.productId, offer.kind, offer.label]),
    [
      ['ff-lvl6', 'level_up', 'Level Up 6'],
      ['ff-100', 'package', '100 Diamantes'],
      ['ff-week', 'special', 'Tarjeta Semanal'],
    ]
  );
  const lvl = ff.offers[0];
  assert.equal(lvl.amount, 6);
  assert.equal(lvl.sortOrder, 6);
  assert.equal(lvl.docId, 'co-topup-fam-ff-latam--ff-lvl6');
  assert.equal(lvl.sku, 'CO-TOP-ff-lvl6');
  assert.deepEqual(lvl.targetFields, ['player_id']);
  assert.equal(ff.offers[2].isFreeFireCard, true);
  assert.equal(ff.offers[1].isFreeFireCard, false);

  const gift = byId.get(sync.coGameId('gift_card', 'fam-gp', 'US')).offers[0];
  assert.equal(gift.kind, 'special');
  assert.deepEqual(gift.targetFields, []);
  assert.equal(gift.badge, 'GIFT CARD');
  assert.equal(gift.stock, 3);
  assert.equal(gift.deliveryEtaMinutes, 5);
  assert.deepEqual(byId.get(sync.coGameId('gift_card', 'fam-gp', 'US')).playerFields, []);

  assert.deepEqual(mapping.inactiveProductIds, ['co-topup-fam-ff-latam--ff-old']);
  assert.equal(mapping.skipped.region, 2);
  assert.equal(mapping.skipped.password_field, 1);
  assert.equal(mapping.skipped.inactive, 1);
  assert.equal(mapping.skipped.unknown_category, 1);
  assert.equal(mapping.skipped.currency, 1);
  assert.equal(mapping.skipped.duplicate, 1);
  assert.equal(mapping.skipped.no_target, 1);
  assert.equal(mapping.skipped.invalid_price, 1);
  assert.equal(mapping.skipped.no_product_id, 1);
  assert.equal(mapping.itemsMapped, 6);
});

test('mapCentralOneCatalog: stock y disponibilidad', () => {
  const mapping = sync.mapCentralOneCatalog([
    item({ product_id: 'a', in_stock: false, available_stock: 50 }),
    item({ product_id: 'b', available_stock: 2.7 }),
    item({ product_id: 'c', available_stock: null }),
  ]);
  const offers = new Map(mapping.games[0].offers.map((offer) => [offer.productId, offer]));
  assert.equal(offers.get('a').stock, 0);
  assert.equal(offers.get('a').providerAvailable, false);
  assert.equal(offers.get('b').stock, 2);
  assert.equal(offers.get('c').stock, null);
  assert.equal(offers.get('c').providerAvailable, true);
});

// ---------------------------------------------------------------------------
// Campos del comprador
// ---------------------------------------------------------------------------

test('playerFields: unión de claves, select con opciones y providerField por posición', () => {
  const mapping = sync.mapCentralOneCatalog([
    item({
      product_id: 'ml-1',
      name: 'Mobile Legends 86 Diamonds',
      product_family_id: 'fam-ml',
      product_family_name: 'Mobile Legends',
      region: 'GLOBAL',
      target_fields: ['player_id', 'server_id'],
      target_schema: [
        { key: 'player_id', label: null, type: 'text', options: null },
        {
          key: 'server_id',
          label: null,
          type: 'select',
          options: [
            { value: 'os_asia', label: 'Asia' },
            { value: 'os.usa', label: 'América' },
          ],
        },
      ],
    }),
    item({
      product_id: 'ml-2',
      name: 'Mobile Legends 172 Diamonds',
      product_family_id: 'fam-ml',
      product_family_name: 'Mobile Legends',
      region: 'GLOBAL',
      target_fields: ['player_id', 'nickname'],
      target_schema: [{ key: 'nickname', label: 'Apodo', type: 'text', options: null }],
    }),
  ]);
  const game = mapping.games[0];
  assert.deepEqual(game.playerFields.map((field) => field.key), ['player_id', 'server_id', 'nickname']);
  assert.deepEqual(game.targetFields, ['player_id', 'server_id', 'nickname']);
  assert.equal(game.fieldSignatures, 2);

  const [playerId, server, nickname] = game.playerFields;
  assert.equal(playerId.label, 'ID de jugador');
  assert.equal(playerId.pattern, '^\\d{1,30}$');
  assert.equal(playerId.type, 'text');
  assert.equal(playerId.providerField, 'player_id');
  assert.equal(playerId.required, true);
  assert.equal(playerId.sensitive, false);
  assert.match(playerId.help, /no se puede recuperar/);

  assert.equal(server.type, 'select');
  assert.equal(server.label, 'Servidor / Zone ID');
  assert.deepEqual(server.options, [
    { value: 'os_asia', label: 'Asia' },
    { value: 'os.usa', label: 'América' },
  ]);
  assert.equal(server.pattern, '^(os_asia|os\\.usa)$');
  assert.ok(new RegExp(server.pattern).test('os.usa'));
  assert.ok(!new RegExp(server.pattern).test('osXusa'));
  assert.equal(server.providerField, 'player_id2');

  assert.equal(nickname.label, 'Apodo');
  assert.equal(nickname.pattern, '^.{1,120}$');
  assert.equal(nickname.providerField, null);

  // Cada producto manda sólo sus propias claves.
  const offers = new Map(game.offers.map((offer) => [offer.productId, offer]));
  assert.deepEqual(offers.get('ml-1').targetFields, ['player_id', 'server_id']);
  assert.deepEqual(offers.get('ml-2').targetFields, ['player_id', 'nickname']);
});

test('playerFields: conserva lo editado por el admin y quita lo que el proveedor ya no pide', () => {
  const existing = [
    {
      key: 'player_id',
      label: 'Tu UID',
      pattern: '^\\d{6,12}$',
      help: 'Ayuda del admin',
      placeholder: 'Ej: 123',
      type: 'text',
      providerField: 'player_id',
      required: true,
      sensitive: false,
    },
    {
      key: 'zone_id',
      label: 'Zona',
      pattern: '^\\d+$',
      help: '',
      placeholder: '',
      type: 'text',
      providerField: 'player_id2',
      required: true,
      sensitive: false,
    },
    {
      key: 'nota',
      label: 'Nota para el equipo',
      pattern: '^.{0,200}$',
      help: '',
      placeholder: '',
      type: 'text',
      providerField: 'player_id',
      required: false,
      sensitive: false,
    },
  ];
  const fields = sync.buildCentralOnePlayerFields(
    [{ key: 'player_id', label: null, type: 'text', options: null }],
    existing,
    ['player_id', 'zone_id']
  );
  assert.deepEqual(fields.map((field) => field.key), ['player_id', 'nota']);
  assert.equal(fields[0].label, 'Tu UID');
  assert.equal(fields[0].pattern, '^\\d{6,12}$');
  assert.equal(fields[0].help, 'Ayuda del admin');
  assert.equal(fields[0].placeholder, 'Ej: 123');
  assert.equal(fields[1].providerField, null, 'el campo del admin no le roba player_id al del proveedor');
  assert.equal(fields[1].required, false);
});

// ---------------------------------------------------------------------------
// Clasificación
// ---------------------------------------------------------------------------

test('classifyCentralOneKind: level_up, special y package', () => {
  const cases = [
    ['100 Diamantes', 'package'],
    ['520 + 52 Diamonds', 'package'],
    ['Gold 645', 'package'],
    ['Level Up 6', 'level_up'],
    ['Subida de nivel 10', 'level_up'],
    ['Paquete Nivel 15', 'level_up'],
    ['Lvl 30', 'level_up'],
    ['Level Up Pass', 'special'],
    ['Weekly Membership', 'special'],
    ['Monthly Membership', 'special'],
    ['Booyah Pass', 'special'],
    ['Elite Bundle 5', 'special'],
    ['Cofre misterioso', 'special'],
    ['Diamantes', 'special'],
  ];
  for (const [label, kind] of cases) {
    assert.equal(sync.classifyCentralOneKind(label, 'topup'), kind, label);
  }
  assert.equal(sync.classifyCentralOneKind('10 USD', 'gift_card'), 'special');
});

test('isFreeFireCard: sólo tarjetas semanales/mensuales de Free Fire', () => {
  assert.equal(sync.isFreeFireCard('Free Fire', 'Weekly Membership'), true);
  assert.equal(sync.isFreeFireCard('Free Fire', 'Monthly Membership'), true);
  assert.equal(sync.isFreeFireCard('FreeFire', 'Tarjeta básica semanal'), true);
  assert.equal(sync.isFreeFireCard('Free Fire', 'Tarjeta Mensual'), true);
  assert.equal(sync.isFreeFireCard('Free Fire', '100 Diamantes'), false);
  assert.equal(sync.isFreeFireCard('Free Fire', 'Booyah Pass'), false);
  assert.equal(sync.isFreeFireCard('Blood Strike', 'Weekly Pass'), false);
});

test('centralOneOfferLabel quita el nombre del juego', () => {
  assert.equal(sync.centralOneOfferLabel('Free Fire (BR) · 110 Diamantes', 'Free Fire'), '110 Diamantes');
  assert.equal(sync.centralOneOfferLabel('Free Fire 110 Diamantes', 'Free Fire'), '110 Diamantes');
  assert.equal(sync.centralOneOfferLabel('1 USD · USDT', 'Binance'), '1 USD · USDT');
});

test('visibleInLatam: LATAM/GLOBAL/países visibles, US sólo en gift cards', () => {
  assert.equal(sync.visibleInLatam('topup', 'Free Fire', null, 'LATAM'), true);
  assert.equal(sync.visibleInLatam('topup', 'Free Fire', null, 'BR'), true);
  assert.equal(sync.visibleInLatam('topup', 'PUBG Mobile', null, 'GLOBAL'), true);
  assert.equal(sync.visibleInLatam('topup', 'PUBG Mobile', null, 'US'), false);
  assert.equal(sync.visibleInLatam('gift_card', 'Google Play', null, 'US'), true);
  assert.equal(sync.visibleInLatam('gift_card', 'Steam Wallet', null, 'EU'), false);
  assert.equal(sync.visibleInLatam('topup', 'Free Fire', null, 'ID'), false);
});

// ---------------------------------------------------------------------------
// Juego nuevo
// ---------------------------------------------------------------------------

test('newCentralOneGameDoc: el Free Fire LATAM nace apagado; los demás activos', () => {
  const mapping = sync.mapCentralOneCatalog([
    item({ product_id: 'ff-100' }),
    item({
      product_id: 'bs-1',
      name: 'Blood Strike 100 Gold',
      region: 'GLOBAL',
      product_family_id: 'fam-bs',
      product_family_name: 'Blood Strike',
      target_fields: ['game_user_id'],
    }),
  ]);
  const ts = Timestamp.fromMillis(1_800_000_000_000);
  const ff = mapping.games.find((game) => game.isFreeFireLatam);
  const bs = mapping.games.find((game) => !game.isFreeFireLatam);

  const fazerGames = new Map([
    ['fz-topup-free-fire-latam', { name: 'Free Fire LATAM', logoUrl: '/ff-logo.png', coverUrl: '/ff-cover.png', accentColor: '#111111' }],
    ['fz-topup-blood-strike', { name: 'Blood Strike', providerFamily: 'topup', logoUrl: '/bs.png', currencyIconUrl: '/bs-coin.png' }],
  ]);
  const ffDoc = sync.newCentralOneGameDoc(ff, { provider: 'centralone' }, sync.pickFazerPresentation(ff, fazerGames), ts);
  assert.equal(ffDoc.active, false);
  assert.equal(ffDoc.name, 'Free Fire');
  assert.equal(ffDoc.shortName, 'Free Fire');
  assert.equal(ffDoc.logoUrl, '/ff-logo.png');
  assert.equal(ffDoc.coverUrl, '/ff-cover.png');
  assert.equal(ffDoc.accentColor, '#111111');
  assert.equal(ffDoc.currencyLabel, 'Diamantes');
  assert.equal(ffDoc.provider, 'centralone');
  assert.equal(ffDoc.playerIdLabel, 'ID de jugador');

  const bsDoc = sync.newCentralOneGameDoc(bs, {}, sync.pickFazerPresentation(bs, fazerGames), ts);
  assert.equal(bsDoc.active, true);
  assert.equal(bsDoc.sortOrder, 20);
  assert.equal(bsDoc.logoUrl, '/bs.png');
  assert.equal(bsDoc.currencyIconUrl, '/bs-coin.png');
  assert.equal(bsDoc.currencyLabel, 'Oro');
  assert.equal(sync.pickFazerPresentation({ ...bs, familyName: 'Juego Nuevo' }, fazerGames), null);
});

// ---------------------------------------------------------------------------
// Freno de seguridad
// ---------------------------------------------------------------------------

test('centralOneSanityCheck: catálogo vacío, sospechoso y familia sin categorías', () => {
  assert.equal(
    sync.centralOneSanityCheck({
      itemsReceived: 0,
      mappedByFamily: { topup: 0, gift_card: 0 },
      activeByFamily: { topup: 0, gift_card: 0 },
    }).abort,
    'empty_catalog'
  );
  assert.equal(
    sync.centralOneSanityCheck({
      itemsReceived: 500,
      mappedByFamily: { topup: 10, gift_card: 40 },
      activeByFamily: { topup: 30, gift_card: 40 },
    }).abort,
    'catalog_suspicious'
  );
  const noGift = sync.centralOneSanityCheck({
    itemsReceived: 500,
    mappedByFamily: { topup: 40, gift_card: 0 },
    activeByFamily: { topup: 40, gift_card: 10 },
  });
  assert.equal(noGift.abort, null);
  assert.deepEqual(noGift.skipRemoval, ['gift_card']);
  // Primera sync: nada activo todavía, nada que comparar.
  const first = sync.centralOneSanityCheck({
    itemsReceived: 500,
    mappedByFamily: { topup: 1, gift_card: 1 },
    activeByFamily: { topup: 0, gift_card: 0 },
  });
  assert.deepEqual(first, { abort: null, message: null, skipRemoval: [] });
  // Por debajo del umbral de 20 juegos activos no se frena.
  assert.equal(
    sync.centralOneSanityCheck({
      itemsReceived: 10,
      mappedByFamily: { topup: 1, gift_card: 1 },
      activeByFamily: { topup: 19, gift_card: 0 },
    }).abort,
    null
  );
});

// ---------------------------------------------------------------------------
// Extras de Free Fire
// ---------------------------------------------------------------------------

const PKG_LVL6 = '00147efa-cc79-4767-8306-9b5dc45e2757';
const PKG_LVL10 = '0d351e69-6360-42bc-9b83-94de2c26b4be';
const PKG_BOOYAH = '7eed3f72-b3fb-45e6-b8e5-9503e4aafcfa';

function seededFreeFire() {
  return [
    { id: 'ff-d-100', gameId: 'free-fire', calls: [{ packageId: 1, quantity: 1 }], kind: 'package' },
    {
      id: 'ff-co-nivel-6',
      gameId: 'free-fire',
      sku: 'FF-CO-NIVEL-6',
      name: 'Paquete Subida de Nivel 6',
      kind: 'level_up',
      provider: 'centralone',
      priceUsd: 0.4,
      costUsd: 0.2018,
      sortOrder: 201,
      calls: [{ packageId: PKG_LVL6, quantity: 1, provider: 'centralone' }],
      providerSyncedAt: 'no-debe-copiarse',
      createdAt: 'viejo',
    },
    {
      id: 'ff-co-nivel-10',
      gameId: 'free-fire',
      sku: 'FF-CO-NIVEL-10',
      name: 'Paquete Subida de Nivel 10',
      kind: 'level_up',
      provider: 'centralone',
      priceUsd: 0.6,
      sortOrder: 202,
      calls: [{ packageId: PKG_LVL10, quantity: 1, provider: 'centralone' }],
    },
    {
      id: 'ff-m-pase-booyah',
      gameId: 'free-fire',
      sku: 'FF-M-BOOYAH',
      name: 'Pase Booyah Premium',
      kind: 'special',
      provider: 'centralone',
      priceUsd: 3.3,
      sortOrder: 110,
      // El doc vivo perdió `provider` en su call.
      calls: [{ packageId: PKG_BOOYAH, quantity: 1 }],
    },
    {
      id: 'ff-co-nivel-completo',
      gameId: 'free-fire',
      sku: 'FF-CO-NIVEL-ALL',
      name: 'Subida de Nivel Completo (6 al 30)',
      kind: 'level_up',
      provider: 'centralone',
      priceUsd: 3.4,
      sortOrder: 200,
      calls: [
        { packageId: PKG_LVL6, quantity: 1, provider: 'centralone' },
        { packageId: PKG_LVL10, quantity: 1, provider: 'centralone' },
      ],
    },
  ];
}

function freeFirePlan(offers) {
  return { id: ffLatamId, targetFields: ['player_id'], offers };
}

function offer(productId, label, kind, extra = {}) {
  return {
    docId: `${ffLatamId}--${productId}`,
    productId,
    sku: `CO-TOP-${productId}`,
    label,
    description: '',
    costUsd: 1,
    stock: 7,
    providerAvailable: true,
    kind,
    amount: 0,
    bonus: 0,
    targetFields: ['player_id'],
    isFreeFireCard: false,
    sortOrder: 99,
    badge: null,
    deliveryEtaMinutes: 2,
    ...extra,
  };
}

const PRICING = { marginPercent: 20, roundToUsd: 0.05 };

test('planFreeFireExtras: sin Free Fire LATAM no hace nada', () => {
  const plan = sync.planFreeFireExtras({
    freeFire: null,
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker: new Set(),
    pricing: PRICING,
    timestamp: 'ts',
  });
  assert.deepEqual(plan.creates, []);
  assert.equal(plan.notes.length, 1);
});

test('planFreeFireExtras: añade pases y niveles sin duplicar packageIds; tarjetas apagadas', () => {
  const plan = sync.planFreeFireExtras({
    freeFire: freeFirePlan([
      offer(PKG_LVL6, 'Level Up 6', 'level_up', { amount: 6 }),
      offer('lvl-40', 'Level Up 40', 'level_up', { amount: 40, costUsd: 0.5 }),
      offer('week', 'Tarjeta Semanal', 'special', { isFreeFireCard: true, costUsd: 1.8 }),
      offer(PKG_BOOYAH, 'Booyah Pass', 'special'),
      offer('dm-100', '100 Diamantes', 'package', { amount: 100 }),
    ]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker: new Set(),
    pricing: PRICING,
    timestamp: 'ts',
  });
  const ids = plan.creates.map((extra) => extra.id).sort();
  assert.deepEqual(ids, [
    `${ffLatamId}--nivel-completo`,
    'free-fire--co-lvl-40',
    'free-fire--co-week',
    `freefire-id--co-${PKG_BOOYAH}`,
    `freefire-id--co-${PKG_LVL6}`,
    'freefire-id--co-lvl-40',
    'freefire-id--co-nivel-completo',
    'freefire-id--co-week',
    'freefire-id--ff-co-nivel-10',
  ].sort());

  const byId = new Map(plan.creates.map((extra) => [extra.id, extra]));
  const lvl40 = byId.get('free-fire--co-lvl-40').data;
  assert.equal(lvl40.gameId, 'free-fire');
  assert.equal(lvl40.provider, 'centralone');
  assert.equal(lvl40.kind, 'level_up');
  assert.equal(lvl40.sortOrder, 40);
  assert.equal(lvl40.centralOneExtra, true);
  assert.equal(lvl40.centralOneLinkedAt, 'ts');
  assert.equal(lvl40.providerOfferId, 'lvl-40');
  assert.equal(lvl40.priceUsd, 0.6);
  assert.equal(lvl40.active, true);
  assert.equal(lvl40.adminDisabled, false);
  assert.equal('providerSyncedAt' in lvl40, false, 'sin providerSyncedAt para que markRemoved no lo toque');
  assert.equal('targetFields' in lvl40, false, 'los extras de Inefable usan la heurística por slug');
  assert.deepEqual(lvl40.calls, [{ packageId: 'lvl-40', quantity: 1, provider: 'centralone' }]);

  const week = byId.get('freefire-id--co-week').data;
  assert.equal(week.active, false);
  assert.equal(week.adminDisabled, true);
  assert.ok(week.sortOrder >= 900);

  // Combo clonado: en freefire-id sin targetFields, en el juego CO con ellos.
  const comboId = byId.get('freefire-id--co-nivel-completo').data;
  assert.equal(comboId.gameId, 'freefire-id');
  assert.equal(comboId.priceUsd, 3.4);
  assert.equal(comboId.kind, 'level_up');
  assert.equal(comboId.sortOrder, 200);
  assert.equal(comboId.calls.length, 2);
  assert.equal(comboId.centralOneExtra, true);
  const comboCo = byId.get(`${ffLatamId}--nivel-completo`).data;
  assert.equal(comboCo.gameId, ffLatamId);
  assert.deepEqual(comboCo.targetFields, ['player_id']);
  assert.ok(comboCo.calls.every((call) => call.provider === 'centralone' && call.targetFields[0] === 'player_id'));
  assert.equal('providerSyncedAt' in comboCo, false);

  // d) no duplica lo que b) ya cubrió (nivel 6 y Booyah) pero sí copia el
  // nivel 10, que Central One no trae en este catálogo.
  assert.equal(byId.has('freefire-id--ff-co-nivel-6'), false);
  assert.equal(byId.has('freefire-id--ff-m-pase-booyah'), false);
  assert.equal(byId.get('freefire-id--ff-co-nivel-10').source, 'clone');
  // A `free-fire` nunca se le copia nada suyo ni se le tocan sus productos.
  const seededIds = new Set(seededFreeFire().map((product) => product.id));
  assert.ok(plan.creates.every((extra) => !seededIds.has(extra.id)));
});

test('planFreeFireExtras: d) clona ff-co-nivel-* y el pase Booyah a freefire-id', () => {
  const plan = sync.planFreeFireExtras({
    freeFire: freeFirePlan([offer('dm-100', '100 Diamantes', 'package', { amount: 100 })]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker: new Set(),
    pricing: PRICING,
    timestamp: 'ts',
  });
  const byId = new Map(plan.creates.map((extra) => [extra.id, extra]));
  assert.deepEqual(
    plan.creates.filter((extra) => extra.source === 'clone').map((extra) => extra.id).sort(),
    ['freefire-id--ff-co-nivel-10', 'freefire-id--ff-co-nivel-6', 'freefire-id--ff-m-pase-booyah']
  );
  assert.equal(byId.has('freefire-id--ff-co-nivel-completo'), false, 'el combo va por c), no por d)');
  const booyah = byId.get('freefire-id--ff-m-pase-booyah').data;
  assert.equal(booyah.gameId, 'freefire-id');
  assert.equal(booyah.priceUsd, 3.3);
  assert.deepEqual(booyah.calls, [{ packageId: PKG_BOOYAH, quantity: 1, provider: 'centralone' }]);
  const lvl6 = byId.get('freefire-id--ff-co-nivel-6').data;
  assert.equal(lvl6.createdAt, 'ts');
  assert.equal('providerSyncedAt' in lvl6, false);
  assert.equal('id' in lvl6, false);
});

test('planFreeFireExtras: respeta el marcador, lo existente y un juego inexistente', () => {
  const existing = [
    { id: `freefire-id--co-${PKG_LVL6}`, gameId: 'freefire-id', calls: [{ packageId: 'otra-cosa', quantity: 1 }] },
  ];
  const plan = sync.planFreeFireExtras({
    freeFire: freeFirePlan([offer(PKG_LVL6, 'Level Up 6', 'level_up', { amount: 6 }), offer('lvl-40', 'Level Up 40', 'level_up', { amount: 40 })]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': existing },
    existingIds: new Set([`${ffLatamId}--nivel-completo`]),
    marker: new Set(['free-fire--co-lvl-40', 'freefire-id--co-nivel-completo']),
    pricing: PRICING,
    timestamp: 'ts',
  });
  const ids = plan.creates.map((extra) => extra.id);
  assert.ok(!ids.includes('free-fire--co-lvl-40'), 'lo que está en el marcador no se recrea');
  assert.ok(!ids.includes('freefire-id--co-nivel-completo'));
  assert.ok(!ids.includes(`${ffLatamId}--nivel-completo`), 'no pisa un doc existente');
  assert.ok(!ids.includes(`freefire-id--co-${PKG_LVL6}`), 'no pisa un doc existente del juego');
  assert.ok(ids.includes('freefire-id--co-lvl-40'));

  const missing = sync.planFreeFireExtras({
    freeFire: freeFirePlan([offer('lvl-40', 'Level Up 40', 'level_up', { amount: 40 })]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': null },
    existingIds: new Set(),
    marker: new Set(),
    pricing: PRICING,
    timestamp: 'ts',
  });
  assert.ok(missing.creates.every((extra) => extra.gameId !== 'freefire-id'));
  assert.ok(missing.notes.some((note) => note.includes('freefire-id')));
});

test('planFreeFireExtras: un extra borrado por el admin no vuelve con otro id (b ↔ d)', () => {
  // b) creó `freefire-id--co-<lvl6>` y el admin lo borró: d) no debe clonar
  // `ff-co-nivel-6` (mismo packageId) a `freefire-id--ff-co-nivel-6`.
  const marker = new Set([`freefire-id--co-${PKG_LVL6}`]);
  const withOffer = sync.planFreeFireExtras({
    freeFire: freeFirePlan([offer(PKG_LVL6, 'Level Up 6', 'level_up', { amount: 6 })]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker,
    pricing: PRICING,
    timestamp: 'ts',
  });
  const ids = withOffer.creates.map((extra) => extra.id);
  assert.ok(!ids.includes(`freefire-id--co-${PKG_LVL6}`));
  assert.ok(!ids.includes('freefire-id--ff-co-nivel-6'), 'd) respeta lo que b) creó y el admin borró');

  // Aunque la oferta ya no venga en el catálogo, el marcador sigue cubriendo.
  const withoutOffer = sync.planFreeFireExtras({
    freeFire: freeFirePlan([]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker,
    pricing: PRICING,
    timestamp: 'ts',
  });
  assert.ok(!withoutOffer.creates.some((extra) => extra.id === 'freefire-id--ff-co-nivel-6'));

  // Al revés: d) clonó `ff-co-nivel-6`, el admin lo borró y ahora Central One
  // trae esa oferta: b) no la crea como `freefire-id--co-<lvl6>`.
  const reverse = sync.planFreeFireExtras({
    freeFire: freeFirePlan([offer(PKG_LVL6, 'Level Up 6', 'level_up', { amount: 6 })]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker: new Set(['freefire-id--ff-co-nivel-6']),
    pricing: PRICING,
    timestamp: 'ts',
  });
  assert.ok(!reverse.creates.some((extra) => extra.id === `freefire-id--co-${PKG_LVL6}`));
  assert.ok(!reverse.creates.some((extra) => extra.id === 'freefire-id--ff-co-nivel-6'));
});

test('planFreeFireExtras: una oferta sin stock en Central One no se crea (ni se clona) hasta que vuelva', () => {
  const plan = sync.planFreeFireExtras({
    freeFire: freeFirePlan([
      offer(PKG_LVL6, 'Level Up 6', 'level_up', { amount: 6, stock: 0, providerAvailable: false }),
      offer('lvl-40', 'Level Up 40', 'level_up', { amount: 40, stock: 0, providerAvailable: false }),
    ]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker: new Set(),
    pricing: PRICING,
    timestamp: 'ts',
  });
  const ids = plan.creates.map((extra) => extra.id);
  assert.ok(!ids.includes('free-fire--co-lvl-40'));
  assert.ok(!ids.includes('freefire-id--co-lvl-40'));
  assert.ok(!ids.includes(`freefire-id--co-${PKG_LVL6}`));
  assert.ok(!ids.includes('freefire-id--ff-co-nivel-6'), 'tampoco se clona algo que Central One no entrega');
  assert.ok(plan.notes.some((note) => note.includes('lvl-40')));

  // Con stock de nuevo (no quedó en el marcador) se crea.
  const later = sync.planFreeFireExtras({
    freeFire: freeFirePlan([offer('lvl-40', 'Level Up 40', 'level_up', { amount: 40 })]),
    inefableProducts: { 'free-fire': seededFreeFire(), 'freefire-id': [] },
    existingIds: new Set(),
    marker: new Set(),
    pricing: PRICING,
    timestamp: 'ts',
  });
  assert.ok(later.creates.some((extra) => extra.id === 'free-fire--co-lvl-40'));
});

test('findExtrasAtLoss: extras activos cuyo costo alcanza el precio', () => {
  const inefableProducts = {
    'free-fire': [
      { id: 'free-fire--co-a', centralOneExtra: true, active: true, priceUsd: 1, calls: [{ packageId: 'a', quantity: 1 }] },
      { id: 'free-fire--co-b', centralOneExtra: true, active: true, priceUsd: 5, calls: [{ packageId: 'b', quantity: 1 }] },
      { id: 'free-fire--co-off', centralOneExtra: true, active: false, priceUsd: 0.5, calls: [{ packageId: 'a', quantity: 1 }] },
      { id: 'ff-co-nivel-6', active: true, priceUsd: 0.1, calls: [{ packageId: 'a', quantity: 1 }] },
    ],
    'freefire-id': [
      { id: 'freefire-id--co-nivel-completo', centralOneExtra: true, active: true, priceUsd: 2.5, calls: [{ packageId: 'a' }, { packageId: 'b' }] },
      { id: 'freefire-id--co-x', centralOneExtra: true, active: true, priceUsd: 0.1, calls: [{ packageId: 'desconocido' }] },
    ],
  };
  const offers = [
    { productId: 'a', costUsd: 1.2 },
    { productId: 'b', costUsd: 1.5 },
  ];
  assert.deepEqual(sync.findExtrasAtLoss(inefableProducts, offers), ['free-fire--co-a', 'freefire-id--co-nivel-completo']);
});

// ---------------------------------------------------------------------------
// Tests de Combos de Central One (Free Fire LATAM y Blood Strike)
// ---------------------------------------------------------------------------

test('planCentralOneCombos: Blood Strike genera los 5 combos de Gold con llamadas quantity: 1 y target_payload game_user_id', () => {
  const bloodStrikePlan = {
    id: 'co-topup-blood-strike-latam',
    familyName: 'Blood Strike',
    targetFields: ['game_user_id'],
    offers: [
      { productId: 'ebc6b685-9d50-4d42-9aae-48e8c089a793', label: '100 + 5 Gold', kind: 'package', amount: 100, costUsd: 0.7041, stock: null, providerAvailable: true },
      { productId: '35213545-bd4b-4e0b-8e76-b6ef476df25a', label: '300 + 20 Gold', kind: 'package', amount: 300, costUsd: 2.1172, stock: null, providerAvailable: true },
      { productId: 'a4600212-f5a1-40ab-805a-5a549c3b5fba', label: '500 + 40 Gold', kind: 'package', amount: 500, costUsd: 3.5278, stock: null, providerAvailable: true },
      { productId: '13f92eb4-f186-41d7-b4b0-432aa9b9f0d9', label: '1000 + 100 Gold', kind: 'package', amount: 1000, costUsd: 7.0555, stock: null, providerAvailable: true },
      { productId: '17b5a2e5-8820-440a-a8a5-b30913a6fad8', label: '2000 + 260 Gold', kind: 'package', amount: 2000, costUsd: 14.1112, stock: null, providerAvailable: true },
      { productId: '8f29be10-34de-456c-86e9-698353ede6bb', label: '5000 + 800 Gold', kind: 'package', amount: 5000, costUsd: 35.2753, stock: null, providerAvailable: true },
    ],
  };

  const result = sync.planCentralOneCombos({
    plan: bloodStrikePlan,
    specs: sync.BLOOD_STRIKE_COMBO_SPECS,
    targetGameId: bloodStrikePlan.id,
    existingProducts: new Map(),
    pricing: { marginPercent: 30, roundToUsd: 0.05 },
    timestamp: 'ts',
  });

  // 1. Debe generar exactamente los 5 combos de Gold
  assert.equal(result.combos.length, 5);
  const ids = result.combos.map((c) => c.id);
  assert.ok(ids.includes('co-topup-blood-strike-latam--c-425'));
  assert.ok(ids.includes('co-topup-blood-strike-latam--c-860'));
  assert.ok(ids.includes('co-topup-blood-strike-latam--c-1640'));
  assert.ok(ids.includes('co-topup-blood-strike-latam--c-3360'));
  assert.ok(ids.includes('co-topup-blood-strike-latam--c-8060'));

  // 2. Todas las llamadas deben tener estrictamente quantity: 1 y targetFields: ['game_user_id']
  for (const combo of result.combos) {
    assert.equal(combo.kind, 'combo');
    assert.equal(combo.provider, 'centralone');
    assert.deepEqual(combo.targetFields, ['game_user_id']);
    for (const call of combo.calls) {
      assert.equal(call.quantity, 1, `Combo ${combo.id} tiene llamada con quantity !== 1`);
      assert.equal(call.provider, 'centralone');
      assert.deepEqual(call.targetFields, ['game_user_id']);
    }
  }

  // 3. Verificación específica del combo 425 Gold (105 + 320)
  const c425 = result.combos.find((c) => c.id === 'co-topup-blood-strike-latam--c-425');
  assert.equal(c425.calls.length, 2);
  assert.equal(c425.calls[0].packageId, 'ebc6b685-9d50-4d42-9aae-48e8c089a793');
  assert.equal(c425.calls[0].quantity, 1);
  assert.equal(c425.calls[1].packageId, '35213545-bd4b-4e0b-8e76-b6ef476df25a');
  assert.equal(c425.calls[1].quantity, 1);
  assert.equal(c425.costUsd, 2.8213);
  assert.equal(c425.active, true);
});

test('planCentralOneCombos: Free Fire LATAM genera combos con regla estricta quantity: 1 (200+20 son 2 llamadas separadas)', () => {
  const freeFirePlan = {
    id: 'co-topup-free-fire-latam',
    familyName: 'Free Fire',
    targetFields: ['player_id'],
    offers: [
      { productId: 'ff-100', label: '110 Diamantes', kind: 'package', amount: 100, costUsd: 0.85, stock: null, providerAvailable: true },
      { productId: 'ff-310', label: '341 Diamantes', kind: 'package', amount: 310, costUsd: 2.50, stock: null, providerAvailable: true },
      { productId: 'ff-520', label: '572 Diamantes', kind: 'package', amount: 520, costUsd: 4.15, stock: null, providerAvailable: true },
      { productId: 'ff-1060', label: '1166 Diamantes', kind: 'package', amount: 1060, costUsd: 7.75, stock: null, providerAvailable: true },
      { productId: 'ff-2180', label: '2398 Diamantes', kind: 'package', amount: 2180, costUsd: 15.30, stock: null, providerAvailable: true },
      { productId: 'ff-5600', label: '6160 Diamantes', kind: 'package', amount: 5600, costUsd: 38.95, stock: null, providerAvailable: true },
    ],
  };

  const result = sync.planCentralOneCombos({
    plan: freeFirePlan,
    specs: sync.FREE_FIRE_LATAM_COMBO_SPECS,
    targetGameId: freeFirePlan.id,
    existingProducts: new Map(),
    pricing: { marginPercent: 20, roundToUsd: 0.05 },
    timestamp: 'ts',
  });

  // Genera los 7 combos de diamantes (220, 451, 682, 913, 1738, 3542, 8536)
  assert.equal(result.combos.length, 6);

  // Verificación estricta del primer combo (410 + 41 Diamantes):
  // Central One rechaza quantity > 1. Debe generar llamadas SEPARADAS con quantity: 1 cada una
  const c451 = result.combos.find((c) => c.id === 'co-topup-free-fire-latam--c-451');
  assert.ok(c451);
  assert.equal(c451.calls.length, 2);
  assert.equal(c451.calls[0].packageId, 'ff-310');
  assert.equal(c451.calls[0].quantity, 1);
  assert.equal(c451.calls[1].packageId, 'ff-100');
  assert.equal(c451.calls[1].quantity, 1);
  assert.equal(c451.costUsd, 3.35); // 2.50 + 0.85

  // Verificación de combos superiores
  const c1738 = result.combos.find((c) => c.id === 'co-topup-free-fire-latam--c-1738');
  assert.ok(c1738);
  assert.equal(c1738.calls.length, 2);
  assert.equal(c1738.calls[0].packageId, 'ff-1060');
  assert.equal(c1738.calls[0].quantity, 1);
  assert.equal(c1738.calls[1].packageId, 'ff-520');
  assert.equal(c1738.calls[1].quantity, 1);
  assert.equal(c1738.costUsd, 11.90); // 7.75 + 4.15

  const c8536 = result.combos.find((c) => c.id === 'co-topup-free-fire-latam--c-8536');
  assert.ok(c8536);
  assert.equal(c8536.calls.length, 2);
  assert.equal(c8536.calls[0].packageId, 'ff-5600');
  assert.equal(c8536.calls[0].quantity, 1);
  assert.equal(c8536.calls[1].packageId, 'ff-2180');
  assert.equal(c8536.calls[1].quantity, 1);
  assert.equal(c8536.costUsd, 54.25); // 38.95 + 15.30
});

test('planCentralOneCombos: propagación de stock y protección de precios personalizados', () => {
  const freeFirePlan = {
    id: 'co-topup-free-fire-latam',
    familyName: 'Free Fire',
    targetFields: ['player_id'],
    offers: [
      { productId: 'ff-100', label: '110 Diamantes', kind: 'package', amount: 100, costUsd: 1.00, stock: null, providerAvailable: true },
      // 310 diamantes sin stock en Central One:
      { productId: 'ff-310', label: '341 Diamantes', kind: 'package', amount: 310, costUsd: 3.00, stock: 0, providerAvailable: false },
      { productId: 'ff-520', label: '572 Diamantes', kind: 'package', amount: 520, costUsd: 4.00, stock: null, providerAvailable: true },
    ],
  };

  const existingMap = new Map([
    // Combo 682 ya existe con precio fijado por el admin
    [
      'co-topup-free-fire-latam--c-682',
      { id: 'co-topup-free-fire-latam--c-682', priceUsd: 7.50, priceLocked: true, costUsd: 4.80 },
    ],
  ]);

  const result = sync.planCentralOneCombos({
    plan: freeFirePlan,
    specs: sync.FREE_FIRE_LATAM_COMBO_SPECS.slice(0, 2), // 451 y 682
    targetGameId: freeFirePlan.id,
    existingProducts: existingMap,
    pricing: { marginPercent: 20, roundToUsd: 0.05 },
    timestamp: 'ts',
  });

  // 1. Combo 682: respeta el precio fijado por el admin (7.50) porque costUsd (4.00 + 1.00 = 5.00) <= 7.50
  const c682 = result.combos.find((c) => c.id === 'co-topup-free-fire-latam--c-682');
  assert.ok(c682);
  assert.equal(c682.costUsd, 5.00);
  assert.equal(c682.priceUsd, 7.50);
  assert.equal(c682.active, true);

  // 2. Combo 451: incluye ff-310 que no tiene stock -> combo marcado sin stock y active: false
  const c451 = result.combos.find((c) => c.id === 'co-topup-free-fire-latam--c-451');
  assert.ok(c451);
  assert.equal(c451.stock, 0);
  assert.equal(c451.active, false);

  // 3. Si el costo supera al precio fijado, se recalcula para no vender a pérdida
  const lossMap = new Map([
    [
      'co-topup-free-fire-latam--c-682',
      { id: 'co-topup-free-fire-latam--c-682', priceUsd: 4.00, priceLocked: true, costUsd: 3.50 },
    ],
  ]);
  const resultLoss = sync.planCentralOneCombos({
    plan: freeFirePlan,
    specs: [sync.FREE_FIRE_LATAM_COMBO_SPECS[1]], // c-682
    targetGameId: freeFirePlan.id,
    existingProducts: lossMap,
    pricing: { marginPercent: 20, roundToUsd: 0.05 },
    timestamp: 'ts',
  });
  const c682Loss = resultLoss.combos[0];
  assert.equal(c682Loss.costUsd, 5.00);
  // Nuevo precio calculado con margen (costo 5.00 * 1.20 = 6.00) porque 5.00 > 4.00
  assert.ok(c682Loss.priceUsd > 5.00);

  // 4. Con priceLocked: false, recalcula al margen automático incluso si el precio previo era mayor
  const unlockedMap = new Map([
    [
      'co-topup-free-fire-latam--c-682',
      { id: 'co-topup-free-fire-latam--c-682', priceUsd: 7.50, priceLocked: false, costUsd: 4.80 },
    ],
  ]);
  const resultUnlocked = sync.planCentralOneCombos({
    plan: freeFirePlan,
    specs: [sync.FREE_FIRE_LATAM_COMBO_SPECS[1]], // c-682
    targetGameId: freeFirePlan.id,
    existingProducts: unlockedMap,
    pricing: { marginPercent: 20, roundToUsd: 0.05 },
    timestamp: 'ts',
  });
  const c682Unlocked = resultUnlocked.combos[0];
  assert.equal(c682Unlocked.priceLocked, false);
  assert.equal(c682Unlocked.priceUsd, 6.00);
});
