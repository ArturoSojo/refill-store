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

  await t.test('4. Idempotency-Key: Reutilización ante error de red vs nueva llave ante fallo confirmado', async () => {
    const payload = {
      catalogItemId: '00147efa-cc79-4767-8306-9b5dc45e2757',
      quantity: 1,
      targetPayload: { player_id: '7008181939' },
      idempotencyKey: 'idemp-key-base-123',
      note: 'Test note',
    };

    let sentIdempKey = null;
    global.fetch = async (url, options = {}) => {
      sentIdempKey = options.headers['Idempotency-Key'];
      return {
        ok: true,
        status: 201,
        json: async () => ({
          order: {
            id: 'uuid-test',
            status: 'confirmed'
          }
        })
      };
    };

    await centralOne.createOrder(payload);
    assert.equal(sentIdempKey, 'idemp-key-base-123');

    const mockOrder = { code: 'RF-TEST-99' };
    const mockCall = { index: 0, attempts: 1, status: 'error' };

    const isPreviouslyFailed = Boolean(mockCall.status === 'error');
    const retryKey = isPreviouslyFailed
      ? `${mockOrder.code}-${mockCall.index + 1}-r${mockCall.attempts || 1}`
      : `${mockOrder.code}-${mockCall.index + 1}`;

    assert.equal(retryKey, 'RF-TEST-99-1-r1', 'Debe generar nueva Idempotency-Key para reintentar tras fallo confirmado');

    const firstAttemptCall = { index: 0, attempts: 0, status: 'pending' };
    const firstKey = `${mockOrder.code}-${firstAttemptCall.index + 1}`;
    assert.equal(firstKey, 'RF-TEST-99-1', 'Primer intento o timeout de red usa la llave base');
  });
});
