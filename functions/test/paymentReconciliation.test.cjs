const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock
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
  if (!store.has(docPath)) {
    return {
      id,
      exists: false,
      data: () => undefined,
      get: () => undefined,
    };
  }
  const raw = store.get(docPath);
  return {
    id,
    exists: true,
    data: () => clone(raw),
    get: (f) => getByPath(raw, f),
  };
}

function makeDocRef(docPath) {
  return {
    id: docPath.split('/').pop(),
    path: docPath,
    firestore: mockDb,
    get: async () => makeSnap(docPath),
    set: async (data, options) => {
      const existing = store.get(docPath);
      if (options && options.merge) {
        store.set(docPath, deepMerge(existing || {}, data));
      } else {
        store.set(docPath, clone(data));
      }
    },
    update: async (data) => {
      const existing = store.get(docPath);
      if (!existing) throw new Error(`Document does not exist: ${docPath}`);
      store.set(docPath, deepMerge(existing, data));
    },
    delete: async () => {
      store.delete(docPath);
    },
    collection: (subCol) => makeCollectionRef(`${docPath}/${subCol}`),
  };
}

function makeQuery(colPath, filters = [], limitCount = null) {
  return {
    where: (field, op, value) => makeQuery(colPath, [...filters, { field, op, value }], limitCount),
    limit: (n) => makeQuery(colPath, filters, n),
    orderBy: () => makeQuery(colPath, filters, limitCount),
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
          return false;
        });
        if (matches) {
          docs.push({
            id: rest,
            exists: true,
            data: () => clone(v),
            get: (f) => getByPath(v, f),
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
  runTransaction: (fn) => {
    const run = txChain.then(async () => {
      let hasWritten = false;
      const stagedWrites = [];
      const tx = {
        get: async (ref) => {
          if (hasWritten) {
            throw new Error('Firestore transactions require all reads before writes.');
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

// Stub firebase
const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    auth: {},
    COLLECTIONS: {
      orders: 'orders',
      users: 'users',
      config: 'config',
      paymentRefs: 'paymentRefs',
      auditLogs: 'auditLogs',
      adminAlerts: 'adminAlerts',
      stats: 'stats',
    },
    CONFIG_DOC_ID: 'app',
    orders: () => mockDb.collection('orders'),
    users: () => mockDb.collection('users'),
    paymentRefs: () => mockDb.collection('paymentRefs'),
    configDoc: () => mockDb.collection('config').doc('app'),
    auditLogs: () => mockDb.collection('auditLogs'),
    adminAlerts: () => mockDb.collection('adminAlerts'),
    now: () => Timestamp.now(),
    minutesFromNow: (m) => Timestamp.fromMillis(Date.now() + m * 60_000),
    Timestamp,
  },
};

const stubModule = (relPath, exportsObj) => {
  const full = path.resolve(__dirname, relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
};

let mockPabiloResult = null;
let pabiloShouldThrow = null;

stubModule('../lib/services/pabilo.js', {
  verifyPayment: async (input) => {
    if (pabiloShouldThrow) {
      throw pabiloShouldThrow;
    }
    return mockPabiloResult;
  },
});

stubModule('../lib/services/catalog.js', {
  decrementStock: async () => {},
});

stubModule('../lib/services/coupons.js', {
  consume: async () => {},
});

stubModule('../lib/services/audit.js', {
  record: async () => {},
  ACTIONS: {
    ORDER_PAYMENT_VERIFIED: 'order.payment_verified',
    ORDER_PAYMENT_REJECTED: 'order.payment_rejected',
  },
});

stubModule('../lib/services/notifications.js', {
  notify: async () => {},
});

stubModule('../lib/services/adminAlerts.js', {
  alert: async () => {},
});

stubModule('../lib/services/stats.js', {
  trackEvent: async () => {},
});

let dispatchCalledWith = null;
stubModule('../lib/services/dispatch.js', {
  dispatchOrder: async (orderId) => {
    dispatchCalledWith = orderId;
  },
  prepareManualOrder: async () => {},
});

stubModule('../lib/services/orderEmails.js', {
  sendOrderEmail: async () => {},
});

stubModule('../lib/services/settings.js', {
  getConfig: async () => ({
    checkout: {
      maxVerifyAttempts: 5,
      referenceMinLength: 4,
      referenceMaxLength: 20,
      orderExpiryMinutes: 30,
      amountTolerancePercent: 1.0,
    },
  }),
});

const ordersService = require('../lib/services/orders.js');

test('Conciliación automática e idempotente de pagos cuando Pabilo devuelve is_new: false en un reintento legítimo', async () => {
  store.clear();
  dispatchCalledWith = null;
  pabiloShouldThrow = null;

  const orderId = 'ord-test-reconcile-1';
  const reference = '630231009528';
  const uid = 'user-gotopo';
  const expiresAt = Timestamp.fromMillis(Date.now() + 20 * 60_000);

  const initialOrder = {
    id: orderId,
    code: 'RF-RECON01',
    uid,
    status: 'awaiting_payment',
    expiresAt,
    gameId: 'free-fire',
    gameName: 'Free Fire',
    productId: 'prod-diamantes',
    productName: '100 Diamantes',
    fulfillment: 'auto',
    user: { email: 'gotopo@example.com' },
    pricing: {
      totalBs: 2545.0,
      totalUsd: 2.86,
      rate: 890.0,
      costUsd: 2.5,
      profitUsd: 0.36,
      quantity: 1,
    },
    payment: {
      method: 'pagomovil_bdv',
      reference: null,
      paidBs: 0,
      attempts: 0,
    },
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };

  store.set(`orders/${orderId}`, initialOrder);

  // 1. Simulación del Intento 1: Timeout de red con Pabilo
  pabiloShouldThrow = new Error('No pudimos comunicarnos con el verificador de pagos. Timeout.');

  await assert.rejects(
    async () => {
      await ordersService.verifyPayment({ uid, email: 'gotopo@example.com' }, orderId, reference, '127.0.0.1');
    },
    /No pudimos comunicarnos con el verificador/
  );

  // Verificamos que la orden quedó en awaiting_payment, guardó el intento y liberó el candado local
  const afterAttempt1 = store.get(`orders/${orderId}`);
  assert.equal(afterAttempt1.status, 'awaiting_payment');
  assert.equal(afterAttempt1.payment.lastAttemptedReference, reference);
  assert.equal(store.has(`paymentRefs/${reference}`), false);

  // 2. Simulación del Intento 2: El cliente pulsa Reintentar a los minutos
  // Pabilo ya tiene el pago registrado del intento previo y responde is_new: false, pero found: true y monto exacto
  pabiloShouldThrow = null;
  mockPabiloResult = {
    isNew: false, // Pabilo dice duplicado porque ya lo procesó a las 13:28
    found: true,
    reportedAmount: 2545.0,
    amountVerifiedByProvider: true,
    reportedDate: '2026-10-29',
    message: 'Pago móvil duplicado verificado',
    raw: { is_new: false, amount: 2545.0 },
    httpStatus: 200,
  };

  const result = await ordersService.verifyPayment(
    { uid, email: 'gotopo@example.com' },
    orderId,
    reference,
    '127.0.0.1'
  );

  // ¡La orden se aprueba por conciliación automática!
  assert.equal(result.verified, true);

  const finalOrder = store.get(`orders/${orderId}`);
  assert.equal(finalOrder.status, 'paid');
  assert.equal(finalOrder.referencia, reference);
  assert.equal(dispatchCalledWith, orderId, 'El despacho automático debe haberse disparado');

  // El candado definitivo debe existir para que nadie más lo use
  assert.equal(store.has(`paymentRefs/${reference}`), true);
});

test('Rechazo estricto si una referencia con is_new: false ya pertenece a OTRA orden pagada (prevención de fraude)', async () => {
  store.clear();
  dispatchCalledWith = null;

  const legitimateOrderId = 'ord-already-paid';
  const hackerOrderId = 'ord-hacker-attempt';
  const reference = '999988887777';

  // Orden legítima completada en el pasado
  store.set(`orders/${legitimateOrderId}`, {
    id: legitimateOrderId,
    code: 'RF-LEGIT01',
    status: 'completed',
    referencia: reference,
    payment: { reference },
  });

  // Orden del atacante
  store.set(`orders/${hackerOrderId}`, {
    id: hackerOrderId,
    code: 'RF-HACK01',
    uid: 'user-hacker',
    status: 'awaiting_payment',
    expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
    gameId: 'free-fire',
    fulfillment: 'auto',
    user: { email: 'hacker@example.com' },
    pricing: { totalBs: 1000.0, totalUsd: 1.0, rate: 890.0, quantity: 1 },
    payment: { method: 'pagomovil_bdv', reference: null, paidBs: 0, attempts: 0 },
  });

  mockPabiloResult = {
    isNew: false, // Pago viejo ya usado
    found: true,
    reportedAmount: 1000.0,
    amountVerifiedByProvider: true,
    reportedDate: '2026-10-25',
    message: 'Esa referencia ya fue utilizada',
    raw: { is_new: false },
    httpStatus: 200,
  };

  await assert.rejects(
    async () => {
      await ordersService.verifyPayment(
        { uid: 'user-hacker', email: 'hacker@example.com' },
        hackerOrderId,
        reference,
        '127.0.0.1'
      );
    },
    /Esa referencia ya fue utilizada en la orden RF-LEGIT01/
  );

  const hackerOrder = store.get(`orders/${hackerOrderId}`);
  assert.equal(hackerOrder.status, 'payment_rejected');
  assert.equal(dispatchCalledWith, null, 'No debe despachar');
});
