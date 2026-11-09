const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'refill-e254f' });
}
const db = admin.firestore();

const ID_KEYS = new Set([
  'player_id',
  'game_user_id',
  'user_id',
  'uid',
  'account_id',
  'character_id',
  'open_id',
  'role_id',
  'playerid',
  'userid',
]);

const SERVER_KEYS = new Set([
  'server_id',
  'zone_id',
  'game_zone_id',
  'server',
  'zone',
  'game_server_id',
  'region',
  'serverid',
  'zoneid',
]);

function sanitizePlayerFields(fields) {
  if (!Array.isArray(fields) || fields.length <= 1) return fields;

  let seenId = false;
  let seenServer = false;
  const sanitized = [];

  for (const field of fields) {
    const key = (field.key || '').toLowerCase();
    const label = (field.label || '').toLowerCase();
    const isId =
      ID_KEYS.has(key) ||
      label.includes('id de jugador') ||
      label.includes('id del jugador') ||
      label === 'player id' ||
      label === 'user id' ||
      label === 'uid';
    const isServer =
      SERVER_KEYS.has(key) ||
      label.includes('servidor / zone id') ||
      label.includes('zone id');

    if (isId) {
      if (seenId) continue;
      seenId = true;
    } else if (isServer) {
      if (seenServer) continue;
      seenServer = true;
    }

    sanitized.push(field);
  }

  return sanitized;
}

function normalizeSpecialName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function extractCurrency(name) {
  const m = (name || '').toLowerCase().match(/\b(tokens?|diamonds?|diamantes?|uc|oro|gold|monedas?|coins?|cash|crowns?|cp|gemas?|gems?|vouchers?|opals?|genesis|crystals?|nexus|b-chips)\b/i);
  return m ? m[1].toLowerCase() : '';
}

function scoreProduct(p) {
  let score = 0;
  if (p.active !== false) score += 1000;
  const name = (p.name || '').trim();
  // Si tiene texto con unidad (ej. "80 Tokens")
  if (/[a-zA-Z]/.test(name)) score += 100;
  // Si es un número huérfano (ej: "80", "16")
  if (/^\d+(\s*\+\s*\d+)?$/.test(name)) score -= 50;
  // Preferir menor costo
  const cost = typeof p.costUsd === 'number' ? p.costUsd : 999999;
  return score - cost * 0.001;
}

async function run() {
  console.log('=== INICIANDO AUDITORÍA Y LIMPIEZA GLOBAL EN FIRESTORE ===\n');

  // 1. LIMPIEZA DE CAMPOS DE JUGADOR EN GAMES
  const gamesSnap = await db.collection('games').get();
  console.log(`Auditoría de campos: ${gamesSnap.size} juegos inspeccionados.`);
  let gamesWithDuplicateFields = 0;
  const fixedGames = [];

  const batchSize = 400;
  let batch = db.batch();
  let batchCount = 0;

  for (const doc of gamesSnap.docs) {
    const data = doc.data();
    const fields = data.playerFields;
    if (!Array.isArray(fields) || fields.length <= 1) continue;

    const cleaned = sanitizePlayerFields(fields);
    if (cleaned.length < fields.length) {
      gamesWithDuplicateFields++;
      fixedGames.push({
        id: doc.id,
        name: data.name,
        before: fields.map((f) => `${f.key} (${f.label})`),
        after: cleaned.map((f) => `${f.key} (${f.label})`),
      });
      batch.update(doc.ref, { playerFields: cleaned, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      batchCount++;
      if (batchCount >= batchSize) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }
  }

  if (batchCount > 0) {
    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  }

  console.log(`\nJuegos con campos de jugador duplicados corregidos: ${gamesWithDuplicateFields}`);
  fixedGames.forEach((g) => {
    console.log(`- ${g.name} (${g.id}):`);
    console.log(`  Antes: [${g.before.join(', ')}]`);
    console.log(`  Ahora: [${g.after.join(', ')}]`);
  });

  // 2. DEDUPLICACIÓN DE PAQUETES EN PRODUCTS
  const prodsSnap = await db.collection('products').get();
  console.log(`\nAuditoría de paquetes: ${prodsSnap.size} productos inspeccionados.`);

  const gamesMap = new Map();
  gamesSnap.forEach((d) => gamesMap.set(d.id, { id: d.id, ...d.data() }));

  const productsByGame = new Map();
  prodsSnap.forEach((d) => {
    const p = { id: d.id, ...d.data(), ref: d.ref };
    if (!productsByGame.has(p.gameId)) productsByGame.set(p.gameId, []);
    productsByGame.get(p.gameId).push(p);
  });

  let duplicateGamesCount = 0;
  let totalDeletedProducts = 0;
  let totalRenamedProducts = 0;
  const gamesAffected = [];
  const gamesToRecalculate = new Set();

  for (const [gameId, prods] of productsByGame) {
    const game = gamesMap.get(gameId);
    const currencyLabel = (game?.currencyLabel || game?.currency?.label || '').trim();
    const groups = new Map();

    for (const p of prods) {
      const name = (p.name || '').trim();
      const amount = typeof p.amount === 'number' ? p.amount : 0;
      const bonus = typeof p.bonus === 'number' ? p.bonus : 0;
      const isPureNumber = /^\d+(\s*\+\s*\d+)?$/.test(name);
      const isPackage = p.kind === 'package' || amount > 1 || isPureNumber;

      let key;
      if (isPackage && amount > 1) {
        const curr = extractCurrency(name) || currencyLabel.toLowerCase() || 'default';
        key = `pkg:${amount}:${bonus}:${curr}`;
      } else {
        key = `special:${normalizeSpecialName(name)}`;
      }

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    let gameHasDups = false;
    const dupsInGame = [];

    for (const [key, items] of groups) {
      if (items.length > 1) {
        gameHasDups = true;
        // Ordenar por score descendente (el ganador queda en index 0)
        items.sort((a, b) => scoreProduct(b) - scoreProduct(a));
        const winner = items[0];
        const losers = items.slice(1);

        // Si el ganador tiene un nombre huérfano (ej: "16"), ponerle su moneda
        if (/^\d+(\s*\+\s*\d+)?$/.test((winner.name || '').trim()) && currencyLabel) {
          const newName = `${winner.name.trim()} ${currencyLabel}`;
          batch.update(winner.ref, { name: newName, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          totalRenamedProducts++;
          batchCount++;
          winner.name = newName;
        }

        // Eliminar perdedores
        for (const loser of losers) {
          batch.delete(loser.ref);
          totalDeletedProducts++;
          batchCount++;
          if (batchCount >= batchSize) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }

        dupsInGame.push({
          key,
          winner: `${winner.name} ($${winner.priceUsd}) [${winner.id}]`,
          losersCount: losers.length,
          losers: losers.map((l) => `${l.name} ($${l.priceUsd}) [${l.id}]`),
        });
        gamesToRecalculate.add(gameId);
      } else {
        // Paquete único: revisar si su nombre es huérfano y formatearlo
        const single = items[0];
        if (/^\d+(\s*\+\s*\d+)?$/.test((single.name || '').trim()) && currencyLabel && single.amount > 0) {
          const newName = `${single.name.trim()} ${currencyLabel}`;
          batch.update(single.ref, { name: newName, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          totalRenamedProducts++;
          batchCount++;
          if (batchCount >= batchSize) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }
      }
    }

    if (gameHasDups) {
      duplicateGamesCount++;
      gamesAffected.push({
        gameId,
        gameName: game?.name || gameId,
        dups: dupsInGame,
      });
    }
  }

  if (batchCount > 0) {
    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  }

  console.log(`\nJuegos con paquetes duplicados corregidos: ${duplicateGamesCount}`);
  console.log(`Total de paquetes duplicados eliminados de Firestore: ${totalDeletedProducts}`);
  console.log(`Total de paquetes renombrados con su moneda: ${totalRenamedProducts}`);

  // 3. RECALCULAR MINPRICEUSD Y PRODUCTCOUNT EN LOS JUEGOS AFECTADOS
  console.log(`\nRecalculando minPriceUsd y productCount en ${gamesToRecalculate.size} juegos...`);
  for (const gameId of gamesToRecalculate) {
    const activeProdsSnap = await db
      .collection('products')
      .where('gameId', '==', gameId)
      .where('active', '==', true)
      .get();

    let minPriceUsd = null;
    activeProdsSnap.forEach((d) => {
      const p = d.data();
      if (typeof p.priceUsd === 'number') {
        if (minPriceUsd === null || p.priceUsd < minPriceUsd) {
          minPriceUsd = p.priceUsd;
        }
      }
    });

    batch.update(db.collection('games').doc(gameId), {
      productCount: activeProdsSnap.size,
      minPriceUsd: minPriceUsd ?? 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batchCount++;
    if (batchCount >= batchSize) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  console.log('\n=== REPORTE DETALLADO DE JUEGOS PRINCIPALES CORREGIDOS ===');
  const hok = gamesAffected.find((g) => g.gameId.includes('honor-of-kings'));
  if (hok) {
    console.log(`\nHonor of Kings (${hok.gameId}): ${hok.dups.length} grupos duplicados corregidos.`);
    hok.dups.forEach((d) => {
      console.log(`  - Denominación: ${d.key}`);
      console.log(`    Conservado: ${d.winner}`);
      console.log(`    Eliminados: ${d.losers.join(', ')}`);
    });
  }

  const ww = gamesAffected.find((g) => g.gameId.includes('wuthering-waves'));
  if (ww) {
    console.log(`\nWuthering Waves (${ww.gameId}): ${ww.dups.length} grupos duplicados corregidos.`);
    ww.dups.forEach((d) => {
      console.log(`  - Denominación: ${d.key}`);
      console.log(`    Conservado: ${d.winner}`);
      console.log(`    Eliminados: ${d.losers.join(', ')}`);
    });
  }

  console.log('\n=== AUDITORÍA Y LIMPIEZA COMPLETADA CON ÉXITO ===');
}

run().catch((err) => {
  console.error('Error durante la limpieza:', err);
  process.exit(1);
});

