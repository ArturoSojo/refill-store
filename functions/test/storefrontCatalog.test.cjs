const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Firestore en memoria: sólo lo que usan las consultas del catálogo .com
// (prefijo por id de documento, `where` con `==`/`in`, `count()`).
// ---------------------------------------------------------------------------
const gamesStore = new Map();
const queriesSeen = [];

function matches(data, [field, op, value]) {
  if (op === '==') return data[field] === value;
  if (op === 'in') return value.includes(data[field]);
  throw new Error(`op no soportada en el mock: ${op}`);
}

function gamesQuery(state = {}) {
  const next = (patch) => gamesQuery({ ...state, ...patch });
  const run = () => {
    queriesSeen.push(state);
    return [...gamesStore.keys()]
      .sort()
      .filter((id) => (state.startAt === undefined ? true : id >= state.startAt))
      .filter((id) => (state.startAfter === undefined ? true : id > state.startAfter))
      .filter((id) => (state.endAt === undefined ? true : id <= state.endAt))
      .filter((id) => (state.where ?? []).every((clause) => matches(gamesStore.get(id), clause)));
  };
  return {
    orderBy: () => next({}),
    endAt: (value) => next({ endAt: value }),
    startAt: (value) => next({ startAt: value }),
    startAfter: (value) => next({ startAfter: value }),
    limit: (value) => next({ limit: value }),
    where: (field, op, value) => next({ where: [...(state.where ?? []), [field, op, value]] }),
    count: () => ({ get: async () => ({ data: () => ({ count: run().length }) }) }),
    get: async () => {
      const ids = run().slice(0, state.limit ?? Infinity);
      return {
        empty: ids.length === 0,
        size: ids.length,
        docs: ids.map((id) => ({ id, data: () => ({ ...gamesStore.get(id) }) })),
      };
    },
    doc: (id) => ({
      get: async () => ({ exists: gamesStore.has(id), id, data: () => ({ ...gamesStore.get(id) }) }),
    }),
  };
}

const stubModule = (relPath, exportsObj) => {
  const full = path.resolve(__dirname, relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
};

const { Timestamp } = require('firebase-admin/firestore');
stubModule('../lib/config/firebase.js', {
  games: () => gamesQuery(),
  products: () => {
    throw new Error('products() no se usa en estas pruebas');
  },
  now: () => Timestamp.now(),
  Timestamp,
});

const { belongsToStorefront } = require('../lib/lib/storefront.js');
const catalog = require('../lib/services/catalog.js');

function game(overrides) {
  return {
    name: 'Juego',
    active: true,
    sortOrder: 100,
    currencyLabel: 'Recargas',
    validatesPlayerId: false,
    ...overrides,
  };
}

function product(overrides) {
  return {
    id: 'p',
    gameId: 'g',
    name: 'Producto',
    active: true,
    fulfillment: 'auto',
    calls: [],
    amount: 0,
    bonus: 0,
    sortOrder: 0,
    priceUsd: 1,
    costUsd: 0.5,
    stock: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Escaparate
// ---------------------------------------------------------------------------

test('belongsToStorefront: Central One entra en la tienda .com sin cambiar las reglas de Inefable', () => {
  assert.equal(belongsToStorefront({ id: 'co-topup-x', provider: 'centralone' }, 'fazercards'), true);
  assert.equal(belongsToStorefront({ id: 'co-topup-x', provider: 'centralone' }, 'inefable'), false);
  assert.equal(belongsToStorefront({ id: 'fz-topup-x', provider: 'fazercards' }, 'fazercards'), true);
  // Free Fire de Inefable: sigue igual; si alguien le pusiera `centralone`, se oculta (regla previa).
  assert.equal(belongsToStorefront({ id: 'free-fire', provider: 'inefable' }, 'fazercards'), true);
  assert.equal(belongsToStorefront({ id: 'freefire-id' }, 'fazercards'), true);
  assert.equal(belongsToStorefront({ id: 'free-fire', provider: 'centralone' }, 'fazercards'), false);
  assert.equal(belongsToStorefront({ id: 'manual-1', manual: true, provider: 'inefable' }, 'fazercards'), true);
  assert.equal(belongsToStorefront({ id: 'blood-strike', provider: 'inefable' }, 'fazercards'), false);
});

// ---------------------------------------------------------------------------
// Listas y búsqueda del catálogo sincronizado
// ---------------------------------------------------------------------------

function seedGames() {
  gamesStore.clear();
  gamesStore.set('co-topup-free-fire-latam', game({ provider: 'centralone', providerFamily: 'topup' }));
  gamesStore.set('co-topup-free-fire-global', game({ provider: 'centralone', providerFamily: 'topup', active: false }));
  gamesStore.set('co-gift_card-free-fire-global', game({ provider: 'centralone', providerFamily: 'gift_card' }));
  gamesStore.set('fz-topup-free-fire-latam', game({ provider: 'fazercards', providerFamily: 'topup' }));
  gamesStore.set('fz-topup-free-fire-old', game({ provider: 'fazercards', providerFamily: 'topup', active: false }));
  gamesStore.set('free-fire', game({ provider: 'inefable' }));
}

test('búsqueda: recorre los prefijos co- y fz- con un cursor que no repite ni pierde categorías', async () => {
  seedGames();
  const first = await catalog.searchStorefrontGamesByFamily('topup', 'free fire', { limit: 1 });
  assert.deepEqual(first.items.map((g) => g.id), ['co-topup-free-fire-latam']);
  assert.equal(first.nextCursor, 'co-topup-free-fire-latam');

  const second = await catalog.searchStorefrontGamesByFamily('topup', 'free fire', { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((g) => g.id), ['fz-topup-free-fire-latam']);
  assert.equal(second.nextCursor, null);

  // Un cursor del rango fz- no vuelve a recorrer el rango co-.
  const third = await catalog.searchStorefrontGamesByFamily('topup', 'free fire', { limit: 5, cursor: 'fz-topup-free-fire-latam' });
  assert.deepEqual(third.items, []);

  const all = await catalog.searchStorefrontGamesByFamily('topup', 'free', { limit: 10 });
  assert.deepEqual(all.items.map((g) => g.id), ['co-topup-free-fire-latam', 'fz-topup-free-fire-latam']);
  // El alias anterior sigue funcionando.
  assert.equal(catalog.searchFazerGamesByFamily, catalog.searchStorefrontGamesByFamily);
});

test('conteo: una sola consulta `in` sobre ambos proveedores, sin contar Inefable ni inactivos', async () => {
  seedGames();
  queriesSeen.length = 0;
  assert.equal(await catalog.countStorefrontGamesByFamily('topup'), 2);
  assert.equal(await catalog.countFazerGamesByFamily('gift_card'), 1);
  assert.deepEqual(queriesSeen[0].where[0], ['provider', 'in', ['fazercards', 'centralone']]);

  const list = await catalog.listStorefrontGamesByFamily('topup');
  assert.deepEqual(list.map((g) => g.id).sort(), ['co-topup-free-fire-latam', 'fz-topup-free-fire-latam']);
});

test('portada: fija los Free Fire de Inefable y suma los juegos de Central One', async () => {
  seedGames();
  gamesStore.set('freefire-id', game({ provider: 'inefable' }));
  const home = await catalog.listStorefrontHomeGamesByFamily('topup', 8);
  assert.deepEqual(home.map((g) => g.id), [
    'fz-topup-free-fire-latam',
    'freefire-id',
    'free-fire',
    'co-topup-free-fire-latam',
  ]);
});

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------

test('toPublicGame: moneda de los juegos de Central One por nombre, sin pisar la del admin', () => {
  const blood = catalog.toPublicGame(game({ id: 'co-topup-blood-strike-global', name: 'Blood Strike', provider: 'centralone', providerFamily: 'topup' }));
  assert.equal(blood.currencyLabel, 'Oro');
  assert.equal(blood.currencyIconUrl, '/coins/gold-bloodstrike.svg');

  const ff = catalog.toPublicGame(game({ id: 'co-topup-free-fire-latam', name: 'Free Fire', provider: 'centralone', providerFamily: 'topup', currencyLabel: '' }));
  assert.equal(ff.currencyLabel, 'Diamantes');

  const mlbb = catalog.toPublicGame(game({ id: 'co-topup-mobile-legends-br', name: 'Mobile Legends (BR)', provider: 'centralone', providerFamily: 'topup' }));
  assert.equal(mlbb.currencyLabel, 'Diamantes');
  assert.equal(mlbb.currencyIconUrl, '/coins/diamante-mlbb.svg');

  const custom = catalog.toPublicGame(game({ id: 'co-topup-blood-strike-global', name: 'Blood Strike', provider: 'centralone', providerFamily: 'topup', currencyLabel: 'Monedas' }));
  assert.equal(custom.currencyLabel, 'Monedas');

  const gift = catalog.toPublicGame(game({ id: 'co-gift_card-free-fire-global', name: 'Free Fire', provider: 'centralone', providerFamily: 'gift_card' }));
  assert.equal(gift.currencyLabel, 'Recargas');

  // Los ids fijos de antes siguen igual.
  assert.equal(catalog.toPublicGame(game({ id: 'free-fire', name: 'Free Fire 20%' })).currencyLabel, 'Diamantes');
  assert.equal(catalog.toPublicGame(game({ id: 'fz-topup-otro', name: 'Blood Strike', provider: 'fazercards', providerFamily: 'topup' })).currencyLabel, 'Recargas');
});

test('resolvePlayerFields: los juegos de Central One conservan sus campos del proveedor', () => {
  const declared = [
    { key: 'player_id', label: 'ID de jugador', pattern: '^\\d{1,30}$', help: 'h', placeholder: '', type: 'text', providerField: 'player_id', required: true, sensitive: false },
    { key: 'server_id', label: 'Servidor / Zone ID', pattern: '^(1|2)$', help: 'h', placeholder: '', type: 'select', options: [{ value: '1', label: 'Uno' }, { value: '2', label: 'Dos' }], providerField: 'player_id2', required: true, sensitive: false },
  ];
  const co = catalog.resolvePlayerFields(game({ id: 'co-topup-mobile-legends-global', name: 'Mobile Legends', provider: 'centralone', providerFamily: 'topup', playerFields: declared }));
  assert.deepEqual(co, declared);

  const fz = catalog.resolvePlayerFields(game({ id: 'fz-topup-mobile-legends-global', name: 'Mobile Legends', provider: 'fazercards', providerFamily: 'topup', playerFields: declared }));
  assert.equal(fz[0].label, 'User ID');
});

// ---------------------------------------------------------------------------
// Compra y validación
// ---------------------------------------------------------------------------

test('maxOrderQuantity: sólo pases y subidas de nivel no repetibles se limitan a 1; paquetes regulares y gift cards sin tope', () => {
  const coTopup = game({ id: 'co-topup-x', provider: 'centralone', providerFamily: 'topup' });
  const coGift = game({ id: 'co-gift_card-x', provider: 'centralone', providerFamily: 'gift_card' });
  const inefableFf = game({ id: 'free-fire', provider: 'inefable' });
  // Paquetes regulares admiten múltiples unidades para permitir compras compuestas (ej: 2 de 110)
  assert.equal(catalog.maxOrderQuantity(product({ provider: 'centralone' }), coTopup), null);
  assert.equal(catalog.maxOrderQuantity(product({}), coTopup), null);
  assert.equal(catalog.maxOrderQuantity(product({ provider: 'centralone' }), coGift), null);
  assert.equal(catalog.maxOrderQuantity(product({ provider: 'centralone' }), inefableFf), null);
  assert.equal(catalog.maxOrderQuantity(product({ provider: 'centralone', centralOneExtra: true }), inefableFf), null);
  assert.equal(catalog.maxOrderQuantity(product({}), inefableFf), null);
  // Subidas de nivel no repetibles se limitan a 1 por orden
  assert.equal(catalog.maxOrderQuantity(product({ kind: 'level_up' }), inefableFf), 1);
  assert.equal(catalog.maxOrderQuantity(product({ kind: 'level_up' }), coTopup), 1);
});

test('pickCentralOneValidationTarget: usa la oferta elegida si sirve; si no, la primera activa del juego', () => {
  const g = game({
    id: 'co-topup-mlbb',
    provider: 'centralone',
    providerFamily: 'topup',
    playerFields: [
      { key: 'player_id', label: 'ID', pattern: '.+', help: '', placeholder: '', type: 'text', providerField: 'player_id', required: true, sensitive: false },
      { key: 'zone_id', label: 'Zona', pattern: '.+', help: '', placeholder: '', type: 'text', providerField: 'player_id2', required: true, sensitive: false },
    ],
  });
  const cheap = product({ id: 'co-topup-mlbb--a', gameId: g.id, providerOfferId: 'A', targetFields: ['player_id', 'zone_id'], calls: [{ packageId: 'A', quantity: 1 }] });
  const chosen = product({ id: 'co-topup-mlbb--b', gameId: g.id, providerOfferId: 'B', calls: [{ packageId: 'B', quantity: 1, targetFields: ['player_id'] }] });
  const inactive = product({ id: 'co-topup-mlbb--c', gameId: g.id, providerOfferId: 'C', active: false });
  const noFields = product({ id: 'co-topup-mlbb--d', gameId: g.id, calls: [{ packageId: 'D', quantity: 1 }] });
  const manual = product({ id: 'co-topup-mlbb--m', gameId: g.id, fulfillment: 'manual', providerOfferId: 'M' });
  const list = [manual, cheap, chosen, inactive, noFields];

  const preferred = catalog.pickCentralOneValidationTarget(g, list, chosen.id);
  assert.equal(preferred.productId, 'B');
  assert.deepEqual(preferred.targetFields, ['player_id']);

  const fallback = catalog.pickCentralOneValidationTarget(g, list, inactive.id);
  assert.equal(fallback.productId, 'A');
  assert.deepEqual(fallback.targetFields, ['player_id', 'zone_id']);

  // Sin `targetFields` en producto ni call: las claves de los campos del juego.
  const derived = catalog.pickCentralOneValidationTarget(g, [noFields], null);
  assert.equal(derived.productId, 'D');
  assert.deepEqual(derived.targetFields, ['player_id', 'zone_id']);

  assert.equal(catalog.pickCentralOneValidationTarget(g, [manual, inactive], null), null);
  // Un producto de otro juego nunca se usa.
  assert.equal(catalog.pickCentralOneValidationTarget(g, [{ ...cheap, gameId: 'otro' }], cheap.id), null);
});
