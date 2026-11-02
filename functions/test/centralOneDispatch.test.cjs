const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock with transaction & query support
// ---------------------------------------------------------------------------
const store = new Map();
let autoIdCounter = 0;
let txChain = Promise.resolve();

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

function deepMerge(target, source) {
  const out = clone(target || {});
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Timestamp) &&
      typeof value.toMillis !== 'function' &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key]) &&
      !(out[key] instanceof Timestamp)
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function getByPath(obj, fieldPath) {
  return fieldPath.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

function toComparable(val) {
  if (val && typeof val.toMillis === 'function') return val.toMillis();
  return val;
}

function makeSnap(docPath) {
  const id = docPath.split('/').pop();
  const data = store.get(docPath);
  return {
    id,
    path: docPath,
    exists: Boolean(data),
    data: () => (data ? clone(data) : undefined),
    ref: makeDocRef(docPath),
  };
}

function makeDocRef(docPath) {
  return {
    path: docPath,
    id: docPath.split('/').pop(),
    firestore: mockDb,
    collection: (subCol) => makeCollectionRef(`${docPath}/${subCol}`),
    get: async () => makeSnap(docPath),
    set: async (data, options) => {
      if (options && options.merge && store.has(docPath)) {
        store.set(docPath, deepMerge(store.get(docPath), data));
      } else {
        store.set(docPath, clone(data));
      }
    },
    update: async (data) => {
      const current = clone(store.get(docPath) || {});
      for (const [k, v] of Object.entries(data)) {
        if (k.includes('.')) {
          const parts = k.split('.');
          let cursor = current;
          for (let i = 0; i < parts.length - 1; i += 1) {
            cursor[parts[i]] = clone(cursor[parts[i]] || {});
            cursor = cursor[parts[i]];
          }
          cursor[parts[parts.length - 1]] = clone(v);
        } else {
          current[k] = clone(v);
        }
      }
      store.set(docPath, current);
    },
    delete: async () => {
      store.delete(docPath);
    },
  };
}

function makeQuery(colPath, filters = [], limitCount = null) {
  return {
    where: (field, op, value) => makeQuery(colPath, [...filters, { field, op, value }], limitCount),
    orderBy: () => makeQuery(colPath, filters, limitCount),
    limit: (n) => makeQuery(colPath, filters, n),
    count: () => ({
      get: async () => {
        const snap = await makeQuery(colPath, filters, limitCount).get();
        return { data: () => ({ count: snap.size }) };
      },
    }),
    get: async () => {
      const prefix = `${colPath}/`;
      const docs = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) continue;
        const matches = filters.every(({ field, op, value }) => {
          const docVal = getByPath(v, field);
          if (op === '==') return toComparable(docVal) === toComparable(value);
          if (op === 'in') return Array.isArray(value) && value.includes(docVal);
          if (op === '<=') return toComparable(docVal) !== null && toComparable(docVal) !== undefined && toComparable(docVal) <= toComparable(value);
          if (op === '<') return toComparable(docVal) !== null && toComparable(docVal) !== undefined && toComparable(docVal) < toComparable(value);
          if (op === '>=') return toComparable(docVal) !== null && toComparable(docVal) !== undefined && toComparable(docVal) >= toComparable(value);
          if (op === '>') return toComparable(docVal) !== null && toComparable(docVal) !== undefined && toComparable(docVal) > toComparable(value);
          return false;
        });
        if (matches) {
          docs.push({
            id: rest,
            path: k,
            exists: true,
            data: () => clone(v),
            ref: makeDocRef(k),
          });
        }
      }
      const sliced = limitCount !== null ? docs.slice(0, limitCount) : docs;
      return {
        empty: sliced.length === 0,
        size: sliced.length,
        docs: sliced,
      };
    },
  };
}

function makeCollectionRef(colPath) {
  const baseQuery = makeQuery(colPath);
  return {
    ...baseQuery,
    firestore: mockDb,
    doc: (id) => {
      const docId = id || `auto_${++autoIdCounter}`;
      return makeDocRef(`${colPath}/${docId}`);
    },
    add: async (data) => {
      const ref = makeDocRef(`${colPath}/auto_${++autoIdCounter}`);
      await ref.set(data);
      return ref;
    },
  };
}

const mockDb = {
  collection: (name) => makeCollectionRef(name),
  doc: (path) => makeDocRef(path),
  runTransaction: (fn) => {
    const run = txChain.then(async () => {
      let hasWritten = false;
      const stagedWrites = [];
      const tx = {
        get: async (ref) => {
          if (hasWritten) {
            throw new Error('Firestore transactions require all reads to be executed before all writes.');
          }
          return makeSnap(ref.path);
        },
        set: (ref, data, options) => {
          hasWritten = true;
          stagedWrites.push(() => ref.set(data, options));
        },
        update: (ref, data) => {
          hasWritten = true;
          stagedWrites.push(() => ref.update(data));
        },
        create: (ref, data) => {
          hasWritten = true;
          stagedWrites.push(() => {
            if (store.has(ref.path)) throw new Error('Document already exists');
            return ref.set(data);
          });
        },
      };
      const result = await fn(tx);
      for (const apply of stagedWrites) {
        await apply();
      }
      return result;
    });
    txChain = run.catch(() => {});
    return run;
  },
};

const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    auth: {},
    storage: {},
    COLLECTIONS: {
      games: 'games',
      products: 'products',
      orders: 'orders',
      users: 'users',
      coupons: 'coupons',
      config: 'config',
      auditLogs: 'auditLogs',
      tickets: 'tickets',
      paymentRefs: 'paymentRefs',
      rateHistory: 'rateHistory',
      rateLimits: 'rateLimits',
      stats: 'stats',
      adminAlerts: 'adminAlerts',
      creators: 'creators',
      creatorCodes: 'creatorCodes',
      modals: 'modals',
      providerOrders: 'providerOrders',
      playerIdCache: 'playerIdCache',
    },
    CONFIG_DOC_ID: 'app',
    games: () => mockDb.collection('games'),
    products: () => mockDb.collection('products'),
    orders: () => mockDb.collection('orders'),
    users: () => mockDb.collection('users'),
    coupons: () => mockDb.collection('coupons'),
    auditLogs: () => mockDb.collection('auditLogs'),
    tickets: () => mockDb.collection('tickets'),
    paymentRefs: () => mockDb.collection('paymentRefs'),
    rateHistory: () => mockDb.collection('rateHistory'),
    rateLimits: () => mockDb.collection('rateLimits'),
    adminAlerts: () => mockDb.collection('adminAlerts'),
    creators: () => mockDb.collection('creators'),
    creatorCodes: () => mockDb.collection('creatorCodes'),
    modals: () => mockDb.collection('modals'),
    providerOrders: () => mockDb.collection('providerOrders'),
    playerIdCache: () => mockDb.collection('playerIdCache'),
    dailyStats: () => mockDb.collection('stats').doc('daily').collection('days'),
    configDoc: () => mockDb.collection('config').doc('app'),
    now: () => Timestamp.now(),
    fromMillis: (ms) => Timestamp.fromMillis(ms),
    minutesFromNow: (m) => Timestamp.fromMillis(Date.now() + m * 60 * 1000),
  },
};

// Side effects mock: telegram & push notifications
const telegramModulePath = path.resolve(__dirname, '../lib/services/telegramSupportBot.js');
require.cache[telegramModulePath] = {
  id: telegramModulePath,
  filename: telegramModulePath,
  loaded: true,
  exports: {
    sendCustomerOrderNotification: async () => {},
    sendCustomerRefundNotification: async () => {},
    sendAdminNewOrderNotification: async () => {},
    sendAdminRefundNotification: async () => {},
    sendAdminUrgentAlert: async () => {},
    sendAdminManualReviewNotification: async () => {},
  },
};

process.env.CENTRAL_ONE_API_KEY = 'test_co_key_123';

const centralOne = require('../lib/services/centralOne.js');
const dispatchService = require('../lib/services/dispatch.js');
const ordersService = require('../lib/services/orders.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Central One Dispatch & Post-Order Lifecycle', async (t) => {
  const originalFetch = global.fetch;

  t.afterEach(() => {
    store.clear();
    global.fetch = originalFetch;
  });

  await t.test('1. Despacho exitoso: 201 confirmed seguido de consulta rápida GET completed', async () => {
    const orderId = 'ord-co-success-1';
    const fakeCoUuid = 'co-ord-uuid-001';

    // Guardar orden y producto
    store.set(`products/ff-co-nivel-6`, {
      name: 'Paquete de mejora de nivel - Nivel 6',
      kind: 'level_up',
      fulfillment: 'auto',
      provider: 'centralone',
      priceUsd: 0.40,
      active: true,
      dispatchCalls: [
        { packageId: '00147efa-cc79-4767-8306-9b5dc45e2757', provider: 'centralone' }
      ]
    });

    store.set(`orders/${orderId}`, {
      code: 'RF-CO-01',
      uid: 'user-co-test',
      user: { email: 'gamer@example.com', displayName: 'Gamer' },
      status: 'paid',
      estado: 'POR_DESPACHAR',
      fulfillment: 'auto',
      provider: 'centralone',
      productId: 'ff-co-nivel-6',
      productName: 'Paquete de mejora de nivel - Nivel 6',
      playerId: '7008181939',
      playerNickname: 'ProGamer_123',
      gameId: 'free-fire',
      gameName: 'Free Fire',
      pricing: { totalUsd: 0.40 },
      dispatch: {
        allSucceeded: false,
        calls: [
          {
            index: 0,
            packageId: '00147efa-cc79-4767-8306-9b5dc45e2757',
            provider: 'centralone',
            status: 'pending',
            attempts: 0,
          }
        ]
      }
    });

    let postCount = 0;
    let getCount = 0;

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (options.method === 'POST' && urlStr.includes('/orders')) {
        postCount++;
        const body = JSON.parse(options.body);
        assert.equal(body.items[0].catalog_item_id, '00147efa-cc79-4767-8306-9b5dc45e2757');
        assert.equal(body.items[0].target_payload.player_id, '7008181939');
        assert.ok(options.headers['Idempotency-Key']);

        return {
          ok: true,
          status: 201,
          json: async () => ({
            order: {
              id: fakeCoUuid,
              reference_code: 'REF-CO-001',
              status: 'confirmed',
              total_sale_amount: '0.2018',
              currency: 'USD',
              pricing: {
                total_sale_amount: '0.2018',
                balance_after: '49.7982'
              }
            }
          })
        };
      }

      if (options.method === 'GET' && urlStr.includes(`/orders/${fakeCoUuid}`)) {
        getCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            order: {
              id: fakeCoUuid,
              reference_code: 'REF-CO-001',
              status: 'completed',
              total_sale_amount: '0.2018',
              items: [
                {
                  id: 'item-1',
                  status: 'completed',
                  total_sale_price: '0.2018'
                }
              ]
            }
          })
        };
      }

      throw new Error(`Unexpected request: ${options.method} ${urlStr}`);
    };

    const res = await dispatchService.dispatchOrder(orderId, { actor: 'system' });
    assert.equal(res.status, 'completed');
    assert.equal(res.allSucceeded, true);
    assert.equal(postCount, 1);
    assert.equal(getCount, 1);

    const saved = store.get(`orders/${orderId}`);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.dispatch.calls[0].status, 'success');
    assert.equal(saved.dispatch.calls[0].providerOrderId, fakeCoUuid);
    assert.equal(saved.dispatch.calls[0].provider, 'centralone');
  });

  await t.test('2. Bloqueo de reembolso mientras Central One está en processing', async () => {
    const orderId = 'ord-co-proc-1';
    const fakeCoUuid = 'co-ord-uuid-002';

    store.set(`orders/${orderId}`, {
      code: 'RF-CO-02',
      uid: 'user-co-test',
      user: { email: 'gamer@example.com', displayName: 'Gamer' },
      status: 'in_review',
      estado: 'DESPACHANDO_CENTRAL_ONE',
      fulfillment: 'auto',
      provider: 'centralone',
      productId: 'ff-co-nivel-10',
      productName: 'Paquete Subida de Nivel 10',
      playerId: '7008181939',
      reviewDeadline: Timestamp.fromMillis(Date.now() - 5000), // Ya venció la hora
      pricing: { totalUsd: 0.60, paidWithWalletUsd: 0.60 },
      dispatch: {
        allSucceeded: false,
        calls: [
          {
            index: 0,
            packageId: '0d351e69-6360-42bc-9b83-94de2c26b4be',
            provider: 'centralone',
            providerOrderId: fakeCoUuid,
            status: 'processing',
            attempts: 1,
          }
        ]
      }
    });

    global.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (options.method === 'GET' && urlStr.includes(`/orders/${fakeCoUuid}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            order: {
              id: fakeCoUuid,
              reference_code: 'REF-CO-002',
              status: 'processing',
              items: [
                {
                  id: 'item-1',
                  status: 'processing'
                }
              ]
            }
          })
        };
      }
      throw new Error(`Unexpected fetch: ${options.method} ${urlStr}`);
    };

    const count = await ordersService.refundStaleReviewOrders(10);
    assert.equal(count, 0, 'No debe auto-reembolsar una orden que sigue en procesamiento en Central One');

    const updated = store.get(`orders/${orderId}`);
    assert.equal(updated.status, 'dispatching');
    assert.equal(updated.estado, 'DESPACHANDO_CENTRAL_ONE');
    assert.ok(updated.reviewDeadline.toMillis() > Date.now());
  });

  await t.test('3. Manejo de error not_eligible / do_not_retry reporta mensaje claro y no reintenta', async () => {
    const orderId = 'ord-co-not-eligible';

    store.set(`products/ff-co-nivel-15`, {
      name: 'Paquete de mejora de nivel - Nivel 15',
      kind: 'level_up',
      fulfillment: 'auto',
      provider: 'centralone',
      priceUsd: 0.60,
      active: true,
      dispatchCalls: [
        { packageId: '3e2b9bd8-2293-4bd4-8978-316603eec328', provider: 'centralone' }
      ]
    });

    store.set(`orders/${orderId}`, {
      code: 'RF-CO-03',
      uid: 'user-co-test',
      user: { email: 'gamer@example.com', displayName: 'Gamer' },
      status: 'paid',
      estado: 'POR_DESPACHAR',
      fulfillment: 'auto',
      provider: 'centralone',
      productId: 'ff-co-nivel-15',
      productName: 'Paquete de mejora de nivel - Nivel 15',
      playerId: '7008181939',
      gameId: 'free-fire',
      gameName: 'Free Fire',
      pricing: { totalUsd: 0.60 },
      dispatch: {
        allSucceeded: false,
        calls: [
          {
            index: 0,
            packageId: '3e2b9bd8-2293-4bd4-8978-316603eec328',
            provider: 'centralone',
            status: 'pending',
            attempts: 0,
          }
        ]
      }
    });

    global.fetch = async (url, options = {}) => {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            code: 'not_eligible',
            action: 'do_not_retry',
            message: 'Player has already claimed this level reward'
          }
        })
      };
    };

    const res = await dispatchService.dispatchOrder(orderId, { actor: 'system' });
    assert.equal(res.status, 'in_review');

    const saved = store.get(`orders/${orderId}`);
    assert.equal(saved.dispatch.calls[0].status, 'error');
    assert.match(
      saved.dispatch.calls[0].error,
      /no es elegible para este nivel/i
    );
  });

  await t.test('4. buildCallPlan: cada llamada expandida es UNA unidad y congela targetFields', async () => {
    const plan = dispatchService.buildCallPlan([
      { packageId: 'co-item-1', quantity: 3, provider: 'centralone', targetFields: ['game_user_id'] },
      { packageId: 112, quantity: 1 },
    ]);
    assert.equal(plan.length, 4);
    assert.ok(plan.every((call) => call.quantity === 1), 'Nunca N×N: cada entrada del plan compra 1');
    assert.deepEqual(plan[0].targetFields, ['game_user_id']);
    assert.deepEqual(plan[2].targetFields, ['game_user_id']);
    assert.equal(plan[3].targetFields, undefined, 'Sin lista no se inventa targetFields');
    assert.deepEqual(plan.map((call) => call.index), [0, 1, 2, 3]);
  });

  await t.test('5. Despacho de Oro de Blood Strike por Central One: envía target_payload con game_user_id', async () => {
    const orderId = 'ord-bs-gold-1';
    store.set(`orders/${orderId}`, {
      id: orderId,
      code: 'RF-BS-01',
      uid: 'user-bs-test',
      user: { email: 'striker@example.com', displayName: 'Striker' },
      status: 'paid',
      estado: 'POR_DESPACHAR',
      fulfillment: 'auto',
      provider: 'centralone',
      productId: 'bs-g-105',
      productName: '100 + 5 Gold',
      playerId: '9988776655',
      gameId: 'blood-strike',
      gameName: 'Blood Strike',
      pricing: { totalUsd: 0.95 },
      dispatch: {
        allSucceeded: false,
        calls: [
          {
            index: 0,
            packageId: 'ebc6b685-9d50-4d42-9aae-48e8c089a793',
            provider: 'centralone',
            status: 'pending',
            attempts: 0,
          }
        ]
      }
    });

    let capturedPostBody = null;

    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.includes('/orders')) {
        capturedPostBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 201,
          json: async () => ({
            order: {
              id: 'co-ord-bs-100',
              reference_code: 'CO-ORD-BS-REF',
              status: 'confirmed',
              total_sale_amount: '0.7041',
              currency: 'USD',
            }
          })
        };
      }

      if (u.includes('/orders/co-ord-bs-100')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            order: {
              id: 'co-ord-bs-100',
              reference_code: 'CO-ORD-BS-REF',
              status: 'completed',
              total_sale_amount: '0.7041',
              currency: 'USD',
              target_payload: { game_user_id: '9988776655' },
              player: { name: 'BloodHero' },
            }
          })
        };
      }

      return { ok: false, status: 404, json: async () => ({}) };
    };

    const res = await dispatchService.dispatchOrder(orderId, { actor: 'system' });
    assert.equal(res.status, 'completed');

    // Comprobación explícita del target_payload exigido por Central One para Blood Strike
    assert.ok(capturedPostBody, 'Debe haber disparado POST /api/v1/orders');
    assert.equal(capturedPostBody.items.length, 1);
    assert.equal(capturedPostBody.items[0].catalog_item_id, 'ebc6b685-9d50-4d42-9aae-48e8c089a793');
    assert.deepEqual(
      capturedPostBody.items[0].target_payload,
      { game_user_id: '9988776655' },
      'Para Blood Strike, Central One exige obligatoriamente target_payload: { game_user_id }'
    );

    assert.equal(res.allSucceeded, true);

    const saved = store.get(`orders/${orderId}`);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.dispatch.calls[0].status, 'success');
    assert.equal(saved.dispatch.calls[0].providerOrderId, 'co-ord-bs-100');
  });

  // -------------------------------------------------------------------------
  // Llave de idempotencia, pausa por saldo, códigos y webhook
  // -------------------------------------------------------------------------

  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  /** Orden automática de Central One lista para despachar (o ya en curso). */
  function seedCoOrder(orderId, overrides = {}, call = {}) {
    const { dispatch: dispatchOverride, ...rest } = overrides;
    store.set(`orders/${orderId}`, {
      code: 'RF-AAAAAA',
      uid: 'user-co-test',
      user: { email: 'gamer@example.com', displayName: 'Gamer' },
      status: 'paid',
      estado: 'POR_DESPACHAR',
      fulfillment: 'auto',
      provider: 'centralone',
      providerFamily: 'topup',
      productId: 'co-topup-x--item',
      productName: 'Paquete',
      playerId: '7008181939',
      playerId2: null,
      playerFields: {},
      gameId: 'co-topup-x-latam',
      gameName: 'Juego CO',
      pricing: { totalUsd: 1, quantity: 1, totalBs: 100 },
      payment: { method: 'wallet' },
      emailsSent: [],
      ...rest,
      dispatch: {
        startedAt: null,
        completedAt: null,
        lastError: null,
        ...(dispatchOverride || {}),
        calls: [
          {
            index: 0,
            packageId: 'co-item-uuid',
            provider: 'centralone',
            quantity: 1,
            status: 'pending',
            attempts: 0,
            providerOrderId: null,
            providerStatus: null,
            providerReference: null,
            playerName: null,
            error: null,
            httpStatus: null,
            providerResponse: null,
            completedAt: null,
            ...call,
          },
        ],
      },
    });
  }

  function alertsStored() {
    return [...store.entries()]
      .filter(([k]) => k.startsWith('adminAlerts/'))
      .map(([, v]) => v);
  }

  await t.test('6. targetFields: target_payload con exactamente esas claves, quantity 1 y respaldo posicional', async () => {
    seedCoOrder(
      'ord-co-fields-1',
      { code: 'RF-FLD001', playerFields: { game_user_id: '555', server_id: '2001', otro: 'x' } },
      { quantity: 3, targetFields: ['game_user_id', 'server_id'] }
    );

    const bodies = [];
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        bodies.push(JSON.parse(options.body));
        return jsonResponse(201, { order: { id: 'co-fld-1', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-fld-1')) {
        return jsonResponse(200, { order: { id: 'co-fld-1', status: 'completed', items: [{ status: 'completed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const res = await dispatchService.dispatchOrder('ord-co-fields-1');
    assert.equal(res.status, 'completed');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].items[0].quantity, 1, 'Siempre quantity 1 por llamada expandida');
    assert.deepEqual(bodies[0].items[0].target_payload, { game_user_id: '555', server_id: '2001' });

    // Respaldo: sin valor por clave, la 1ª toma playerId y la 2ª playerId2.
    seedCoOrder(
      'ord-co-fields-2',
      { code: 'RF-FLD002', playerId: '123', playerId2: '45', playerFields: {} },
      { targetFields: ['player_id', 'zone_id'] }
    );
    bodies.length = 0;
    await dispatchService.dispatchOrder('ord-co-fields-2');
    assert.deepEqual(bodies[0].items[0].target_payload, { player_id: '123', zone_id: '45' });
  });

  await t.test('7. POST ambiguo (5xx): misma llave, nunca rota; el cron la recupera con esa llave', async () => {
    seedCoOrder('ord-co-amb-1', { code: 'RF-AMB001' });

    const keys = [];
    let phase = 'down';
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        keys.push(options.headers['Idempotency-Key']);
        if (phase === 'down') return jsonResponse(503, { error: { code: 'service_unavailable' } });
        return jsonResponse(201, { order: { id: 'co-amb-1', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-amb-1')) {
        return jsonResponse(200, { order: { id: 'co-amb-1', status: 'completed', items: [{ status: 'completed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const res = await dispatchService.dispatchOrder('ord-co-amb-1');
    assert.equal(res.status, 'dispatching', 'Ambiguo = en curso, no en revisión');
    let saved = store.get('orders/ord-co-amb-1');
    const call = saved.dispatch.calls[0];
    assert.equal(call.status, 'processing');
    assert.equal(call.providerOrderId, null);
    assert.equal(call.idempotencyKey, 'RF-AMB001-1');
    assert.equal(call.errorCode, 'ambiguous');
    assert.equal(call.keyClosed, false);

    phase = 'up';
    await dispatchService.resolveProcessingOrders();
    saved = store.get('orders/ord-co-amb-1');
    assert.equal(saved.status, 'completed');
    assert.equal(saved.dispatch.calls[0].providerOrderId, 'co-amb-1');
    assert.ok(keys.length >= 3);
    assert.ok(keys.every((key) => key === 'RF-AMB001-1'), `Todas las llaves deben ser la base: ${keys.join(',')}`);
  });

  await t.test('8. Tras 3 POST ambiguos con la misma llave pasa a revisión y NO se auto-reembolsa', async () => {
    seedCoOrder(
      'ord-co-amb-2',
      { code: 'RF-AMB002', status: 'dispatching', dispatch: { startedAt: Timestamp.now() } },
      {
        status: 'processing',
        attempts: 3,
        idempotencyKey: 'RF-AMB002-1',
        keyAttempts: 3,
        errorCode: 'ambiguous',
        keyClosed: false,
        httpStatus: 503,
      }
    );

    global.fetch = async (url, options = {}) => {
      throw new Error(`No debe llamar a Central One: ${options.method} ${url}`);
    };

    await dispatchService.resolveProcessingOrders();
    let saved = store.get('orders/ord-co-amb-2');
    assert.equal(saved.status, 'in_review');
    assert.equal(saved.dispatch.calls[0].status, 'error');
    assert.equal(saved.dispatch.calls[0].errorCode, 'ambiguous_unresolved');
    assert.match(saved.dispatch.calls[0].error, /pudo haber entrado en Central One/);

    // Vence la revisión: el pedido pudo existir, así que no se reembolsa.
    store.set('orders/ord-co-amb-2', { ...saved, reviewDeadline: Timestamp.fromMillis(Date.now() - 1000) });
    const refunded = await ordersService.refundStaleReviewOrders(10);
    assert.equal(refunded, 0);
    saved = store.get('orders/ord-co-amb-2');
    assert.equal(saved.status, 'in_review');
    assert.ok(saved.reviewDeadline.toMillis() > Date.now(), 'Se pospone la revisión en vez de reembolsar');
  });

  await t.test('9. Rotación de llave sólo tras fallo CONFIRMADO por GET /orders/{id}', async () => {
    const failedCall = {
      status: 'error',
      attempts: 1,
      providerOrderId: 'co-failed-1',
      providerStatus: 'failed',
      idempotencyKey: 'RF-ROT001-1',
      keyAttempts: 1,
      error: 'Falló',
    };
    seedCoOrder('ord-co-rot-1', { code: 'RF-ROT001', status: 'in_review' }, failedCall);

    let keys = [];
    let oldOrderReadable = true;
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        keys.push(options.headers['Idempotency-Key']);
        return jsonResponse(201, { order: { id: 'co-new-1', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-failed-1')) {
        if (!oldOrderReadable) return jsonResponse(500, { error: { code: 'internal_error' } });
        return jsonResponse(200, { order: { id: 'co-failed-1', status: 'failed', items: [{ status: 'failed' }] } });
      }
      if (u.endsWith('/orders/co-new-1')) {
        return jsonResponse(200, { order: { id: 'co-new-1', status: 'completed', items: [{ status: 'completed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const res = await dispatchService.dispatchOrder('ord-co-rot-1', { isRetry: true });
    assert.equal(res.status, 'completed');
    assert.deepEqual(keys, ['RF-ROT001-1-r2'], 'Pedido anterior cerrado sin entregar: llave nueva');

    // Si el pedido anterior no se puede confirmar, se repite la MISMA llave.
    seedCoOrder('ord-co-rot-2', { code: 'RF-ROT002', status: 'in_review' }, {
      ...failedCall,
      idempotencyKey: 'RF-ROT002-1',
    });
    keys = [];
    oldOrderReadable = false;
    await dispatchService.dispatchOrder('ord-co-rot-2', { isRetry: true });
    assert.deepEqual(keys, ['RF-ROT002-1']);
  });

  await t.test('10. Gift card: sin target_payload y completa sólo con códigos (fuera de providerResponse)', async () => {
    seedCoOrder(
      'ord-co-gift-1',
      { code: 'RF-GFT001', providerFamily: 'gift_card', playerId: '' },
      { targetFields: [] }
    );

    let postBody = null;
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        postBody = JSON.parse(options.body);
        return jsonResponse(201, { order: { id: 'co-gift-1', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-gift-1/codes')) {
        return jsonResponse(200, {
          order: { items: [{ product_name: 'Google Play $10', status: 'completed', codes: ['GPLAY-SECRET-1234'] }] },
        });
      }
      if (u.endsWith('/orders/co-gift-1')) {
        return jsonResponse(200, {
          order: { id: 'co-gift-1', status: 'completed', items: [{ status: 'completed', delivered_count: 1 }] },
        });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const res = await dispatchService.dispatchOrder('ord-co-gift-1');
    assert.equal(res.status, 'completed');
    assert.equal(postBody.items[0].target_payload, undefined, 'Gift card: sin target_payload');
    const saved = store.get('orders/ord-co-gift-1');
    assert.deepEqual(saved.deliveredCodes, ['GPLAY-SECRET-1234']);
    // Los códigos por llamada viven fuera del doc que lee el cliente.
    assert.equal(saved.dispatch.calls[0].deliveredCodes, undefined);
    assert.deepEqual(store.get('orders/ord-co-gift-1/private/delivery').callCodes, { 0: ['GPLAY-SECRET-1234'] });
    assert.ok(
      !JSON.stringify(saved.dispatch.calls[0].providerResponse ?? {}).includes('GPLAY-SECRET-1234'),
      'El código nunca va en providerResponse'
    );
  });

  await t.test('11. Gift card entregada sin permiso codes:read: sigue en curso, nunca completa', async () => {
    seedCoOrder('ord-co-gift-2', { code: 'RF-GFT002', providerFamily: 'gift_card' }, { targetFields: [] });

    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        return jsonResponse(201, { order: { id: 'co-gift-2', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-gift-2/codes')) {
        return jsonResponse(403, { error: { code: 'insufficient_scope' } });
      }
      if (u.endsWith('/orders/co-gift-2')) {
        return jsonResponse(200, {
          order: { id: 'co-gift-2', status: 'completed', items: [{ status: 'completed', delivered_count: 1 }] },
        });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const res = await dispatchService.dispatchOrder('ord-co-gift-2');
    assert.equal(res.status, 'dispatching');
    let saved = store.get('orders/ord-co-gift-2');
    assert.equal(saved.dispatch.calls[0].status, 'processing');
    assert.equal(saved.dispatch.calls[0].errorCode, 'codes_pending');
    assert.match(saved.dispatch.calls[0].pendingReason, /codes:read/);

    // El cron tampoco la completa mientras no haya códigos, ni compra otra.
    await dispatchService.resolveProcessingOrders();
    saved = store.get('orders/ord-co-gift-2');
    assert.equal(saved.status, 'dispatching');
    assert.equal(saved.dispatch.calls[0].status, 'processing');
  });

  await t.test('12. insufficient_balance: pausa con alerta crítica, misma llave y sin reembolso', async () => {
    seedCoOrder('ord-co-bal-1', { code: 'RF-BAL001' });

    const keys = [];
    let balance = 'empty';
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        keys.push(options.headers['Idempotency-Key']);
        if (balance === 'empty') {
          return jsonResponse(409, { error: { code: 'insufficient_balance', message: 'Insufficient balance' } });
        }
        return jsonResponse(201, { order: { id: 'co-bal-1', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-bal-1')) {
        return jsonResponse(200, { order: { id: 'co-bal-1', status: 'completed', items: [{ status: 'completed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const res = await dispatchService.dispatchOrder('ord-co-bal-1');
    assert.equal(res.status, 'dispatching', 'Sin saldo no pasa a revisión (que llevaría al reembolso)');
    let saved = store.get('orders/ord-co-bal-1');
    assert.equal(saved.dispatch.calls[0].status, 'processing');
    assert.equal(saved.dispatch.calls[0].errorCode, 'insufficient_balance');
    assert.equal(saved.dispatch.calls[0].providerOrderId, null);
    const critical = alertsStored().filter((a) => /Saldo insuficiente en Central One/.test(a.title));
    assert.equal(critical.length, 1);
    assert.equal(critical[0].severity, 'critical');

    assert.equal(await ordersService.refundStaleReviewOrders(10), 0);
    assert.equal(store.get('orders/ord-co-bal-1').status, 'dispatching');

    // Siguiente pasada: sigue sin saldo → misma llave y sin repetir el aviso.
    await dispatchService.resolveProcessingOrders();
    saved = store.get('orders/ord-co-bal-1');
    assert.equal(saved.status, 'dispatching');
    assert.equal(alertsStored().filter((a) => /Saldo insuficiente en Central One/.test(a.title)).length, 1);

    // Recargaron saldo: se compra con la MISMA llave.
    balance = 'ok';
    await dispatchService.resolveProcessingOrders();
    saved = store.get('orders/ord-co-bal-1');
    assert.equal(saved.status, 'completed');
    assert.ok(keys.every((key) => key === 'RF-BAL001-1'), `Llaves: ${keys.join(',')}`);
  });

  await t.test('13. Sin llave (missing_config) la consulta es incierta, nunca not_found: no reembolsa', async () => {
    seedCoOrder(
      'ord-co-nokey-1',
      { code: 'RF-NOK001', status: 'in_review', reviewDeadline: Timestamp.fromMillis(Date.now() - 1000) },
      { status: 'error', attempts: 1, providerOrderId: 'co-nokey-1', error: 'El proveedor no resolvió' }
    );

    global.fetch = async (url, options = {}) => {
      throw new Error(`Sin llave no debe salir ninguna petición: ${options.method} ${url}`);
    };

    const savedKey = process.env.CENTRAL_ONE_API_KEY;
    delete process.env.CENTRAL_ONE_API_KEY;
    try {
      const check = await dispatchService.checkOrderProviderStatus('ord-co-nokey-1', 'system');
      assert.equal(check.calls[0].status, 'unknown');
      assert.equal(await ordersService.refundStaleReviewOrders(10), 0);
    } finally {
      process.env.CENTRAL_ONE_API_KEY = savedKey;
    }
    const saved = store.get('orders/ord-co-nokey-1');
    assert.equal(saved.status, 'in_review');
    assert.ok(!saved.refundedAt);
  });

  await t.test('14. Webhook: resuelve por índice providerOrders y por llave (adoptando el id), siempre releyendo GET', async () => {
    const { createHash } = require('node:crypto');
    const indexId = (id) => createHash('sha256').update(`centralone:${id}`).digest('hex');

    // a) Por índice.
    seedCoOrder(
      'ord-co-wh-1',
      { code: 'RF-WHK001', status: 'dispatching', dispatch: { startedAt: Timestamp.now() } },
      { status: 'processing', attempts: 1, providerOrderId: 'co-wh-1', idempotencyKey: 'RF-WHK001-1' }
    );
    store.set(`providerOrders/${indexId('co-wh-1')}`, {
      provider: 'centralone',
      providerOrderId: 'co-wh-1',
      orderId: 'ord-co-wh-1',
      callIndex: 0,
    });

    // b) Por llave: el POST fue ambiguo y no hay id ni índice.
    seedCoOrder(
      'ord-co-wh-2',
      { code: 'RF-WHK002', status: 'dispatching', dispatch: { startedAt: Timestamp.now() } },
      { status: 'processing', attempts: 1, idempotencyKey: 'RF-WHK002-1', keyAttempts: 1, errorCode: 'ambiguous' }
    );

    const gets = [];
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST') throw new Error('El webhook nunca compra');
      const match = /\/orders\/([^/]+)$/.exec(u);
      if (match) {
        gets.push(match[1]);
        return jsonResponse(200, { order: { id: match[1], status: 'completed', items: [{ status: 'completed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const a = await dispatchService.resolveCentralOneWebhookOrder({ providerOrderId: 'co-wh-1' });
    assert.deepEqual(a, { matched: true, orderId: 'ord-co-wh-1', result: 'resuelta' });
    assert.equal(store.get('orders/ord-co-wh-1').status, 'completed');

    const b = await dispatchService.resolveCentralOneWebhookOrder({
      providerOrderId: 'co-wh-2',
      idempotencyKey: 'RF-WHK002-1',
    });
    assert.deepEqual(b, { matched: true, orderId: 'ord-co-wh-2', result: 'resuelta' });
    const saved = store.get('orders/ord-co-wh-2');
    assert.equal(saved.status, 'completed');
    assert.equal(saved.dispatch.calls[0].providerOrderId, 'co-wh-2');
    assert.ok(store.has(`providerOrders/${indexId('co-wh-2')}`), 'Se indexa el id adoptado');
    assert.deepEqual(gets, ['co-wh-1', 'co-wh-2'], 'El estado sale de GET /orders/{id}');

    // c) Ni índice ni código reconocible.
    const c = await dispatchService.resolveCentralOneWebhookOrder({
      providerOrderId: 'desconocido',
      idempotencyKey: 'otra-cosa',
    });
    assert.equal(c.matched, false);
  });

  await t.test('15. Rotar la llave recuerda el pedido anterior; su entrega tardía se avisa (doble cobro)', async () => {
    const { createHash } = require('node:crypto');
    const indexId = (id) => createHash('sha256').update(`centralone:${id}`).digest('hex');
    seedCoOrder('ord-co-late-1', { code: 'RF-LAT001', status: 'in_review' }, {
      status: 'error',
      attempts: 1,
      providerOrderId: 'co-late-x',
      providerStatus: 'failed',
      idempotencyKey: 'RF-LAT001-1',
      keyAttempts: 1,
      error: 'Falló',
    });
    store.set(`providerOrders/${indexId('co-late-x')}`, {
      provider: 'centralone', providerOrderId: 'co-late-x', orderId: 'ord-co-late-1', callIndex: 0,
    });

    let xStatus = 'failed';
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        return jsonResponse(201, { order: { id: 'co-late-y', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-late-x')) {
        return jsonResponse(200, { order: { id: 'co-late-x', status: xStatus, items: [{ status: xStatus }] } });
      }
      if (u.endsWith('/orders/co-late-y')) {
        return jsonResponse(200, { order: { id: 'co-late-y', status: 'completed', items: [{ status: 'completed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };

    const res = await dispatchService.dispatchOrder('ord-co-late-1', { isRetry: true });
    assert.equal(res.status, 'completed');
    let saved = store.get('orders/ord-co-late-1');
    assert.equal(saved.dispatch.calls[0].providerOrderId, 'co-late-y');
    assert.deepEqual(saved.dispatch.calls[0].previousProviderOrderIds, ['co-late-x']);

    // Central One entrega tarde el pedido «fallido»: la orden ya se completó
    // con el otro. Se avisa (una vez), sin tocar la orden.
    xStatus = 'completed';
    const result = await dispatchService.resolveCentralOneWebhookOrder({
      providerOrderId: 'co-late-x',
      idempotencyKey: 'RF-LAT001-1',
    });
    assert.equal(result.result, 'entrega tardía avisada');
    const late = alertsStored().filter((a) => /Central One cobró dos veces/.test(a.title));
    assert.equal(late.length, 1);
    assert.equal(late[0].severity, 'critical');
    await dispatchService.resolveCentralOneWebhookOrder({ providerOrderId: 'co-late-x', idempotencyKey: 'RF-LAT001-1' });
    assert.equal(alertsStored().filter((a) => /Central One cobró dos veces/.test(a.title)).length, 1, 'un aviso por pedido');
    saved = store.get('orders/ord-co-late-1');
    assert.equal(saved.status, 'completed');

    // El aviso del pedido vigente de una orden completada no es una alarma.
    const normal = await dispatchService.resolveCentralOneWebhookOrder({ providerOrderId: 'co-late-y' });
    assert.equal(normal.result, 'la orden está en completed');
  });

  await t.test('16. Revisión vencida: un pedido de una llave anterior entregado bloquea el reembolso', async () => {
    seedCoOrder(
      'ord-co-late-2',
      { code: 'RF-LAT002', status: 'in_review', reviewDeadline: Timestamp.fromMillis(Date.now() - 1000) },
      {
        status: 'error',
        attempts: 2,
        providerOrderId: null,
        idempotencyKey: 'RF-LAT002-1-r2',
        keyAttempts: 1,
        keyClosed: true,
        errorCode: 'out_of_stock',
        error: 'Sin stock',
        previousProviderOrderIds: ['co-late-old'],
      }
    );
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith('/orders/co-late-old')) {
        return jsonResponse(200, { order: { id: 'co-late-old', status: 'completed', items: [{ status: 'completed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };
    const check = await dispatchService.checkOrderProviderStatus('ord-co-late-2', 'system');
    assert.equal(check.calls[0].status, 'unknown', 'no es not_found: un pedido anterior se entregó');
    assert.equal(await ordersService.refundStaleReviewOrders(10), 0);
    const saved = store.get('orders/ord-co-late-2');
    assert.equal(saved.status, 'in_review');
    assert.ok(!saved.refundedAt);
    assert.ok(alertsStored().some((a) => /Entrega tardía de Central One/.test(a.title)));
  });

  await t.test('17. Reintento con llave nueva: si la llamada cambió mientras se consultaba, no compra', async () => {
    seedCoOrder('ord-co-race-1', { code: 'RF-RAC001', status: 'in_review' }, {
      status: 'error',
      attempts: 1,
      providerOrderId: 'co-race-old',
      providerStatus: 'failed',
      idempotencyKey: 'RF-RAC001-1',
      keyAttempts: 1,
      error: 'Falló',
    });
    let posts = 0;
    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (options.method === 'POST' && u.endsWith('/orders')) {
        posts += 1;
        return jsonResponse(201, { order: { id: 'co-race-dup', status: 'confirmed' } });
      }
      if (u.endsWith('/orders/co-race-old')) {
        // Mientras se consulta, otra petición (otro reintento) ya compró.
        const current = store.get('orders/ord-co-race-1');
        current.dispatch.calls[0] = {
          ...current.dispatch.calls[0],
          status: 'processing',
          attempts: 2,
          providerOrderId: 'co-race-new',
          idempotencyKey: 'RF-RAC001-1-r2',
        };
        store.set('orders/ord-co-race-1', current);
        return jsonResponse(200, { order: { id: 'co-race-old', status: 'failed', items: [{ status: 'failed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };
    await dispatchService.dispatchOrder('ord-co-race-1', { isRetry: true });
    assert.equal(posts, 0, 'no se compra sobre una copia vieja');
    const saved = store.get('orders/ord-co-race-1');
    assert.equal(saved.dispatch.calls[0].providerOrderId, 'co-race-new', 'gana lo guardado');
    assert.equal(saved.dispatch.calls[0].idempotencyKey, 'RF-RAC001-1-r2');
    assert.equal(saved.status, 'dispatching');
  });

  await t.test('18. mergeDispatchCalls: una escritura vieja no pisa una llamada que otro cambió', () => {
    const read = [
      { index: 0, status: 'processing', attempts: 1, providerOrderId: null, idempotencyKey: 'K-1' },
      { index: 1, status: 'error', attempts: 1, providerOrderId: null, idempotencyKey: 'K-2', keyClosed: true },
    ];
    const stored = [
      read[0],
      { index: 1, status: 'processing', attempts: 2, providerOrderId: 'Y', idempotencyKey: 'K-2-r2', keyClosed: false },
    ];
    const next = [
      { ...read[0], status: 'success', providerOrderId: 'X' },
      { ...read[1], providerOrderId: 'Z' },
    ];
    const merged = dispatchService.mergeDispatchCalls(read, stored, next);
    assert.deepEqual(merged.kept, [1]);
    assert.equal(merged.calls[0].status, 'success', 'la llamada que nadie más tocó se escribe');
    assert.equal(merged.calls[1].providerOrderId, 'Y', 'la que cambió otro se conserva');
    assert.deepEqual(merged.calls[1].previousProviderOrderIds, ['Z'], 'sin perder el id de la versión descartada');
  });

  await t.test('19. Gift card a medias: el cliente no ve el código de la unidad entregada (ni por la API)', async () => {
    seedCoOrder(
      'ord-co-gift-3',
      {
        code: 'RF-GFT003',
        providerFamily: 'gift_card',
        playerId: '',
        status: 'dispatching',
        dispatch: { startedAt: Timestamp.now() },
      },
      { status: 'processing', attempts: 1, providerOrderId: 'co-gift-3a', idempotencyKey: 'RF-GFT003-1', targetFields: [] }
    );
    const saved0 = store.get('orders/ord-co-gift-3');
    saved0.dispatch.calls.push({
      ...saved0.dispatch.calls[0],
      index: 1,
      status: 'processing',
      providerOrderId: 'co-gift-3b',
      idempotencyKey: 'RF-GFT003-2',
    });
    store.set('orders/ord-co-gift-3', saved0);

    global.fetch = async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith('/orders/co-gift-3a/codes')) {
        return jsonResponse(200, { order: { items: [{ status: 'completed', codes: ['GIFT-UNO-0001'] }] } });
      }
      if (u.endsWith('/orders/co-gift-3a')) {
        return jsonResponse(200, { order: { id: 'co-gift-3a', status: 'completed', items: [{ status: 'completed', delivered_count: 1 }] } });
      }
      if (u.endsWith('/orders/co-gift-3b')) {
        return jsonResponse(200, { order: { id: 'co-gift-3b', status: 'failed', items: [{ status: 'failed' }] } });
      }
      throw new Error(`Unexpected fetch: ${options.method} ${u}`);
    };
    await dispatchService.resolveProcessingOrders();
    const saved = store.get('orders/ord-co-gift-3');
    assert.equal(saved.status, 'in_review');
    assert.equal(saved.dispatch.calls[0].status, 'success');
    assert.ok(!JSON.stringify(saved).includes('GIFT-UNO-0001'), 'el doc que lee el cliente no tiene el código');
    assert.deepEqual(store.get('orders/ord-co-gift-3/private/delivery').callCodes, { 0: ['GIFT-UNO-0001'] });

    const legacy = ordersService.toCustomerOrder({
      ...saved,
      id: 'ord-co-gift-3',
      pricing: { totalUsd: 1, costUsd: 0.5, profitUsd: 0.5 },
      dispatch: { ...saved.dispatch, calls: [{ ...saved.dispatch.calls[0], deliveredCodes: ['VIEJO-123'] }] },
    });
    assert.ok(!JSON.stringify(legacy).includes('VIEJO-123'), 'la API tampoco expone códigos por llamada');
  });
});
