const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { Timestamp } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// Firestore no hace falta aquí (el cliente sólo lo usa en la caché de
// validación), pero el módulo lo importa: se sustituye por un doble vacío para
// no inicializar el Admin SDK.
// ---------------------------------------------------------------------------
const mockDb = {
  collection: () => ({ doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }) }),
};

const firebaseModulePath = path.resolve(__dirname, '../lib/config/firebase.js');
require.cache[firebaseModulePath] = {
  id: firebaseModulePath,
  filename: firebaseModulePath,
  loaded: true,
  exports: {
    db: mockDb,
    COLLECTIONS: { playerIdCache: 'playerIdCache' },
    now: () => Timestamp.now(),
    playerIdCache: () => mockDb.collection('playerIdCache'),
  },
};

process.env.CENTRAL_ONE_API_KEY = 'co_live_test_client_key';
process.env.CENTRAL_ONE_BASE_URL = 'https://portal.centraloneglobal.com/api/v1';

const centralOne = require('../lib/services/centralOne.js');
const { stripCodes } = require('../lib/lib/logger.js');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

test('verifyWebhookSignature: firma HMAC de "timestamp.cuerpo" con ventana de 5 minutos', async (t) => {
  const secret = 'whsec_prueba';
  const body = JSON.stringify({ event: 'order.completed', event_id: 'evt_1' });
  const ts = 1_800_000_000;
  const sign = (s, timestamp, raw) =>
    'sha256=' + createHmac('sha256', s).update(`${timestamp}.${raw}`).digest('hex');

  await t.test('acepta una firma válida (Buffer y string)', () => {
    const headers = {
      'x-centralone-timestamp': String(ts),
      'x-centralone-signature': sign(secret, ts, body),
    };
    assert.deepEqual(centralOne.verifyWebhookSignature(Buffer.from(body), headers, secret, ts + 10), { ok: true });
    assert.deepEqual(centralOne.verifyWebhookSignature(body, headers, secret, ts - 10), { ok: true });
  });

  await t.test('las cabeceras no distinguen mayúsculas', () => {
    const headers = {
      'X-CentralOne-Timestamp': String(ts),
      'X-CentralOne-Signature': sign(secret, ts, body),
    };
    assert.deepEqual(centralOne.verifyWebhookSignature(body, headers, secret, ts), { ok: true });
  });

  await t.test('acepta la firma con el secreto anterior durante una rotación', () => {
    const headers = {
      'x-centralone-timestamp': String(ts),
      'x-centralone-signature': sign('whsec_nuevo', ts, body),
      'x-centralone-signature-previous': sign(secret, ts, body),
    };
    assert.deepEqual(centralOne.verifyWebhookSignature(body, headers, secret, ts), { ok: true });
  });

  await t.test('rechaza cuerpo vacío, falta de firma, timestamp viejo y firma mala', () => {
    const good = {
      'x-centralone-timestamp': String(ts),
      'x-centralone-signature': sign(secret, ts, body),
    };
    assert.deepEqual(centralOne.verifyWebhookSignature('', good, secret, ts), { ok: false, reason: 'no_body' });
    assert.deepEqual(
      centralOne.verifyWebhookSignature(body, { 'x-centralone-timestamp': String(ts) }, secret, ts),
      { ok: false, reason: 'no_signature' }
    );
    assert.deepEqual(centralOne.verifyWebhookSignature(body, good, secret, ts + 301), { ok: false, reason: 'stale' });
    assert.deepEqual(
      centralOne.verifyWebhookSignature(body + ' ', good, secret, ts),
      { ok: false, reason: 'bad_signature' }
    );
    assert.deepEqual(
      centralOne.verifyWebhookSignature(body, good, 'otro_secreto', ts),
      { ok: false, reason: 'bad_signature' }
    );
  });
});

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

test('parseAmount: texto con 4 decimales → número redondeado a 4', () => {
  assert.equal(centralOne.parseAmount('12.3400'), 12.34);
  assert.equal(centralOne.parseAmount('0.98765'), 0.9877);
  assert.equal(centralOne.parseAmount(3), 3);
  assert.equal(centralOne.parseAmount(''), null);
  assert.equal(centralOne.parseAmount(null), null);
  assert.equal(centralOne.parseAmount(undefined), null);
  assert.equal(centralOne.parseAmount('abc'), null);
});

test('buildTargetPayloadFromFields: claves exactas, respaldo por posición y sin vacíos', () => {
  assert.deepEqual(
    centralOne.buildTargetPayloadFromFields(['game_user_id'], { game_user_id: ' 12345 ' }, { playerId: '999' }),
    { game_user_id: '12345' }
  );
  // Sin valor propio: 1ª clave ← playerId, 2ª ← playerId2.
  assert.deepEqual(
    centralOne.buildTargetPayloadFromFields(['player_id', 'server_id'], {}, { playerId: '111', playerId2: '2201' }),
    { player_id: '111', server_id: '2201' }
  );
  // Un valor vacío cae al respaldo; la 3ª clave no tiene respaldo y se omite.
  assert.deepEqual(
    centralOne.buildTargetPayloadFromFields(['player_id', 'zone_id', 'riot_id'], { player_id: '  ' }, { playerId: '42' }),
    { player_id: '42' }
  );
  // Gift card: sin claves no hay payload.
  assert.deepEqual(centralOne.buildTargetPayloadFromFields([], { player_id: '1' }, { playerId: '1' }), {});
});

test('orderCodeFromIdempotencyKey: reconoce las llaves del despacho', () => {
  assert.equal(centralOne.orderCodeFromIdempotencyKey('RF-8K3M2Q-1'), 'RF-8K3M2Q');
  assert.equal(centralOne.orderCodeFromIdempotencyKey('RF-8K3M2Q-2-r3'), 'RF-8K3M2Q');
  assert.equal(centralOne.orderCodeFromIdempotencyKey('RF-8K3M2Q'), 'RF-8K3M2Q');
  assert.equal(centralOne.orderCodeFromIdempotencyKey('rf-8k3m2q-1'), 'RF-8K3M2Q');
  assert.equal(centralOne.orderCodeFromIdempotencyKey('EX-8K3M2Q-1'), null);
  assert.equal(centralOne.orderCodeFromIdempotencyKey('RF-8K3M-1'), null);
  assert.equal(centralOne.orderCodeFromIdempotencyKey(''), null);
});

test('isAmbiguousCreateFailure: sólo un rechazo confirmado permite cambiar de llave', () => {
  const base = {
    success: false,
    httpStatus: 400,
    orderId: null,
    referenceCode: null,
    status: 'failed',
    totalSaleAmount: null,
    currency: null,
    errorMessage: null,
    failureCode: 'invalid_request',
    failureAction: null,
    raw: {},
  };
  const amb = (patch) => centralOne.isAmbiguousCreateFailure({ ...base, ...patch });

  assert.equal(amb({}), false, '400 de validación es un rechazo definitivo');
  assert.equal(amb({ success: true, httpStatus: 201, status: 'confirmed', failureCode: null }), false);
  assert.equal(amb({ httpStatus: 504, status: 'network_error', failureCode: 'timeout' }), true);
  assert.equal(amb({ httpStatus: 0, status: null, failureCode: 'network_error' }), true);
  assert.equal(amb({ httpStatus: 503, status: 'ambiguous', failureCode: 'service_unavailable' }), true);
  assert.equal(amb({ httpStatus: 502, failureCode: 'http_502' }), true);
  assert.equal(amb({ httpStatus: 429, failureCode: 'rate_limited' }), true);
  assert.equal(amb({ httpStatus: 409, failureCode: 'conflict' }), true);
  assert.equal(amb({ httpStatus: 422, failureCode: 'idempotency_key_reused' }), true);
  assert.equal(amb({ httpStatus: 409, failureCode: 'insufficient_balance' }), false);
  assert.equal(amb({ httpStatus: 409, failureCode: 'insufficient_stock' }), false);
  assert.equal(amb({ httpStatus: 500, status: null, failureCode: 'missing_config' }), false, 'sin llave no salió nada');
});

test('stripCodes: quita los códigos entregados pero conserva el código de error', () => {
  const clean = stripCodes({
    error: { code: 'insufficient_balance' },
    order: { items: [{ status: 'completed', codes: ['AAAA-BBBB'], code: 'X1' }] },
    pin: '1234',
  });
  assert.equal(clean.error.code, 'insufficient_balance');
  assert.equal(clean.order.items[0].status, 'completed');
  assert.ok(!JSON.stringify(clean).includes('AAAA-BBBB'));
  assert.ok(!JSON.stringify(clean).includes('X1'));
  assert.ok(!JSON.stringify(clean).includes('1234'));
});

// ---------------------------------------------------------------------------
// Llamadas HTTP con fetch simulado
// ---------------------------------------------------------------------------

test('Central One cliente HTTP', async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  let handler = null;

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (!handler) throw new Error('handler no configurado');
    return handler(url, options);
  };

  t.after(() => {
    global.fetch = originalFetch;
  });
  t.beforeEach(() => {
    calls.length = 0;
    handler = null;
  });

  const getOrderWith = async (order) => {
    handler = async () => jsonResponse(200, { order });
    return centralOne.getOrder('co-order-1');
  };

  await t.test('getOrder: todas las líneas completed → éxito con deliveredCount', async () => {
    const res = await getOrderWith({
      id: 'co-order-1',
      reference_code: 'CO-REF-1',
      status: 'completed',
      items: [
        { status: 'completed', delivered_count: 1, total_sale_price: '5.0000', codes: ['SECRETO-1'] },
        { status: 'completed', delivered_count: 2, total_sale_price: '1.2500' },
      ],
    });
    assert.equal(res.found, true);
    assert.equal(res.isSuccess, true);
    assert.equal(res.isPending, false);
    assert.equal(res.isFailed, false);
    assert.equal(res.deliveredCount, 3);
    assert.equal(res.totalSalePrice, 6.25);
    assert.equal(res.referenceCode, 'CO-REF-1');
    assert.ok(!JSON.stringify(res.raw).includes('SECRETO-1'), 'raw nunca lleva códigos');
    assert.match(calls[0].url, /\/orders\/co-order-1$/);
  });

  await t.test('getOrder: una línea entregada y otra en curso → pendiente (no éxito)', async () => {
    const res = await getOrderWith({
      status: 'processing',
      items: [{ status: 'completed' }, { status: 'processing' }],
    });
    assert.equal(res.isSuccess, false);
    assert.equal(res.isPending, true);
    assert.equal(res.isFailed, false);
    assert.equal(res.lineStatus, 'processing');
  });

  await t.test('getOrder: una línea falló y ninguna sigue en curso → fallo con motivo', async () => {
    const res = await getOrderWith({
      status: 'partially_completed',
      items: [
        { status: 'completed' },
        { status: 'failed', failure: { code: 'invalid_player', action: 'fix_and_retry' } },
      ],
    });
    assert.equal(res.isFailed, true);
    assert.equal(res.isPending, false);
    assert.equal(res.isSuccess, false);
    assert.equal(res.lineStatus, 'failed');
    assert.equal(res.failureCode, 'invalid_player');
    assert.equal(res.failureAction, 'fix_and_retry');
    assert.match(res.failureMessage, /inválido/);
  });

  await t.test('getOrder: un fallo y otra línea aún en curso sigue pendiente', async () => {
    const res = await getOrderWith({ items: [{ status: 'refunded' }, { status: 'reserved' }] });
    assert.equal(res.isFailed, false);
    assert.equal(res.isPending, true);
  });

  await t.test('getOrder: estado desconocido cuenta como en curso', async () => {
    const res = await getOrderWith({ status: 'on_hold_by_supplier', items: [{ status: 'on_hold_by_supplier' }] });
    assert.equal(res.isPending, true);
    assert.equal(res.isFailed, false);
    assert.equal(res.isSuccess, false);
  });

  await t.test('getOrder: canceled (ortografía americana) también es fallo', async () => {
    const res = await getOrderWith({ items: [{ status: 'canceled' }] });
    assert.equal(res.isFailed, true);
    assert.equal(res.failureCode, 'canceled');
  });

  await t.test('getOrder: sin líneas decide el estado del pedido', async () => {
    assert.equal((await getOrderWith({ status: 'completed' })).isSuccess, true);
    assert.equal((await getOrderWith({ status: 'cancelled' })).isFailed, true);
    assert.equal((await getOrderWith({ status: 'created' })).isPending, true);
  });

  await t.test('createOrder: 5xx se reintenta con la MISMA llave y queda ambiguous', async () => {
    handler = async () => jsonResponse(503, { error: { code: 'service_unavailable', message: 'mantenimiento' } });
    const res = await centralOne.createOrder({
      catalogItemId: 'item-1',
      quantity: 1,
      targetPayload: { player_id: '123' },
      idempotencyKey: 'RF-8K3M2Q-1',
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.headers['Idempotency-Key'], 'RF-8K3M2Q-1');
    assert.equal(calls[1].options.headers['Idempotency-Key'], 'RF-8K3M2Q-1');
    assert.equal(res.success, false);
    assert.equal(res.status, 'ambiguous');
    assert.equal(res.failureCode, 'service_unavailable');
    assert.equal(centralOne.isAmbiguousCreateFailure(res), true);
  });

  await t.test('createOrder: insufficient_balance es failed con ese código y no se reintenta', async () => {
    handler = async () => jsonResponse(409, { error: { code: 'insufficient_balance', message: 'sin saldo' } });
    const res = await centralOne.createOrder({
      catalogItemId: 'item-1',
      quantity: 1,
      targetPayload: { player_id: '123' },
      idempotencyKey: 'RF-8K3M2Q-1',
    });
    assert.equal(calls.length, 1);
    assert.equal(res.status, 'failed');
    assert.equal(res.failureCode, 'insufficient_balance');
    assert.equal(centralOne.isAmbiguousCreateFailure(res), false);
  });

  await t.test('createOrder: gift card sin datos no manda target_payload', async () => {
    handler = async () => jsonResponse(201, { order: { id: 'o-1', status: 'confirmed', total_sale_amount: '10.0000' } });
    const res = await centralOne.createOrder({
      catalogItemId: 'gift-1',
      quantity: 1,
      targetPayload: {},
      idempotencyKey: 'RF-8K3M2Q-1',
    });
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(sent.items[0].target_payload, undefined);
    assert.equal(res.success, true);
    assert.equal(res.totalSaleAmount, 10);
  });

  await t.test('getOrderCodes: devuelve códigos por línea; 403 explica el permiso codes:read', async () => {
    handler = async () =>
      jsonResponse(200, {
        order: {
          items: [
            { product_name: 'Google Play 10 USD', codes: ['AAAA-1111', ' '] },
            { product_name: 'Steam 5 USD', codes: [{ code: 'BBBB-2222' }] },
          ],
        },
      });
    const ok = await centralOne.getOrderCodes('o-1');
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.codes, ['AAAA-1111', 'BBBB-2222']);
    assert.deepEqual(ok.items[0], { label: 'Google Play 10 USD', code: 'AAAA-1111' });
    assert.match(calls[0].url, /\/orders\/o-1\/codes$/);

    calls.length = 0;
    handler = async () => jsonResponse(403, { error: { code: 'insufficient_scope', message: 'missing codes:read' } });
    const denied = await centralOne.getOrderCodes('o-1');
    assert.equal(denied.ok, false);
    assert.equal(denied.httpStatus, 403);
    assert.match(denied.message, /codes:read/);
  });

  await t.test('getBalance y getCatalog interpretan la respuesta', async () => {
    handler = async () =>
      jsonResponse(200, { available_balance: '25.5000', held_balance: '1.2500', total_balance: '26.7500', currency: 'USD' });
    const balance = await centralOne.getBalance();
    assert.deepEqual(balance, {
      ok: true,
      balance: { availableUsd: 25.5, heldUsd: 1.25, totalUsd: 26.75, currency: 'USD' },
    });

    handler = async () => jsonResponse(200, { items: [{ product_id: 'p-1', reseller_price: '1.0000' }, null] });
    const catalog = await centralOne.getCatalog();
    assert.equal(catalog.ok, true);
    assert.equal(catalog.items.length, 1);

    handler = async () => jsonResponse(200, { nada: true });
    const bad = await centralOne.getCatalog();
    assert.equal(bad.ok, false);
  });

  await t.test('getCoverage devuelve el conjunto de product_id', async () => {
    handler = async () => jsonResponse(200, { games: [], products: [{ product_id: 'p-1' }, { product_id: 'p-2' }] });
    const res = await centralOne.getCoverage();
    assert.equal(res.ok, true);
    assert.deepEqual([...res.productIds].sort(), ['p-1', 'p-2']);
  });
});
