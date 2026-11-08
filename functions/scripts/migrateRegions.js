const admin = require('firebase-admin');
const { resolveRegionInfo, extractPackageRegionNotice } = require('../lib/lib/regions.js');

if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'refill-e254f' });
}

const db = admin.firestore();

async function runMigration() {
  console.log('--- Iniciando migración regional en Firestore ---');

  // 1. Juegos
  console.log('Leyendo colección games...');
  const gamesSnap = await db.collection('games').get();
  console.log(`Total juegos en Firestore: ${gamesSnap.docs.length}`);

  const gameRegionMap = new Map();
  const summaryGames = [];

  let batch = db.batch();
  let opCount = 0;
  let gamesUpdated = 0;

  for (const doc of gamesSnap.docs) {
    const data = doc.data();
    const id = doc.id;
    const isCentralOne = data.provider === 'centralone' || id.startsWith('co-');
    
    // Resolvemos región para todos los juegos (o Central One prioritariamente)
    const info = resolveRegionInfo(data.regionCode || data.region, data.name, data.shortName);
    gameRegionMap.set(id, info);

    if (isCentralOne) {
      summaryGames.push({
        id,
        name: data.name,
        providerFamily: data.providerFamily || (id.includes('-gift_card-') ? 'gift_card' : 'topup'),
        regionCode: info.regionCode,
        regionLabel: info.regionLabel,
        isRegionRestricted: info.isRegionRestricted,
        regionWarning: info.regionWarning,
        active: data.active,
      });

      batch.set(
        doc.ref,
        {
          regionCode: info.regionCode,
          regionLabel: info.regionLabel,
          regionBadge: info.regionBadge,
          isRegionRestricted: info.isRegionRestricted,
          regionWarning: info.regionWarning,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      opCount++;
      gamesUpdated++;

      if (opCount >= 400) {
        await batch.commit();
        batch = db.batch();
        opCount = 0;
      }
    }
  }

  if (opCount > 0) {
    await batch.commit();
    batch = db.batch();
    opCount = 0;
  }

  console.log(`Juegos de Central One actualizados en Firestore: ${gamesUpdated}`);

  // 2. Productos
  console.log('Leyendo colección products...');
  const productsSnap = await db.collection('products').get();
  console.log(`Total productos en Firestore: ${productsSnap.docs.length}`);

  let productsUpdated = 0;

  for (const doc of productsSnap.docs) {
    const data = doc.data();
    const id = doc.id;
    const isCentralOne = data.provider === 'centralone' || id.startsWith('co-');

    if (!isCentralOne) continue;

    const gameInfo = gameRegionMap.get(data.gameId) || resolveRegionInfo(data.region, data.name);
    const notice = data.regionNotice || extractPackageRegionNotice(data.name) || (gameInfo.isRegionRestricted ? gameInfo.regionWarning : null);

    batch.set(
      doc.ref,
      {
        regionCode: gameInfo.regionCode,
        regionLabel: gameInfo.regionLabel,
        regionBadge: gameInfo.regionBadge,
        isRegionRestricted: gameInfo.isRegionRestricted,
        regionWarning: gameInfo.regionWarning,
        regionNotice: notice,
        isRegionLocked: gameInfo.isRegionRestricted,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    opCount++;
    productsUpdated++;

    if (opCount >= 400) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    await batch.commit();
  }

  console.log(`Productos de Central One actualizados en Firestore: ${productsUpdated}`);

  // Escribir resumen en JSON para construir la tabla
  const fs = require('fs');
  fs.writeFileSync('functions/scripts/summary_games.json', JSON.stringify(summaryGames, null, 2));
  console.log('Resumen guardado en functions/scripts/summary_games.json');
}

runMigration().catch(console.error);

