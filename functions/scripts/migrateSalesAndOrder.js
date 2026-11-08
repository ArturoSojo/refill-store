const admin = require('../node_modules/firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'refill-e254f' });
}
const db = admin.firestore();

function getRegionTier(game) {
  const code = (game.regionCode || game.region || '').trim().toUpperCase();
  const isRestricted = game.isRegionRestricted === true;

  if (!isRestricted || code === 'GLOBAL' || code === 'LATAM' || code === 'AMERICAS' || code === 'VE') {
    return 1;
  }
  if (code === 'US' || code === 'USA') {
    return 2;
  }
  return 3;
}

const TOPUP_POPULARITY_RANK = [
  { pattern: /free\s*fire/i, rank: 10 },
  { pattern: /blood\s*strike/i, rank: 20 },
  { pattern: /call\s*of\s*duty|cod\s*mobile|\bcodm\b/i, rank: 30 },
  { pattern: /roblox/i, rank: 40 },
  { pattern: /pubg/i, rank: 50 },
  { pattern: /mobile\s*legends|\bmlbb\b/i, rank: 60 },
  { pattern: /clash\s*royale|brawl\s*stars|clash\s*of\s*clans/i, rank: 70 },
  { pattern: /genshin/i, rank: 80 },
  { pattern: /valorant/i, rank: 90 },
  { pattern: /honor\s*of\s*kings/i, rank: 100 },
];

const GIFT_CARD_POPULARITY_RANK = [
  { pattern: /roblox/i, rank: 10 },
  { pattern: /free\s*fire/i, rank: 20 },
  { pattern: /playstation|\bpsn\b/i, rank: 30 },
  { pattern: /steam/i, rank: 40 },
  { pattern: /google\s*play/i, rank: 50 },
  { pattern: /apple|itunes|app\s*store/i, rank: 60 },
  { pattern: /razer\s*gold/i, rank: 70 },
  { pattern: /xbox/i, rank: 80 },
  { pattern: /nintendo/i, rank: 90 },
  { pattern: /binance/i, rank: 100 },
];

function getBasePopularityRank(name, family) {
  if (!name) return 999;
  const list = family === 'gift_card' ? GIFT_CARD_POPULARITY_RANK : TOPUP_POPULARITY_RANK;
  for (const item of list) {
    if (item.pattern.test(name)) return item.rank;
  }
  return 999;
}

function cleanGameTitle(title) {
  if (!title) return '';
  return title
    .replace(/\s*(?:[-–—]\s*)?\((?:Solo\s+)?[A-Z\u00C0-\u00DC\s\/\-_]+\)\s*$/i, '')
    .replace(/\s+(?:GLOBAL|LATAM)\s*$/i, '')
    .trim();
}

function calculateGameSortOrder(game) {
  const tier = getRegionTier(game);
  const baseOffset = tier * 100_000_000;
  const sales = Math.min(game.salesCount || 0, 5000);
  const salesReduction = sales * 10_000;
  const rank = getBasePopularityRank(game.name, game.providerFamily);
  const rankAddition = rank * 10;

  return baseOffset - salesReduction + rankAddition;
}

function compareCatalogGames(a, b) {
  const tierA = getRegionTier(a);
  const tierB = getRegionTier(b);
  if (tierA !== tierB) return tierA - tierB;

  const salesA = a.salesCount || 0;
  const salesB = b.salesCount || 0;
  if (salesA !== salesB) return salesB - salesA;

  const rankA = getBasePopularityRank(a.name, a.providerFamily);
  const rankB = getBasePopularityRank(b.name, b.providerFamily);
  if (rankA !== rankB) return rankA - rankB;

  return cleanGameTitle(a.name).localeCompare(cleanGameTitle(b.name));
}

const LEGACY_MAP = {
  'free-fire': 'co-topup-free-fire-latam',
  'freefire-id': 'co-topup-free-fire-latam',
  'fz-topup-free-fire-latam': 'co-topup-free-fire-latam',
  'free-fire-respaldo': 'co-topup-free-fire-latam',
  'blood-strike': 'co-topup-blood-strike-global',
  'fz-topup-blood-strike': 'co-topup-blood-strike-global',
  'mobile-legends': 'co-topup-mobile-legends-global',
  'fz-topup-mobile-legends-global': 'co-topup-mobile-legends-global',
  'roblox': 'co-gift_card-roblox-global',
  'call-of-duty-mobile': 'co-topup-call-of-duty-mobile-global',
};

async function migrate() {
  console.log('--- Iniciando cálculo histórico de ventas y reordenamiento ---');

  const [ordersSnap, gamesSnap] = await Promise.all([
    db.collection('orders').get(),
    db.collection('games').get()
  ]);

  console.log(`Leídas ${ordersSnap.size} órdenes y ${gamesSnap.size} juegos.`);

  // 1. Contabilizar ventas completadas
  const salesByGameId = {};
  let totalCompletedOrders = 0;

  for (const doc of ordersSnap.docs) {
    const order = doc.data();
    const isCompleted = order.status === 'completed' || order.estado === 'COMPLETADO';
    if (!isCompleted) continue;

    totalCompletedOrders++;
    const gId = order.gameId;
    if (!gId) continue;

    // Contar para el ID exacto de la orden
    salesByGameId[gId] = (salesByGameId[gId] || 0) + 1;

    // Si tiene un mapeo a un juego activo actual (ej. Central One), sumar también
    const mappedId = LEGACY_MAP[gId];
    if (mappedId && mappedId !== gId) {
      salesByGameId[mappedId] = (salesByGameId[mappedId] || 0) + 1;
    }
  }

  console.log(`Órdenes completadas procesadas: ${totalCompletedOrders}`);
  console.log('Top ventas por ID de juego:', Object.entries(salesByGameId).sort((a, b) => b[1] - a[1]).slice(0, 10));

  // 2. Preparar actualizaciones en lotes para Firestore
  const batches = [];
  let currentBatch = db.batch();
  let opCount = 0;

  const updatedGames = [];

  for (const doc of gamesSnap.docs) {
    const data = doc.data();
    const gameId = doc.id;
    const salesCount = salesByGameId[gameId] || 0;

    const gameObj = {
      id: gameId,
      name: data.name,
      providerFamily: data.providerFamily || (gameId.includes('-gift_card-') ? 'gift_card' : 'topup'),
      region: data.region,
      regionCode: data.regionCode,
      isRegionRestricted: data.isRegionRestricted,
      salesCount,
      active: data.active,
    };

    const newSortOrder = calculateGameSortOrder(gameObj);
    gameObj.sortOrder = newSortOrder;
    updatedGames.push(gameObj);

    currentBatch.update(doc.ref, {
      salesCount,
      sortOrder: newSortOrder,
    });
    opCount++;

    if (opCount === 450) {
      batches.push(currentBatch);
      currentBatch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    batches.push(currentBatch);
  }

  console.log(`Escribiendo actualizaciones en ${batches.length} lote(s)...`);
  for (let i = 0; i < batches.length; i++) {
    await batches[i].commit();
    console.log(`Lote ${i + 1}/${batches.length} completado.`);
  }

  // 3. Imprimir el Top 8 de Recargas y Gift Cards resultantes
  const activeGames = updatedGames.filter(g => g.active === true);
  const topupList = activeGames.filter(g => g.providerFamily === 'topup').sort(compareCatalogGames);
  const giftCardList = activeGames.filter(g => g.providerFamily === 'gift_card').sort(compareCatalogGames);

  console.log('\n========================================');
  console.log('  TOP 8 RECARGAS DE JUEGOS (Activos)');
  console.log('========================================');
  topupList.slice(0, 8).forEach((g, i) => {
    console.log(`${i + 1}. ${cleanGameTitle(g.name)} (${g.id}) | Región: ${g.regionCode || 'GLOBAL'} | Ventas: ${g.salesCount} | Tier: ${getRegionTier(g)} | sortOrder: ${g.sortOrder}`);
  });

  console.log('\n========================================');
  console.log('  TOP 8 GIFT CARDS (Activos)');
  console.log('========================================');
  giftCardList.slice(0, 8).forEach((g, i) => {
    console.log(`${i + 1}. ${cleanGameTitle(g.name)} (${g.id}) | Región: ${g.regionCode || 'GLOBAL'} | Ventas: ${g.salesCount} | Tier: ${getRegionTier(g)} | sortOrder: ${g.sortOrder}`);
  });

  console.log('\n--- Migración completada con éxito ---');
}

migrate().catch(console.error);
