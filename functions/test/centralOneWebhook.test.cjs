const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// Dobles: Firestore en memoria (sólo lo que usa el webhook) y los servicios
// que la ruta importa. Así se prueba la ruta sin Admin SDK ni Central One.
// ---------------------------------------------------------------------------
const store = new Map();

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Timestamp ? { __ts: v.toMillis() } : v)));
}

function docRef(collection, id) {
  const key = `${collection}/${id}`;
  return {
    id,
    path: key,
    get: async () => ({ id, exists: store.has(key), data: () => clone(store.get(key)) }),
    set: async (data, options) => {
      const current = options && options.merge ? store.get(key) || {} : {};
      store.set(key, { ...current, ...clone(data) });
    },
    create: async (data) => {
      if (store.has(key)) {
        const error = new Error('ALREADY_EXISTS');
        error.code = 6;
        throw error;
      }
      store.set(key, clone(data));
    },
  };
}

function collection(name) {
  const query = (filters) => ({
    where: (field, op, value) => query([...filters, { field, op, value }]),
    get: async () => {
      const docs = [];
      for (const [key, data] of store.entries()) {
        if (!key.startsWith(`${name}/`)) continue;
        const id = key.slice(name.length + 1);
        const ok = filters.every(({ field, op, value }) =>
          op === 'in' ? value.includes(data[field]) : data[field] === value
        );
        if (ok) docs.push({ id, ref: docRef(name, id), data: () => clone(data), get: (f) => data[f] });
      }
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  return { doc: (id) => docRef(name, id), ...query([]) };
}

const mockDb = {
  collection,
  batch: () => {
    const ops = [];
    return {
      set: (ref, data, options) => ops.push(() => ref.set(data, options)),
      commit: async () => {
        for (const op of ops) await op();
      },
    };
  },
};

function mockModule(relative, exports) {
  const modulePath = path.resolve(__dirname, relative);
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

mockModule('../lib/config/firebase.js', {
  db: mockDb,
  COLLECTIONS: { playerIdCache: 'playerIdCache' },
  Timestamp,
  now: () => Timestamp.now(),
  games: () => collection('games'),
  products: () => collection('products'),
  providerWebhookEvents: () => collection('providerWebhookEvents'),
  privateCentralOneConfigDoc: () => docRef('privateConfig', 'centralOne'),
  playerIdCache: () => collection('playerIdCache'),
});

const resolverCalls = [];
let resolverImpl = async () => ({ matched: true, orderId: 'order-1', result: 'resuelta' });
mockModule('../lib/services/dispatch.js', {
  resolveCentralOneWebhookOrder: (input) => {
    resolverCalls.push(input);
    return resolverImpl(input);
  },
  resolveProcessingOrder: async () => 'no usado',
  resolveFazerProcessingOrder: async () => 'no usado',
});

const alerts = [];
mockModule('../lib/services/adminAlerts.js', { alert: async (input) => alerts.push(input) });
mockModule('../lib/services/settings.js', {
  getConfig: async () => ({ pricing: { defaultMarginPercent: 20, roundToUsd: 0.05, roundToBs: 0.01 } }),
});
mockModule('../lib/services/telegramSupportBot.js', { handleTelegramSupportWebhook: async () => {} });

const SECRET = 'whsec_prueba_refill';
process.env.CENTRAL_ONE_WEBHOOK_SECRET = SECRET;

const webhooks = require('../lib/routes/webhooks.routes.js');

function signed(body, { secret = SECRET, ts = Math.floor(Date.now() / 1000), headers = {} } = {}) {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return {
    rawBody: Buffer.from(raw),
    body,
    headers: {
      'x-centralone-timestamp': String(ts),
      'x-centralone-signature': signature,
      ...headers,
    },
  };
}

function reset() {
  store.clear();
  resolverCalls.length = 0;
  alerts.length = 0;
  resolverImpl = async () => ({ matched: true, orderId: 'order-1', result: 'resuelta' });
}

// ---------------------------------------------------------------------------
// Secreto, firma e identidad del aviso
// ---------------------------------------------------------------------------

test('webhook Central One: 503 mientras el secreto sea un marcador', async () => {
  reset();
  process.env.CENTRAL_ONE_WEBHOOK_SECRET = 'PENDIENTE';
  try {
    const result = await webhooks.processCentralOneWebhook(signed({ event: 'webhook.test', event_id: 'evt_x' }));
    assert.deepEqual(result, { status: 503, resultado: 'webhook no configurado' });
    assert.equal(store.size, 0, 'no anota nada sin secreto');
  } finally {
    process.env.CENTRAL_ONE_WEBHOOK_SECRET = SECRET;
  }
});

test('webhook Central One: 401 con firma de otro secreto, sin firma o con timestamp viejo', async () => {
  reset();
  const body = { event: 'order.completed', event_id: 'evt_bad', order: { id: 'co_1' } };
  const other = await webhooks.processCentralOneWebhook(signed(body, { secret: 'otro' }));
  assert.equal(other.status, 401);

  const unsigned = await webhooks.processCentralOneWebhook({ rawBody: Buffer.from(JSON.stringify(body)), body, headers: {} });
  assert.equal(unsigned.status, 401);

  const stale = await webhooks.processCentralOneWebhook(signed(body, { ts: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(stale.status, 401);

  const noBody = await webhooks.processCentralOneWebhook({ rawBody: undefined, body: {}, headers: {} });
  assert.equal(noBody.status, 401);

  assert.equal(resolverCalls.length, 0);
  assert.equal(store.size, 0, 'un aviso sin firma válida no deja rastro');
});

test('webhook Central One: 400 si la cabecera y el cuerpo firmado no coinciden', async () => {
  reset();
  const body = { event: 'order.completed', event_id: 'evt_1', order: { id: 'co_1' } };
  const result = await webhooks.processCentralOneWebhook(
    signed(body, { headers: { 'x-centralone-event': 'order.failed' } })
  );
  assert.equal(result.status, 400);
  assert.equal(resolverCalls.length, 0);
});

test('webhook Central One: la cabecera sólo suple lo que el cuerpo no trae', async () => {
  reset();
  const body = { order: { id: 'co_9', idempotency_key: 'RF-ABC123-1' } };
  const result = await webhooks.processCentralOneWebhook(
    signed(body, { headers: { 'x-centralone-event': 'order.completed', 'x-centralone-event-id': 'evt_hdr' } })
  );
  assert.deepEqual(result, { status: 200, resultado: 'resuelta' });
  assert.ok(store.has('providerWebhookEvents/evt_hdr'));
  // Primer aviso válido de la instancia: anota la hora para el panel.
  await new Promise((r) => setImmediate(r));
  assert.ok(store.get('privateConfig/centralOne')?.lastWebhookAt);
});

// ---------------------------------------------------------------------------
// Pedidos y candado contra repetidos
// ---------------------------------------------------------------------------

test('webhook Central One: order.* llama al resolvedor con id y llave, y el repetido no vuelve a entrar', async () => {
  reset();
  const body = {
    event: 'order.completed',
    event_id: 'evt_order_1',
    order: { id: 'co_ord_77', idempotency_key: 'RF-8K3M2Q-1', reference_code: 'CO-REF', status: 'completed' },
  };
  const first = await webhooks.processCentralOneWebhook(signed(body));
  assert.deepEqual(first, { status: 200, resultado: 'resuelta' });
  assert.deepEqual(resolverCalls, [{ providerOrderId: 'co_ord_77', idempotencyKey: 'RF-8K3M2Q-1' }]);

  const event = store.get('providerWebhookEvents/evt_order_1');
  assert.equal(event.provider, 'centralone');
  assert.equal(event.event, 'order.completed');
  assert.ok(event.expireAt, 'lleva expireAt para el TTL');

  const second = await webhooks.processCentralOneWebhook(signed(body));
  assert.deepEqual(second, { status: 200, resultado: 'repetido' });
  assert.equal(resolverCalls.length, 1, 'el reenvío no vuelve a consultar');
});

test('webhook Central One: orden no encontrada responde 200 igual', async () => {
  reset();
  resolverImpl = async () => ({ matched: false });
  const result = await webhooks.processCentralOneWebhook(
    signed({ event: 'order.failed', event_id: 'evt_nf', order: { id: 'co_x' } })
  );
  assert.deepEqual(result, { status: 200, resultado: 'orden no encontrada' });
});

test('webhook Central One: un fallo al procesar responde 200 (lo cubre el cron)', async () => {
  reset();
  resolverImpl = async () => {
    throw new Error('Firestore caído');
  };
  const result = await webhooks.processCentralOneWebhook(
    signed({ event: 'order.completed', event_id: 'evt_err', order: { id: 'co_x' } })
  );
  assert.deepEqual(result, { status: 200, resultado: 'error al procesar' });
});

test('webhook Central One: pasado el presupuesto de 8 s responde «en proceso»', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resolverImpl = () => new Promise(() => {});
  const pending = webhooks.processCentralOneWebhook(
    signed({ event: 'order.completed', event_id: 'evt_slow', order: { id: 'co_x' } })
  );
  // Deja correr las escrituras previas (candado) antes de adelantar el reloj.
  for (let i = 0; i < 20 && resolverCalls.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(resolverCalls.length, 1);
  t.mock.timers.tick(8_000);
  assert.deepEqual(await pending, { status: 200, resultado: 'en proceso' });
});

test('webhook Central One: webhook.test responde test', async () => {
  reset();
  const result = await webhooks.processCentralOneWebhook(signed({ event: 'webhook.test', event_id: 'evt_test' }));
  assert.deepEqual(result, { status: 200, resultado: 'test' });
});

test('webhook Central One: balance.low avisa al equipo una vez por hora', async () => {
  reset();
  const first = await webhooks.processCentralOneWebhook(
    signed({ event: 'balance.low', event_id: 'evt_bal_1', balance: { available: '4.5000', threshold: '10.0000' } })
  );
  assert.equal(first.resultado, 'saldo bajo');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'low_balance');
  assert.equal(alerts[0].severity, 'warning');
  assert.match(alerts[0].body, /\$4\.50/);

  const second = await webhooks.processCentralOneWebhook(
    signed({ event: 'balance.low', event_id: 'evt_bal_2', balance: { available: '1.0000' } })
  );
  assert.equal(second.status, 200);
  assert.equal(alerts.length, 1, 'el segundo aviso dentro de la hora no repite la alerta');
});

// ---------------------------------------------------------------------------
// Cambios de catálogo
// ---------------------------------------------------------------------------

function seedProducts() {
  const synced = { __ts: Date.now() };
  store.set('games/co-topup-free-fire-latam', { name: 'Free Fire', productCount: 3, minPriceUsd: 0.5 });
  store.set('products/co-topup-free-fire-latam--p100', {
    gameId: 'co-topup-free-fire-latam', provider: 'centralone', providerOfferId: 'p100',
    providerSyncedAt: synced, costUsd: 1, priceUsd: 1.2, stock: null, active: true,
  });
  store.set('products/co-topup-free-fire-latam--p200', {
    gameId: 'co-topup-free-fire-latam', provider: 'centralone', providerOfferId: 'p200',
    providerSyncedAt: synced, costUsd: 2, priceUsd: 5, stock: null, active: true, priceLocked: true,
  });
  store.set('products/co-topup-free-fire-latam--p300', {
    gameId: 'co-topup-free-fire-latam', provider: 'centralone', providerOfferId: 'p300',
    providerSyncedAt: synced, costUsd: 3, priceUsd: 3.6, stock: 0, active: false,
  });
  // Extra de Free Fire en un juego de Inefable: el webhook no lo toca.
  store.set('products/free-fire--co-p100', {
    gameId: 'free-fire', provider: 'centralone', providerOfferId: 'p100',
    centralOneExtra: true, costUsd: 1, priceUsd: 1.5, stock: null, active: true,
  });
}

test('webhook Central One: product.price_changed sigue el costo y aplica el margen salvo precio fijado', async () => {
  reset();
  seedProducts();
  const result = await webhooks.processCentralOneWebhook(
    signed({
      event: 'product.price_changed',
      event_id: 'evt_price_1',
      occurred_at: '2026-11-02T10:00:00Z',
      products: [
        { product_id: 'p100', reseller_price: '2.0000' },
        { product_id: 'p200', reseller_price: '3.0000' },
      ],
    })
  );
  assert.equal(result.status, 200);
  assert.match(result.resultado, /^2 ofertas actualizadas/);

  const p100 = store.get('products/co-topup-free-fire-latam--p100');
  assert.equal(p100.costUsd, 2);
  assert.equal(p100.priceUsd, 2.4, 'costo 2 + 20 % redondeado a 0.05');
  assert.equal(p100.providerPriceEventAt, '2026-11-02T10:00:00Z');
  assert.equal(p100.providerStockEventAt, undefined, 'un aviso de precio no adelanta el reloj del stock');

  const p200 = store.get('products/co-topup-free-fire-latam--p200');
  assert.equal(p200.costUsd, 3);
  assert.equal(p200.priceUsd, 5, 'el precio fijado por el admin no se toca');

  const extra = store.get('products/free-fire--co-p100');
  assert.equal(extra.costUsd, 1, 'los extras de juegos Inefable no se tocan');
  assert.equal(extra.priceUsd, 1.5);

  const game = store.get('games/co-topup-free-fire-latam');
  assert.equal(game.productCount, 2);
  assert.equal(game.minPriceUsd, 2.4);

  // Un aviso más viejo que llega después no pisa al nuevo.
  const late = await webhooks.processCentralOneWebhook(
    signed({
      event: 'product.price_changed',
      event_id: 'evt_price_0',
      occurred_at: '2026-11-02T09:00:00Z',
      products: [{ product_id: 'p100', reseller_price: '1.0000' }],
    })
  );
  assert.match(late.resultado, /1 avisos atrasados/);
  assert.equal(store.get('products/co-topup-free-fire-latam--p100').costUsd, 2);
});

test('webhook Central One: product.stock_changed apaga agotados, reenciende repuestos y retira lo que sale del catálogo', async () => {
  reset();
  seedProducts();
  store.set('products/co-topup-free-fire-latam--p400', {
    gameId: 'co-topup-free-fire-latam', provider: 'centralone', providerOfferId: 'p400',
    providerSyncedAt: { __ts: 1 }, costUsd: 4, priceUsd: 4.8, stock: 0, active: false, adminDisabled: true,
  });
  await webhooks.processCentralOneWebhook(
    signed({
      event: 'product.stock_changed',
      event_id: 'evt_stock_1',
      products: [
        { product_id: 'p100', in_stock: false },
        { product_id: 'p300', in_stock: true, available_stock: 12 },
        { product_id: 'p200', in_catalog: false },
        { product_id: 'p400', in_stock: true, available_stock: 5 },
      ],
    })
  );
  const p100 = store.get('products/co-topup-free-fire-latam--p100');
  assert.equal(p100.stock, 0);
  assert.equal(p100.active, false);

  const p300 = store.get('products/co-topup-free-fire-latam--p300');
  assert.equal(p300.stock, 12);
  assert.equal(p300.active, true, 'estaba apagada sólo por agotada');

  const p200 = store.get('products/co-topup-free-fire-latam--p200');
  assert.equal(p200.active, false);
  assert.equal(p200.providerRemoved, true);

  const p400 = store.get('products/co-topup-free-fire-latam--p400');
  assert.equal(p400.stock, 5);
  assert.equal(p400.active, false, 'la apagó el admin: sigue apagada');

  assert.equal(store.get('products/free-fire--co-p100').active, true);
});

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

test('resolveEventIdentity / webhookEventDocId / stockFromChange', () => {
  assert.deepEqual(
    webhooks.resolveEventIdentity({ event: 'order.completed', event_id: 'e1' }, { event: null, eventId: 'e1' }),
    { event: 'order.completed', eventId: 'e1', mismatch: false }
  );
  assert.equal(
    webhooks.resolveEventIdentity({ event_id: 'e1' }, { eventId: 'e2' }).mismatch,
    true
  );
  assert.equal(webhooks.webhookEventDocId(' evt/a/b '), 'evt_a_b');
  assert.equal(webhooks.webhookEventDocId('x'.repeat(300)).length, 200);
  assert.equal(webhooks.stockFromChange({ in_stock: false, available_stock: 9 }), 0);
  assert.equal(webhooks.stockFromChange({ available_stock: 3.7 }), 3);
  assert.equal(webhooks.stockFromChange({ in_stock: true }), null);
  assert.equal(webhooks.stockFromChange({}), undefined);
});

test('productPatchFromChange: precio fijado se respeta salvo que el costo lo supere', () => {
  const price = (cost) => Math.round(cost * 1.2 * 100) / 100;
  const base = { costUsd: 2, priceUsd: 5, stock: null, active: true, priceLocked: true };
  assert.deepEqual(webhooks.productPatchFromChange(base, { reseller_price: '3' }, price), {
    patch: { costUsd: 3 },
    lossGuard: false,
  });
  assert.deepEqual(webhooks.productPatchFromChange(base, { reseller_price: '6' }, price), {
    patch: { costUsd: 6, priceUsd: 7.2 },
    lossGuard: true,
  });
  assert.deepEqual(webhooks.productPatchFromChange({ ...base, priceLocked: false }, { reseller_price: '2' }, price), {
    patch: { priceUsd: 2.4 },
    lossGuard: false,
  });
});

test('webhook Central One: precio y stock llevan relojes separados', async () => {
  reset();
  seedProducts();
  // Llega primero un stock_changed más nuevo…
  await webhooks.processCentralOneWebhook(
    signed({
      event: 'product.stock_changed',
      event_id: 'evt_clock_stock',
      occurred_at: '2026-11-02T10:10:00Z',
      products: [{ product_id: 'p100', in_stock: true, available_stock: 9 }],
    })
  );
  // …y después el price_changed de antes, reintentado por Central One.
  const late = await webhooks.processCentralOneWebhook(
    signed({
      event: 'product.price_changed',
      event_id: 'evt_clock_price',
      occurred_at: '2026-11-02T10:05:00Z',
      products: [{ product_id: 'p100', reseller_price: '1.4000' }],
    })
  );
  assert.match(late.resultado, /^1 ofertas actualizadas$/);
  const p100 = store.get('products/co-topup-free-fire-latam--p100');
  assert.equal(p100.costUsd, 1.4, 'la subida de costo no se pierde');
  assert.equal(p100.stock, 9);
  assert.equal(p100.providerStockEventAt, '2026-11-02T10:10:00Z');
  assert.equal(p100.providerPriceEventAt, '2026-11-02T10:05:00Z');
});

test('webhook Central One: un aviso anterior a la última escritura de la sync no la pisa', async () => {
  reset();
  seedProducts();
  const p = store.get('products/co-topup-free-fire-latam--p100');
  store.set('products/co-topup-free-fire-latam--p100', {
    ...p,
    costUsd: 1.5,
    priceUsd: 1.8,
    providerSyncedAt: '2026-11-02T10:30:00Z',
  });
  const result = await webhooks.processCentralOneWebhook(
    signed({
      event: 'product.price_changed',
      event_id: 'evt_before_sync',
      occurred_at: '2026-11-02T10:05:00Z',
      products: [{ product_id: 'p100', reseller_price: '1.0000' }],
    })
  );
  assert.match(result.resultado, /1 avisos atrasados/);
  assert.equal(store.get('products/co-topup-free-fire-latam--p100').costUsd, 1.5);
});

test('webhook Central One: avisa si un extra de Free Fire queda a pérdida (sin tocarlo)', async () => {
  reset();
  seedProducts();
  // Otro extra con la misma oferta (el aviso se limita a uno por hora y extra,
  // y `free-fire--co-p100` ya se avisó en una prueba anterior).
  store.set('products/freefire-id--co-p100', {
    gameId: 'freefire-id', provider: 'centralone', providerOfferId: 'p100',
    centralOneExtra: true, costUsd: 1, priceUsd: 1.5, stock: null, active: true,
    calls: [{ packageId: 'p100', quantity: 1, provider: 'centralone' }],
  });
  await webhooks.processCentralOneWebhook(
    signed({
      event: 'product.price_changed',
      event_id: 'evt_extra_loss',
      occurred_at: '2026-11-02T11:00:00Z',
      products: [{ product_id: 'p100', reseller_price: '1.6000' }],
    })
  );
  const extra = store.get('products/freefire-id--co-p100');
  assert.equal(extra.costUsd, 1, 'el extra no se reprecia solo');
  assert.equal(extra.priceUsd, 1.5);
  const alert = alerts.find((item) => item.title === 'Revisa extras de Free Fire');
  assert.ok(alert, 'se avisa al equipo');
  assert.match(alert.body, /freefire-id--co-p100/);
});

test('freshProductChange / extraChangeProblem', () => {
  const change = { product_id: 'x', reseller_price: '2', in_stock: false };
  const both = webhooks.freshProductChange(change, { priceEventAt: '2026-11-02T10:00:00Z' }, '2026-11-02T09:00:00Z');
  assert.equal(both.price, 'stale');
  assert.equal(both.stock, 'fresh');
  assert.deepEqual(both.change, { product_id: 'x', in_stock: false });
  const synced = webhooks.freshProductChange(change, { syncedAt: '2026-11-02T10:00:00Z' }, '2026-11-02T09:00:00Z');
  assert.equal(synced.price, 'stale');
  assert.equal(synced.stock, 'stale');
  const none = webhooks.freshProductChange({ product_id: 'x' }, {}, null);
  assert.equal(none.price, 'absent');
  assert.equal(none.stock, 'absent');

  const extra = { priceUsd: 1.5, active: true, calls: [{ packageId: 'x' }] };
  assert.match(webhooks.extraChangeProblem(extra, { reseller_price: '1.5' }), /Central One cobra/);
  assert.equal(webhooks.extraChangeProblem(extra, { reseller_price: '1.2' }), null);
  assert.match(webhooks.extraChangeProblem(extra, { in_catalog: false }), /retiró/);
  assert.equal(webhooks.extraChangeProblem({ ...extra, active: false }, { in_catalog: false }), null);
  assert.equal(
    webhooks.extraChangeProblem({ ...extra, calls: [{ packageId: 'a' }, { packageId: 'b' }] }, { reseller_price: '9' }),
    null
  );
});
