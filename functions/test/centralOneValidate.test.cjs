const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock
// ---------------------------------------------------------------------------
const store = new Map();
let autoIdCounter = 0;

function clone(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = clone(v);
    }
    return out;
  }
  return value;
}

function makeDocRef(docPath) {
  return {
    path: docPath,
    id: docPath.split('/').pop(),
    get: async () => {
      const data = store.get(docPath);
      return {
        exists: Boolean(data),
        data: () => (data ? clone(data) : undefined),
      };
    },
    set: async (data, options) => {
      if (options && options.merge && store.has(docPath)) {
        store.set(docPath, { ...store.get(docPath), ...clone(data) });
      } else {
        store.set(docPath, clone(data));
      }
    },
    update: async (data) => {
      const existing = store.get(docPath) || {};
      store.set(docPath, { ...existing, ...clone(data) });
    },
    delete: async () => {
      store.delete(docPath);
    },
  };
}

function makeCollectionRef(colPath) {
  return {
    doc: (id) => {
      const docId = id || `auto_${++autoIdCounter}`;
      return makeDocRef(`${colPath}/${docId}`);
    },
  };
}

const mockDb = {
  collection: (name) => makeCollectionRef(name),
};

const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    COLLECTIONS: {
      playerIdCache: 'playerIdCache',
      orders: 'orders',
      games: 'games',
      products: 'products',
    },
    now: () => Timestamp.now(),
    playerIdCache: () => mockDb.collection('playerIdCache'),
    orders: () => mockDb.collection('orders'),
    games: () => mockDb.collection('games'),
    products: () => mockDb.collection('products'),
  },
};

// Configurar API key en el entorno
process.env.CENTRAL_ONE_API_KEY = 'co_live_test_api_key_valid_mock';
process.env.CENTRAL_ONE_BASE_URL = 'https://portal.centraloneglobal.com/api/v1';

// Compilar lib antes de requerir si fuera necesario
const centralOne = require('../lib/services/centralOne.js');

test('Central One - Validación de ID de Jugador y Caché Inteligente', async (t) => {
  const originalFetch = global.fetch;
  let fetchMockHandler = null;
  const fetchCalls = [];

  global.fetch = async (url, options) => {
    fetchCalls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (fetchMockHandler) {
      return fetchMockHandler(url, options);
    }
    throw new Error('fetchMockHandler no configurado');
  };

  t.after(() => {
    global.fetch = originalFetch;
    store.clear();
  });

  await t.test(
    '1. Respuesta "valid" con apodo del jugador y guardado en caché (playerIdCache)',
    async () => {
      store.clear();
      fetchCalls.length = 0;

      fetchMockHandler = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          status: 'valid',
          product_id: 'e7d8be5d-de17-4731-a3a0-9c6554c5ca78',
          player: { name: '⁺⁵⁸Layan¿?' },
        }),
      });

      const res = await centralOne.validatePlayerId({
        gameSlug: 'free-fire',
        playerId: '7008181939',
      });

      assert.equal(res.status, 'valid');
      assert.equal(res.playerName, '⁺⁵⁸Layan¿?');
      assert.equal(res.cached, false);
      assert.equal(res.supported, true);
      assert.equal(fetchCalls.length, 1);

      // Verificar que el payload a Central One usó player_id
      assert.deepEqual(fetchCalls[0].body.target_payload, { player_id: '7008181939' });
      assert.equal(fetchCalls[0].body.product_id, 'e7d8be5d-de17-4731-a3a0-9c6554c5ca78');

      // Verificar que se guardó en Firestore playerIdCache
      const cacheKey = centralOne.buildCacheKey('free-fire', '7008181939');
      const cached = store.get(`playerIdCache/${cacheKey}`);
      assert.ok(cached, 'El documento debe existir en playerIdCache');
      assert.equal(cached.status, 'valid');
      assert.equal(cached.playerName, '⁺⁵⁸Layan¿?');
      assert.equal(cached.gameSlug, 'free-fire');
      assert.equal(cached.playerId, '7008181939');
    }
  );

  await t.test(
    '2. Segunda consulta al mismo ID servida desde caché sin llamar a la API de Central One',
    async () => {
      fetchCalls.length = 0;

      // Si se intentara llamar a la API externa, lanzaría un error
      fetchMockHandler = async () => {
        throw new Error('No debe llamar a la API de Central One si está en caché');
      };

      const res = await centralOne.validatePlayerId({
        gameSlug: 'free-fire',
        playerId: '7008181939',
      });

      assert.equal(res.status, 'valid');
      assert.equal(res.playerName, '⁺⁵⁸Layan¿?');
      assert.equal(res.cached, true);
      assert.equal(res.supported, true);
      assert.equal(fetchCalls.length, 0, 'No debe consumir cuota de la API');
    }
  );

  await t.test('3. Respuesta "invalid" rechazando el ID', async () => {
    fetchCalls.length = 0;

    fetchMockHandler = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        status: 'invalid',
        product_id: 'e7d8be5d-de17-4731-a3a0-9c6554c5ca78',
      }),
    });

    const res = await centralOne.validatePlayerId({
      gameSlug: 'free-fire',
      playerId: '99999999999',
    });

    assert.equal(res.status, 'invalid');
    assert.equal(res.playerName, null);
    assert.match(res.message, /no existe/i);
    assert.equal(res.supported, true);

    // No debe haber quedado en caché como válido
    const cacheKey = centralOne.buildCacheKey('free-fire', '99999999999');
    const cached = store.get(`playerIdCache/${cacheKey}`);
    assert.equal(cached, undefined);
  });

  await t.test(
    '4. Respuesta "unverified" o HTTP 429 degradando con elegancia (permitiendo continuar sin romper el checkout)',
    async () => {
      // 4a. Error HTTP 429 (límite de 30 llamadas/min)
      fetchCalls.length = 0;
      fetchMockHandler = async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: 'Rate limit exceeded' }),
      });

      const res429 = await centralOne.validatePlayerId({
        gameSlug: 'blood-strike',
        playerId: '12345678',
      });

      assert.equal(res429.status, 'unverified');
      assert.equal(res429.reason, 'rate_limited');
      assert.match(res429.message, /no fue posible verificar/i);
      assert.equal(res429.supported, true);

      // Verificar que Blood Strike usó game_user_id en Central One
      assert.deepEqual(fetchCalls[0].body.target_payload, { game_user_id: '12345678' });
      assert.equal(fetchCalls[0].body.product_id, 'c98ff6be-e087-4cdc-80a2-9a784e0e6700');

      // 4b. Respuesta Central One status = unverified
      fetchCalls.length = 0;
      fetchMockHandler = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          status: 'unverified',
          reason: 'temporarily_unavailable',
        }),
      });

      const resUnverified = await centralOne.validatePlayerId({
        gameSlug: 'pubg-mobile',
        playerId: '5123456789',
      });

      assert.equal(resUnverified.status, 'unverified');
      assert.equal(resUnverified.reason, 'temporarily_unavailable');
      assert.match(resUnverified.message, /no fue posible verificar/i);

      // 4c. Timeout de red (AbortError)
      fetchCalls.length = 0;
      fetchMockHandler = async () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      };

      const resTimeout = await centralOne.validatePlayerId({
        gameSlug: 'arena-breakout',
        playerId: '1023456789',
      });

      assert.equal(resTimeout.status, 'unverified');
      assert.equal(resTimeout.reason, 'AbortError');
      assert.match(resTimeout.message, /no fue posible verificar/i);
    }
  );

  await t.test(
    '5. Mobile Legends mapea correctamente player_id y server_id hacia Central One',
    async () => {
      fetchCalls.length = 0;
      fetchMockHandler = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          status: 'valid',
          product_id: 'e4f28fe6-7031-429a-9396-7df14ad7bc68',
          player: { name: 'MGLegendPro' },
        }),
      });

      const res = await centralOne.validatePlayerId({
        gameSlug: 'mobile-legends',
        playerId: '12345678',
        serverId: '2345',
      });

      assert.equal(res.status, 'valid');
      assert.equal(res.playerName, 'MGLegendPro');
      assert.equal(fetchCalls.length, 1);
      assert.deepEqual(fetchCalls[0].body.target_payload, {
        player_id: '12345678',
        server_id: '2345',
      });
      assert.equal(fetchCalls[0].body.product_id, 'e4f28fe6-7031-429a-9396-7df14ad7bc68');
    }
  );
});

