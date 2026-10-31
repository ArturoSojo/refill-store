const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock with FieldValue.increment & transaction support
// ---------------------------------------------------------------------------
const store = new Map();
let autoIdCounter = 0;
let txChain = Promise.resolve();

function isIncrementTransform(val) {
  return Boolean(
    val &&
      typeof val === 'object' &&
      typeof val.operand === 'number' &&
      !(val instanceof Timestamp)
  );
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
  if (isIncrementTransform(value)) return value;
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
    if (isIncrementTransform(value)) {
      const prev = typeof out[key] === 'number' ? out[key] : 0;
      out[key] = Math.round((prev + value.operand) * 10000) / 10000;
    } else if (
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
        store.set(docPath, deepMerge({}, data));
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
          const leaf = parts[parts.length - 1];
          cursor[leaf] = isIncrementTransform(v)
            ? Math.round(((Number(cursor[leaf]) || 0) + v.operand) * 10000) / 10000
            : clone(v);
        } else {
          current[k] = isIncrementTransform(v)
            ? Math.round(((Number(current[k]) || 0) + v.operand) * 10000) / 10000
            : clone(v);
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
    auth: { verifyIdToken: async () => ({ uid: 'u1' }) },
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
      sessions: 'sessions',
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
    sessions: () => mockDb.collection('sessions'),
    configDoc: () => mockDb.collection('config').doc('app'),
    privateChatbotConfigDoc: () => mockDb.collection('privateConfig').doc('chatbot'),
    privateWhatsappSyncConfigDoc: () => mockDb.collection('privateConfig').doc('whatsappSync'),
    dailyStats: () => mockDb.collection('stats').doc('daily').collection('days'),
    now: () => Timestamp.now(),
    timestampFromDate: (d) => Timestamp.fromDate(d),
    minutesFromNow: (m) => Timestamp.fromMillis(Date.now() + m * 60_000),
    Timestamp,
  },
};

const settingsPath = path.resolve(__dirname, '../lib/services/settings.js');
require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    getConfig: async () => ({
      tiers: [
        { tier: 'hierro', label: 'Hierro', minSpentUsd: 0, discountPercent: 0, profile: 'Inicial' },
        { tier: 'bronce', label: 'Bronce', minSpentUsd: 10, discountPercent: 1, profile: 'Bronce' },
        { tier: 'plata', label: 'Plata', minSpentUsd: 35, discountPercent: 2, profile: 'Plata' },
        { tier: 'oro', label: 'Oro', minSpentUsd: 100, discountPercent: 3, profile: 'Oro' },
        { tier: 'platino', label: 'Platino', minSpentUsd: 250, discountPercent: 4, profile: 'VIP' },
        { tier: 'esmeralda', label: 'Esmeralda', minSpentUsd: 400, discountPercent: 4.5, profile: 'Élite' },
        { tier: 'rubi', label: 'Rubí', minSpentUsd: 700, discountPercent: 4.8, profile: 'Pro' },
        { tier: 'diamante', label: 'Diamante', minSpentUsd: 1000, discountPercent: 5, profile: 'Partner' },
      ],
    }),
  },
};

process.env.SYNC_SECRET_KEY = 'super-secret-sync-key-2026';

const {
  normalizeWhatsappPhone,
  syncWhatsappOrder,
  verifySyncSecret,
} = require('../lib/services/whatsappSync.js');
const { createApp } = require('../lib/app.js');

test('1) normalizeWhatsappPhone estandariza JID @s.whatsapp.net y números locales 04xx a +584xx', () => {
  const fromJid = normalizeWhatsappPhone('584141234567@s.whatsapp.net');
  assert.equal(fromJid.e164, '+584141234567');
  assert.equal(fromJid.local, '04141234567');

  const fromLocal = normalizeWhatsappPhone('0424-9876543');
  assert.equal(fromLocal.e164, '+584249876543');
  assert.equal(fromLocal.local, '04249876543');
});

test('2) verifySyncSecret rechaza secreto ausente o incorrecto y acepta SYNC_SECRET_KEY exacta', async () => {
  await assert.rejects(() => verifySyncSecret(undefined), { status: 401 });
  await assert.rejects(() => verifySyncSecret('wrong-secret'), { status: 401 });
  await assert.doesNotReject(() => verifySyncSecret('super-secret-sync-key-2026'));
});

test('3) syncWhatsappOrder vincula usuario Web por teléfono, incrementa gasto acumulado atómicamente, sube membresía y es idempotente', async () => {
  store.clear();

  await mockDb.collection('users').doc('web-user-99').set({
    email: 'gamer@refill.store',
    displayName: 'Gamer Pro',
    phone: '04141234567',
    tier: 'hierro',
    points: 40,
    stats: {
      totalOrders: 1,
      completedOrders: 1,
      totalSpentUsd: 6.0,
      lastOrderAt: null,
    },
  });

  const payload = {
    referencia: '99887766',
    canal: 'WHATSAPP',
    clienteContacto: '584141234567@s.whatsapp.net',
    juego: 'Free Fire',
    paqueteNombre: '830 + 83 Diamantes',
    productIds: [3, 2],
    playerId: '3363122817',
    montoBs: 6950,
    tasaBcv: 956.04,
    montoUsd: 7.27,
    costoProveedorUsd: 5.705,
    gananciaNetaUsd: 1.565,
    tipoDespacho: 'AUTOMATICO',
    estado: 'COMPLETADO',
    subOrdenes: [
      {
        product_id: 3,
        exito: true,
        order_id: 5001,
        status: 'exitosa',
        error: null,
        timestamp: new Date().toISOString(),
      },
      {
        product_id: 2,
        exito: true,
        order_id: 5002,
        status: 'exitosa',
        error: null,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const first = await syncWhatsappOrder(payload);
  assert.equal(first.orderId, 'wa_99887766');
  assert.equal(first.matchedUserId, 'web-user-99');
  assert.equal(first.metricsAccountedNow, true);
  assert.equal(first.newTier, 'bronce'); // 6.0 + 7.27 = 13.27 >= 10 (Bronce)

  // Llamada repetida (ej. webhook + escritura directa compartida) NO duplica gasto ni órdenes
  const second = await syncWhatsappOrder(payload);
  assert.equal(second.metricsAccountedNow, false);

  const userSnap = await mockDb.collection('users').doc('web-user-99').get();
  const userData = userSnap.data();
  assert.equal(userData.stats.totalSpentUsd, 13.27);
  assert.equal(userData.stats.completedOrders, 2);
  assert.equal(userData.tier, 'bronce');

  const orderSnap = await mockDb.collection('orders').doc('wa_99887766').get();
  const orderData = orderSnap.data();
  assert.equal(orderData.origen, 'WHATSAPP');
  assert.equal(orderData.canal, 'WHATSAPP');
  assert.equal(orderData.uid, 'web-user-99');
  assert.equal(orderData.status, 'completed');
  assert.equal(orderData.estado, 'COMPLETADO');
  assert.equal(orderData.subOrdenes.length, 2);
});

test('4) Endpoint HTTP POST /api/orders/sync-whatsapp valida x-api-secret y vincula por playerId histórico', async () => {
  store.clear();

  await mockDb.collection('users').doc('user-by-playerid').set({
    email: 'ffplayer@refill.store',
    displayName: 'FF Player',
    phone: null,
    tier: 'plata',
    points: 350,
    stats: {
      totalOrders: 5,
      completedOrders: 5,
      totalSpentUsd: 96.0,
      lastOrderAt: null,
    },
  });

  // Orden histórica en la Web con el mismo playerId
  await mockDb.collection('orders').doc('hist-ord-1').set({
    uid: 'user-by-playerid',
    playerId: '777888999',
    status: 'completed',
  });

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // Sin x-api-secret -> 401
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/orders/sync-whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referencia: '11223344' }),
    });
    assert.equal(unauthRes.status, 401);

    // Con x-api-secret válido -> 200 y sube a Oro (96 + 5.50 = 101.50 >= 100)
    const okRes = await fetch(`http://127.0.0.1:${port}/api/orders/sync-whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': 'super-secret-sync-key-2026',
      },
      body: JSON.stringify({
        referencia: '44556677',
        canal: 'WHATSAPP',
        clienteContacto: '584120001122@s.whatsapp.net',
        juego: 'Free Fire',
        paqueteNombre: '520 Diamantes',
        productIds: [3],
        playerId: '777888999',
        montoBs: 5258.22,
        tasaBcv: 956.04,
        montoUsd: 5.5,
        costoProveedorUsd: 4.306,
        gananciaNetaUsd: 1.194,
        tipoDespacho: 'AUTOMATICO',
        estado: 'COMPLETADO',
      }),
    });

    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(body.matchedUserId, 'user-by-playerid');
    assert.equal(body.newTier, 'oro');

    const updatedUser = (await mockDb.collection('users').doc('user-by-playerid').get()).data();
    assert.equal(updatedUser.stats.totalSpentUsd, 101.5);
    assert.equal(updatedUser.tier, 'oro');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('5) No fabrica despacho exitoso falso si una orden fallida se completa manualmente, preservando el error real', async () => {
  store.clear();

  const failPayload = {
    referencia: '11002233',
    canal: 'WHATSAPP',
    clienteContacto: '584145550000@s.whatsapp.net',
    juego: 'Free Fire',
    paqueteNombre: '100 + 10 Diamantes',
    productIds: [6],
    playerId: '9988776655',
    montoBs: 901.76,
    tasaBcv: 969.64,
    montoUsd: 0.93,
    tipoDespacho: 'AUTOMATICO',
    estado: 'REVISION_MANUAL',
    subOrdenes: [
      {
        product_id: 6,
        package_id: 6,
        exito: false,
        order_id: null,
        status: 'fallida',
        error: 'Paquete 6 no encontrado o inactivo',
        httpStatus: 404,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await syncWhatsappOrder(failPayload);

  const initialOrder = (await mockDb.collection('orders').doc('wa_11002233').get()).data();
  assert.equal(initialOrder.status, 'in_review');
  assert.equal(initialOrder.dispatch.calls.length, 1);
  assert.equal(initialOrder.dispatch.calls[0].status, 'error');
  assert.equal(initialOrder.dispatch.calls[0].httpStatus, 404);
  assert.equal(initialOrder.dispatch.calls[0].completedAt, null);

  const completedPayload = {
    referencia: '11002233',
    canal: 'WHATSAPP',
    clienteContacto: '584145550000@s.whatsapp.net',
    juego: 'Free Fire',
    paqueteNombre: '100 + 10 Diamantes',
    productIds: [6],
    playerId: '9988776655',
    montoBs: 901.76,
    tasaBcv: 969.64,
    montoUsd: 0.93,
    tipoDespacho: 'AUTOMATICO',
    estado: 'COMPLETADO',
    subOrdenes: [],
  };

  await syncWhatsappOrder(completedPayload);

  const updatedOrder = (await mockDb.collection('orders').doc('wa_11002233').get()).data();
  assert.equal(updatedOrder.status, 'completed');
  assert.equal(updatedOrder.estado, 'COMPLETADO');
  assert.equal(updatedOrder.dispatch.calls.length, 1);
  assert.equal(updatedOrder.dispatch.calls[0].status, 'error');
  assert.equal(updatedOrder.dispatch.calls[0].httpStatus, 404);
  assert.equal(updatedOrder.dispatch.calls[0].error, 'Paquete 6 no encontrado o inactivo');
  assert.equal(updatedOrder.dispatch.completedAt, null);
});
