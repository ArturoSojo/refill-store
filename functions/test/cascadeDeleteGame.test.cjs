const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Timestamp, FieldValue } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// In-memory Firestore mock for Cascade Delete Game tests
// ---------------------------------------------------------------------------
const store = new Map();

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
    // Handle FieldValue.arrayUnion
    if (value && typeof value === 'object' && value.isUnion) {
      const existingArr = Array.isArray(out[key]) ? out[key] : [];
      const set = new Set(existingArr);
      for (const el of value.elements) set.add(el);
      out[key] = Array.from(set);
      continue;
    }
    // Handle FieldValue.arrayRemove
    if (value && typeof value === 'object' && value.isRemove) {
      const existingArr = Array.isArray(out[key]) ? out[key] : [];
      const removeSet = new Set(value.elements);
      out[key] = existingArr.filter((el) => !removeSet.has(el));
      continue;
    }
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
    get: (f) => raw[f],
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
    delete: async () => {
      store.delete(docPath);
    },
  };
}

function makeQuery(colPath, filters = []) {
  return {
    where: (field, op, value) => makeQuery(colPath, [...filters, { field, op, value }]),
    get: async () => {
      const prefix = `${colPath}/`;
      const docs = [];
      for (const [k, v] of store.entries()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest.includes('/')) continue;
        const matches = filters.every(({ field, op, value }) => {
          if (op === '==') return v[field] === value;
          return false;
        });
        if (matches) {
          docs.push({
            id: rest,
            ref: makeDocRef(k),
            exists: true,
            data: () => clone(v),
            get: (f) => v[f],
          });
        }
      }
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs,
      };
    },
    count: () => ({
      get: async () => {
        const snap = await makeQuery(colPath, filters).get();
        return { data: () => ({ count: snap.size }) };
      },
    }),
  };
}

function makeCollectionRef(colPath) {
  const baseQuery = makeQuery(colPath);
  return {
    ...baseQuery,
    firestore: mockDb,
    doc: (id) => makeDocRef(`${colPath}/${id}`),
  };
}

const mockDb = {
  collection: (name) => makeCollectionRef(name),
  batch: () => {
    const ops = [];
    return {
      delete: (ref) => ops.push(() => ref.delete()),
      set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
      commit: async () => {
        for (const op of ops) await op();
      },
    };
  },
};

// Stub FieldValue.arrayUnion and arrayRemove for testing
FieldValue.arrayUnion = (...elements) => ({ isUnion: true, elements });
FieldValue.arrayRemove = (...elements) => ({ isRemove: true, elements });

// Stub firebase module before importing catalog & sync services
const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    COLLECTIONS: {
      games: 'games',
      products: 'products',
      privateCentralOneConfig: 'privateConfig',
    },
    games: () => mockDb.collection('games'),
    products: () => mockDb.collection('products'),
    privateCentralOneConfigDoc: () => mockDb.collection('privateConfig').doc('centralOne'),
    now: () => Timestamp.now(),
    Timestamp,
  },
};

// Compile / require services
const catalog = require('../lib/services/catalog.js');
const { recordDeletedGame, unrecordDeletedGame } = require('../lib/services/centralOneCatalogSync.js');

test('Borrado en cascada: elimina el juego y todos sus paquetes asociados', async () => {
  store.clear();

  // Sembrar juego y sus productos
  await mockDb.collection('games').doc('blood-strike-fc').set({
    name: 'Blood Strike FC',
    provider: 'fazercards',
    active: false,
    productCount: 3,
  });

  await mockDb.collection('products').doc('bs-pack-100').set({
    name: '100 Oro',
    gameId: 'blood-strike-fc',
    priceUsd: 1.0,
  });
  await mockDb.collection('products').doc('bs-pack-500').set({
    name: '500 Oro',
    gameId: 'blood-strike-fc',
    priceUsd: 5.0,
  });
  await mockDb.collection('products').doc('bs-pack-1000').set({
    name: '1000 Oro',
    gameId: 'blood-strike-fc',
    priceUsd: 10.0,
  });

  // Sembrar otro juego que no debe ser tocado
  await mockDb.collection('games').doc('free-fire-latam').set({
    name: 'Free Fire',
    provider: 'centralone',
    active: true,
  });
  await mockDb.collection('products').doc('ff-pack-100').set({
    name: '100 Diamantes',
    gameId: 'free-fire-latam',
    priceUsd: 0.9,
  });

  // Ejecutar borrado en cascada
  const result = await catalog.deleteGameCascade('blood-strike-fc');

  assert.equal(result.deleted, true);
  assert.equal(result.deletedProducts, 3);
  assert.equal(result.gameName, 'Blood Strike FC');

  // Verificar que el juego y sus productos desaparecieron
  const deletedGameSnap = await mockDb.collection('games').doc('blood-strike-fc').get();
  assert.equal(deletedGameSnap.exists, false);

  const p1 = await mockDb.collection('products').doc('bs-pack-100').get();
  const p2 = await mockDb.collection('products').doc('bs-pack-500').get();
  const p3 = await mockDb.collection('products').doc('bs-pack-1000').get();
  assert.equal(p1.exists, false);
  assert.equal(p2.exists, false);
  assert.equal(p3.exists, false);

  // Verificar que el otro juego y sus productos siguen intactos
  const untouchedGame = await mockDb.collection('games').doc('free-fire-latam').get();
  assert.equal(untouchedGame.exists, true);
  const untouchedProduct = await mockDb.collection('products').doc('ff-pack-100').get();
  assert.equal(untouchedProduct.exists, true);
});

test('Borrado en cascada: lanza notFound si el juego no existe', async () => {
  store.clear();

  await assert.rejects(
    async () => {
      await catalog.deleteGameCascade('juego-inexistente');
    },
    {
      code: 'not_found',
      message: 'Ese juego no existe.',
    }
  );
});

test('Central One Sync: recordDeletedGame y unrecordDeletedGame guardan y limpian deletedGameIds', async () => {
  store.clear();

  await recordDeletedGame('co-topup-blood-strike');

  let configSnap = await mockDb.collection('privateConfig').doc('centralOne').get();
  let data = configSnap.data();
  assert.ok(Array.isArray(data.deletedGameIds));
  assert.ok(data.deletedGameIds.includes('co-topup-blood-strike'));

  // Añadir otro
  await recordDeletedGame('co-topup-another-game');
  configSnap = await mockDb.collection('privateConfig').doc('centralOne').get();
  data = configSnap.data();
  assert.equal(data.deletedGameIds.length, 2);

  // Desregistrar uno
  await unrecordDeletedGame('co-topup-blood-strike');
  configSnap = await mockDb.collection('privateConfig').doc('centralOne').get();
  data = configSnap.data();
  assert.ok(!data.deletedGameIds.includes('co-topup-blood-strike'));
  assert.ok(data.deletedGameIds.includes('co-topup-another-game'));
});

test('invalidateCatalogCache se ejecuta limpiamente', () => {
  assert.doesNotThrow(() => {
    catalog.invalidateCatalogCache();
  });
});

