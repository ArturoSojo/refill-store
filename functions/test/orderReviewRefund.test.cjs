const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock with real transaction serialization & read-before-write enforcement
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
  const exists = store.has(docPath);
  const raw = exists ? clone(store.get(docPath)) : undefined;
  return {
    id,
    exists,
    data: () => (exists ? clone(raw) : undefined),
    get: (field) => (exists ? getByPath(raw, field) : undefined),
  };
}

function makeDocRef(docPath) {
  const id = docPath.split('/').pop();
  return {
    id,
    path: docPath,
    firestore: mockDb,
    collection: (subName) => makeCollectionRef(`${docPath}/${subName}`),
    get: async () => makeSnap(docPath),
    set: async (data, options) => {
      if (options && options.merge) {
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
    select: () => makeQuery(colPath, filters, limitCount),
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

// ---------------------------------------------------------------------------
// Stub firebase.js and external side-effect modules in require.cache
// ---------------------------------------------------------------------------
const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    auth: {},
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
    configDoc: () => mockDb.collection('config').doc('app'),
    privateChatbotConfigDoc: () => mockDb.collection('privateConfig').doc('chatbot'),
    dailyStats: () => mockDb.collection('stats').doc('daily').collection('days'),
    now: () => Timestamp.now(),
    timestampFromDate: (d) => Timestamp.fromDate(d),
    minutesFromNow: (m) => Timestamp.fromMillis(Date.now() + m * 60_000),
    Timestamp,
  },
};

// Stubs for external services (email, notifications, adminAlerts, stats, audit, settings, inefable)
const stubModule = (relPath, exportsObj) => {
  const full = path.resolve(__dirname, relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
};

let inefableCreateHandler = async () => ({
  success: false,
  processing: false,
  httpStatus: 422,
  providerOrderId: null,
  providerStatus: 'error',
  playerName: null,
  providerReference: null,
  remainingBalance: 100,
  message: '{"error":"Invalid player_id","details":{"raw":true}}',
  raw: { error: 'Invalid player_id', details: { raw: true } },
});

let inefableStatusHandler = async () => ({
  found: true,
  status: 'completed',
  providerOrderId: 'prov-999',
  providerReference: 'ref-999',
  error: null,
});

stubModule('../lib/services/inefable.js', {
  createOrder: (...args) => inefableCreateHandler(...args),
  getOrderStatus: (...args) => inefableStatusHandler(...args),
  isSuccessStatus: (s) => s === 'completed' || s === 'success',
  isFailureStatus: (s) => s === 'failed' || s === 'error',
});

stubModule('../lib/services/orderEmails.js', {
  sendOrderEmail: async () => {},
});

stubModule('../lib/services/notifications.js', {
  notify: async () => {},
});

stubModule('../lib/services/adminAlerts.js', {
  alert: async () => {},
  checkProviderBalance: async () => {},
});

stubModule('../lib/services/stats.js', {
  trackEvent: async () => {},
  STORE_TIMEZONE: 'America/Caracas',
});

stubModule('../lib/services/audit.js', {
  ACTIONS: {
    ORDER_DISPATCHED: 'order.dispatched',
    ORDER_DISPATCH_FAILED: 'order.dispatch.failed',
    ORDER_COMPLETED_MANUALLY: 'order.completed.manual',
    ORDER_REFUNDED: 'order.refunded',
    ORDER_RETRIED: 'order.retried',
  },
  record: async () => {},
});

stubModule('../lib/services/creators.js', {
  accrueCommission: async () => {},
  revertCommission: async () => {},
});

stubModule('../lib/services/settings.js', {
  getConfig: async () => ({
    features: {
      autoDispatchEnabled: true,
      manualProductsEnabled: true,
      couponsEnabled: true,
      creatorsEnabled: true,
      maintenanceMode: false,
    },
    whatsapp: { adminNumber: '584120000000', supportNumber: '584120000000' },
  }),
});

const logger = require('../lib/lib/logger.js');
const dispatchService = require('../lib/services/dispatch.js');
const ordersService = require('../lib/services/orders.js');

const ADMIN_ACTOR = {
  uid: 'admin-1',
  email: 'admin@refill.store',
  displayName: 'Admin',
  photoURL: null,
  role: 'admin',
  isAdmin: true,
  isStaff: true,
};

async function seedUserAndOrder({
  orderId = 'order-1',
  code = 'RF-TEST01',
  uid = 'user-1',
  initialWalletUsd = 0,
  totalUsd = 5,
  walletAppliedUsd = 5,
  status = 'paid',
  walletRefunded = false,
  reviewDeadline = null,
} = {}) {
  await mockDb.collection('users').doc(uid).set({
    email: 'cliente@test.com',
    displayName: 'Cliente',
    walletBalanceUsd: initialWalletUsd,
    stats: { ordersCount: 1, completedOrders: 0, totalSpentUsd: 0 },
  });

  const ts = Timestamp.now();
  await mockDb.collection('orders').doc(orderId).set({
    code,
    uid,
    user: { email: 'cliente@test.com', displayName: 'Cliente', photoURL: null },
    gameId: 'freefire',
    gameName: 'Free Fire',
    providerGameId: 1,
    provider: 'inefable',
    providerFamily: 'topup',
    productId: 'ff-100',
    productName: '100 Diamantes',
    productSku: 'ff-100',
    productAmount: 100,
    productBonus: 10,
    fulfillment: 'auto',
    playerId: '123456789',
    playerId2: null,
    playerFields: { playerId: '123456789' },
    pricing: {
      unitUsd: totalUsd,
      quantity: 1,
      subtotalUsd: totalUsd,
      discountUsd: 0,
      totalUsd,
      walletAppliedUsd,
      amountDueUsd: Math.max(0, totalUsd - walletAppliedUsd),
      rate: 100,
      totalBs: Math.max(0, totalUsd - walletAppliedUsd) * 100,
      couponCode: null,
      creatorCode: null,
      costUsd: 4,
      profitUsd: 1,
      ...(walletRefunded ? { walletRefunded: true } : {}),
    },
    payment: {
      method: walletAppliedUsd >= totalUsd ? 'wallet' : 'pagomovil_bdv',
      reference: '12345678',
      reportedAmountBs: totalUsd * 100,
      partials: [],
      paidBs: 0,
      verifiedAt: ts,
      attempts: 1,
      providerResponse: null,
      bankSnapshot: { code: '0102', name: 'BDV', idNumber: 'V123', phone: '04120000000' },
    },
    dispatch: {
      calls: [
        {
          packageId: 10,
          providerGameId: 1,
          index: 0,
          status: 'pending',
          providerOrderId: null,
          providerStatus: null,
          playerName: null,
          providerReference: null,
          error: null,
          httpStatus: null,
          providerResponse: null,
          attempts: 0,
          completedAt: null,
        },
      ],
      startedAt: null,
      completedAt: null,
      lastError: null,
    },
    status,
    reviewDeadline,
    providerError: null,
    refundedAt: null,
    refundReason: null,
    createdAt: ts,
    updatedAt: ts,
    expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60_000),
  });
}

async function getWalletMovements(uid) {
  const snap = await mockDb.collection('users').doc(uid).collection('wallet').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getUserBalance(uid) {
  const snap = await mockDb.collection('users').doc(uid).get();
  return snap.data().walletBalanceUsd;
}

test('a) Proveedor falla: saldo del cliente sin cambios, estado in_review, reviewDeadline (~1h) y providerError limpio (sin JSON crudo)', async () => {
  store.clear();
  await seedUserAndOrder({
    orderId: 'ord-a',
    code: 'RF-AAAA01',
    uid: 'user-a',
    initialWalletUsd: 2.5,
    totalUsd: 5,
    walletAppliedUsd: 5,
    status: 'paid',
  });

  const beforeMs = Date.now();
  const outcome = await dispatchService.dispatchOrder('ord-a');
  assert.equal(outcome.status, 'in_review');

  const order = await ordersService.getOrder('ord-a');
  assert.equal(order.status, 'in_review');
  assert.equal(await getUserBalance('user-a'), 2.5);
  assert.equal((await getWalletMovements('user-a')).length, 0);

  // reviewDeadline ~ ahora + 1 hora
  const deadlineMs = order.reviewDeadline.toMillis();
  assert.ok(
    deadlineMs >= beforeMs + 59 * 60_000 && deadlineMs <= Date.now() + 61 * 60_000,
    `reviewDeadline fuera del rango de 1h: ${deadlineMs}`
  );

  // providerError debe ser texto corto, sin llaves JSON
  assert.equal(typeof order.providerError, 'string');
  assert.ok(order.providerError.length > 0 && order.providerError.length <= 160);
  assert.ok(!/[{}\[\]]/.test(order.providerError), `providerError contiene JSON: ${order.providerError}`);
});

test('b) Admin completa desde in_review: pasa a completed y no genera movimientos de saldo', async () => {
  store.clear();
  await seedUserAndOrder({
    orderId: 'ord-b',
    code: 'RF-BBBB02',
    uid: 'user-b',
    initialWalletUsd: 1.0,
    totalUsd: 5,
    status: 'in_review',
    reviewDeadline: Timestamp.fromMillis(Date.now() + 60 * 60_000),
  });

  const completed = await ordersService.markCompleted(ADMIN_ACTOR, 'ord-b', 'Entregado manualmente');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.reviewDeadline, null);
  assert.equal(await getUserBalance('user-b'), 1.0);
  assert.equal((await getWalletMovements('user-b')).length, 0);

  // Intentar reembolsar una orden ya completada queda bloqueado (no hace nada)
  const afterRefundAttempt = await ordersService.refundOrder('ord-b', 'Intento sobre completada', {
    actor: ADMIN_ACTOR,
  });
  assert.equal(afterRefundAttempt.status, 'completed');
  assert.equal(await getUserBalance('user-b'), 1.0);
  assert.equal((await getWalletMovements('user-b')).length, 0);
});

test('c) Admin pulsa Reembolsar dos veces (o doble clic): pasa a cancelled y crea un solo movimiento refund_${orderId}', async () => {
  store.clear();
  await seedUserAndOrder({
    orderId: 'ord-c',
    code: 'RF-CCCC03',
    uid: 'user-c',
    initialWalletUsd: 0,
    totalUsd: 7.5,
    status: 'in_review',
    reviewDeadline: Timestamp.fromMillis(Date.now() + 60 * 60_000),
  });

  const [first, second] = await Promise.all([
    ordersService.refundOrder('ord-c', 'Reembolso admin 1', { actor: ADMIN_ACTOR }),
    ordersService.refundOrder('ord-c', 'Reembolso admin 2', { actor: ADMIN_ACTOR }),
  ]);

  assert.equal(first.status, 'cancelled');
  assert.equal(second.status, 'cancelled');
  assert.equal(await getUserBalance('user-c'), 7.5);

  const movements = await getWalletMovements('user-c');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].id, 'refund_ord-c');
  assert.equal(movements[0].amountUsd, 7.5);
  assert.equal(movements[0].reason, 'Reembolso de la orden RF-CCCC03');
});

test('d) Pasan 61 minutos sin acción: el barrido programado cancela y acredita un solo reembolso', async () => {
  store.clear();
  await seedUserAndOrder({
    orderId: 'ord-d',
    code: 'RF-DDDD04',
    uid: 'user-d',
    initialWalletUsd: 3,
    totalUsd: 4,
    status: 'in_review',
    reviewDeadline: Timestamp.fromMillis(Date.now() - 61 * 60_000),
  });

  const count1 = await ordersService.refundStaleReviewOrders(50);
  const count2 = await ordersService.refundStaleReviewOrders(50);

  assert.equal(count1, 1);
  assert.equal(count2, 0);

  const order = await ordersService.getOrder('ord-d');
  assert.equal(order.status, 'cancelled');
  assert.ok(order.refundedAt);
  assert.equal(await getUserBalance('user-d'), 7);

  const movements = await getWalletMovements('user-d');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].id, 'refund_ord-d');
  assert.equal(movements[0].reason, 'Reembolso de la orden RF-DDDD04');
});

test('e) Admin reembolsa justo mientras corre la programada: un solo reembolso', async () => {
  store.clear();
  await seedUserAndOrder({
    orderId: 'ord-e',
    code: 'RF-EEEE05',
    uid: 'user-e',
    initialWalletUsd: 0,
    totalUsd: 10,
    status: 'in_review',
    reviewDeadline: Timestamp.fromMillis(Date.now() - 61 * 60_000),
  });

  await Promise.all([
    ordersService.refundOrder('ord-e', 'Reembolsado por admin', { actor: ADMIN_ACTOR }),
    ordersService.refundStaleReviewOrders(50),
  ]);

  const order = await ordersService.getOrder('ord-e');
  assert.equal(order.status, 'cancelled');
  assert.equal(await getUserBalance('user-e'), 10);

  const movements = await getWalletMovements('user-e');
  assert.equal(movements.length, 1);
  assert.equal(movements[0].id, 'refund_ord-e');
  assert.equal(movements[0].reason, 'Reembolso de la orden RF-EEEE05');
});

test('f) Orden failed histórica con pricing.walletRefunded === true: reembolsar no acredita saldo de nuevo', async () => {
  store.clear();
  await seedUserAndOrder({
    orderId: 'ord-legacy',
    code: 'RF-LEGA06',
    uid: 'user-legacy',
    initialWalletUsd: 5, // ya tenía el reembolso del sistema viejo
    totalUsd: 5,
    status: 'failed',
    walletRefunded: true,
  });

  const updated = await ordersService.refundOrder('ord-legacy', 'Cierre orden vieja', {
    actor: ADMIN_ACTOR,
  });
  assert.equal(updated.status, 'cancelled');
  assert.equal(await getUserBalance('user-legacy'), 5);
  assert.equal((await getWalletMovements('user-legacy')).length, 0);
});

test('g) Respuesta tardía del proveedor: sobre in_review completa sin reembolso; sobre cancelled ignora y registra log.error', async () => {
  store.clear();

  // Caso 1: Éxito tardío sobre orden en `in_review` -> pasa a `completed`, sin reembolso
  await seedUserAndOrder({
    orderId: 'ord-late-ok',
    code: 'RF-LATE07',
    uid: 'user-late-ok',
    initialWalletUsd: 0,
    totalUsd: 6,
    status: 'in_review',
    reviewDeadline: Timestamp.fromMillis(Date.now() + 45 * 60_000),
  });
  await mockDb.collection('orders').doc('ord-late-ok').update({
    'dispatch.calls': [
      {
        packageId: 10,
        providerGameId: 1,
        index: 0,
        status: 'processing',
        provider: 'inefable',
        providerOrderId: 'prov-1',
        providerStatus: 'processing',
        playerName: null,
        providerReference: null,
        error: null,
        httpStatus: 202,
        providerResponse: null,
        attempts: 1,
        completedAt: null,
      },
    ],
  });

  const res1 = await dispatchService.resolveProcessingOrder('RF-LATE07-1');
  assert.equal(res1, 'resuelta');
  const completedOrder = await ordersService.getOrder('ord-late-ok');
  assert.equal(completedOrder.status, 'completed');
  assert.equal(await getUserBalance('user-late-ok'), 0);

  // Caso 2: Éxito tardío sobre orden ya `cancelled` / reembolsada -> no cambia estado y registra log.error
  await seedUserAndOrder({
    orderId: 'ord-late-cancel',
    code: 'RF-LATE08',
    uid: 'user-late-cancel',
    initialWalletUsd: 0,
    totalUsd: 6,
    status: 'in_review',
    reviewDeadline: Timestamp.fromMillis(Date.now() - 61 * 60_000),
  });
  await ordersService.refundOrder('ord-late-cancel', 'Expiró 1h');

  const errorLogs = [];
  const origError = logger.log.error;
  logger.log.error = (msg, meta) => {
    errorLogs.push({ msg, meta });
  };

  try {
    await dispatchService.resolveProcessingOrder('RF-LATE08-1');
    await dispatchService.finalizeDispatch(
      await ordersService.getOrder('ord-late-cancel'),
      [
        {
          packageId: 10,
          providerGameId: 1,
          index: 0,
          status: 'success',
          providerOrderId: 'prov-late',
          providerStatus: 'completed',
          playerName: 'Player',
          providerReference: 'ref-late',
          error: null,
          httpStatus: 200,
          providerResponse: null,
          attempts: 1,
          completedAt: Timestamp.now(),
        },
      ],
      true
    );
  } finally {
    logger.log.error = origError;
  }

  const stillCancelled = await ordersService.getOrder('ord-late-cancel');
  assert.equal(stillCancelled.status, 'cancelled');
  assert.ok(
    errorLogs.some((e) => e.msg.includes('entrega tardía en orden reembolsada: revisar manualmente')),
    `Se esperaba log.error de entrega tardía, se obtuvo: ${JSON.stringify(errorLogs)}`
  );
});
