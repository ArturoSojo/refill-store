const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { Timestamp } = require('firebase-admin/firestore');

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

function deepMerge(target, source) {
  const out = clone(target || {});
  for (const [key, value] of Object.entries(source || {})) {
    if (value === undefined) continue;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Timestamp) &&
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

function makeSnap(docPath) {
  const id = docPath.split('/').pop();
  const exists = store.has(docPath);
  const raw = exists ? clone(store.get(docPath)) : undefined;
  return {
    id,
    exists,
    data: () => (exists ? clone(raw) : undefined),
    ref: makeDocRef(docPath),
  };
}

function makeDocRef(docPath) {
  return {
    id: docPath.split('/').pop(),
    path: docPath,
    get: async () => makeSnap(docPath),
    set: async (data, options) => {
      if (options && options.merge) {
        store.set(docPath, deepMerge(store.get(docPath), data));
      } else {
        store.set(docPath, clone(data));
      }
    },
    update: async (data) => {
      store.set(docPath, deepMerge(store.get(docPath), data));
    },
    delete: async () => {
      store.delete(docPath);
    },
    collection: (sub) => makeCollectionRef(`${docPath}/${sub}`),
  };
}

function makeCollectionRef(colPath) {
  return {
    doc: (id) => {
      const docId = id || `auto_${++autoIdCounter}`;
      return makeDocRef(`${colPath}/${docId}`);
    },
    add: async (data) => {
      const ref = makeDocRef(`${colPath}/auto_${++autoIdCounter}`);
      await ref.set(data);
      return ref;
    },
    get: async () => {
      const prefix = `${colPath}/`;
      const docs = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          docs.push(makeSnap(key));
        }
      }
      return { docs, empty: docs.length === 0, size: docs.length };
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
    auth: {
      verifyIdToken: async () => ({
        uid: 'admin-1',
        email: 'admin@refill.test',
        admin: true,
        staff: true,
        email_verified: true,
        auth_time: Math.floor(Date.now() / 1000),
      }),
    },
    COLLECTIONS: {
      modals: 'modals',
      config: 'config',
      auditLogs: 'auditLogs',
      users: 'users',
    },
    CONFIG_DOC_ID: 'app',
    modals: () => mockDb.collection('modals'),
    configDoc: () => mockDb.collection('config').doc('app'),
    auditLogs: () => mockDb.collection('auditLogs'),
    users: () => mockDb.collection('users'),
    now: () => Timestamp.now(),
    Timestamp,
  },
};

const { createApp } = require('../lib/app.js');
const { invalidateConfigCache } = require('../lib/services/settings.js');

async function sendJson(server, method, routePath, body) {
  const address = server.address();
  const payload = body !== undefined ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: routePath,
        method,
        headers: {
          Authorization: 'Bearer test-admin-token',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('admin modals and notices persist scrollTarget and #hash URLs cleanly', async (t) => {
  store.clear();
  store.set('users/admin-1', {
    uid: 'admin-1',
    email: 'admin@refill.test',
    role: 'admin',
    banned: false,
  });
  invalidateConfigCache();

  const server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  // 1. Crear modal con scrollTarget "#telefono" y ctaUrl "/cuenta#telefono"
  const createModalRes = await sendJson(server, 'POST', '/api/admin/modals', {
    title: '🛡️ Asegura tu cuenta en RefillStore',
    body: 'Vincula tu teléfono para recuperar acceso fácilmente',
    ctaLabel: 'Vincular número',
    ctaUrl: '/cuenta#telefono',
    scrollTarget: '#telefono',
    active: true,
    frequency: 'once',
    placement: 'home',
    audience: 'both',
    sortOrder: 1,
  });

  assert.equal(createModalRes.status, 201);
  assert.equal(createModalRes.json.data.modal.ctaUrl, '/cuenta#telefono');
  assert.equal(createModalRes.json.data.modal.scrollTarget, 'telefono');

  // Verificar que el endpoint público de modales expone scrollTarget y ctaUrl
  const publicModalsRes = await sendJson(server, 'GET', '/api/modals');
  assert.equal(publicModalsRes.status, 200);
  assert.equal(publicModalsRes.json.data.modals.length, 1);
  assert.equal(publicModalsRes.json.data.modals[0].scrollTarget, 'telefono');
  assert.equal(publicModalsRes.json.data.modals[0].ctaUrl, '/cuenta#telefono');

  // 2. Guardar avisos en /api/admin/config con scrollTarget y #hash en linkUrl
  const patchConfigRes = await sendJson(server, 'PATCH', '/api/admin/config', {
    announcement: {
      enabled: true,
      intervalSeconds: 5,
      notices: [
        {
          id: 'notice-phone',
          text: 'Protege tu cuenta RefillStore',
          highlightText: 'en 10 segundos',
          badge: 'SEGURIDAD',
          linkText: 'Vincular número',
          linkUrl: '/cuenta#telefono',
          scrollTarget: 'telefono',
          active: true,
        },
        {
          id: 'notice-games',
          text: 'Explora los paquetes disponibles',
          linkText: 'Ver juegos',
          linkUrl: '#juegos',
          scrollTarget: '#juegos',
          active: true,
        },
      ],
    },
  });

  assert.equal(patchConfigRes.status, 200);
  const savedNotices = patchConfigRes.json.data.config.announcement.notices;
  assert.equal(savedNotices.length, 2);
  assert.equal(savedNotices[0].linkUrl, '/cuenta#telefono');
  assert.equal(savedNotices[0].scrollTarget, 'telefono');
  assert.equal(savedNotices[1].linkUrl, '#juegos');
  assert.equal(savedNotices[1].scrollTarget, 'juegos');

  // Verificar que /api/config público expone los avisos con scrollTarget intacto
  const publicConfigRes = await sendJson(server, 'GET', '/api/config');
  assert.equal(publicConfigRes.status, 200);
  assert.equal(publicConfigRes.json.data.announcement.notices[0].scrollTarget, 'telefono');
  assert.equal(publicConfigRes.json.data.announcement.notices[0].linkUrl, '/cuenta#telefono');

  // 3. Rechazar IDs de scroll malformados
  const invalidModalRes = await sendJson(server, 'POST', '/api/admin/modals', {
    title: 'Modal inválido',
    scrollTarget: 'bad id!<script>',
  });
  assert.equal(invalidModalRes.status, 400);
});
