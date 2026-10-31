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
          });
          if (limitCount && docs.length >= limitCount) break;
        }
      }
      return {
        empty: docs.length === 0,
        size: docs.length,
        docs,
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
      const tx = {
        get: async (ref) => makeSnap(ref.path),
        set: (ref, data, options) => ref.set(data, options),
        update: (ref, data) => ref.update(data),
      };
      return fn(tx);
    });
    txChain = run.catch(() => {});
    return run;
  },
};

// ---------------------------------------------------------------------------
// Stub modules in require.cache BEFORE requiring services
// ---------------------------------------------------------------------------
const sentMessages = [];
const editedMessages = [];
const answeredCallbacks = [];

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
      paymentRefs: 'paymentRefs',
      config: 'config',
    },
    orders: () => makeCollectionRef('orders'),
    paymentRefs: () => makeCollectionRef('paymentRefs'),
    now: () => Timestamp.now(),
  },
};

const fetchJsonPath = path.resolve(__dirname, '../lib/lib/fetchJson.js');
require.cache[fetchJsonPath] = {
  id: fetchJsonPath,
  filename: fetchJsonPath,
  loaded: true,
  exports: {
    fetchJson: async (url, opts) => {
      if (url.includes('/sendMessage')) {
        sentMessages.push(opts.body);
        return { ok: true, status: 200, data: { ok: true } };
      }
      if (url.includes('/editMessageText')) {
        editedMessages.push(opts.body);
        return { ok: true, status: 200, data: { ok: true } };
      }
      if (url.includes('/answerCallbackQuery')) {
        answeredCallbacks.push(opts.body);
        return { ok: true, status: 200, data: { ok: true } };
      }
      return { ok: true, status: 200, data: {} };
    },
  },
};

const settingsServicePath = path.resolve(__dirname, '../lib/services/settings.js');
process.env.TELEGRAM_SUPPORT_BOT_TOKEN = '123456:TEST_SUPPORT_TOKEN';

const mockConfig = {
  storeName: 'Refill Store Test',
  bank: {
    name: 'Banco de Venezuela',
    code: '0102',
    phone: '0412-2686326',
    idNumber: 'V-31.955.598',
    holder: 'Refill Store C.A.',
  },
  alerts: {
    telegramChatId: '999888777', // Admin Telegram Chat ID
  },
};

require.cache[settingsServicePath] = {
  id: settingsServicePath,
  filename: settingsServicePath,
  loaded: true,
  exports: {
    getConfig: async () => mockConfig,
  },
};

let lastDispatchedOrderId = null;
let lastProviderSyncOrderId = null;
let lastCompletedOrderId = null;

const dispatchServicePath = path.resolve(__dirname, '../lib/services/dispatch.js');
require.cache[dispatchServicePath] = {
  id: dispatchServicePath,
  filename: dispatchServicePath,
  loaded: true,
  exports: {
    dispatchOrder: async (orderId, opts) => {
      lastDispatchedOrderId = orderId;
      return { status: 'completed', ok: true };
    },
    checkOrderProviderStatus: async (orderId, actor) => {
      lastProviderSyncOrderId = orderId;
      return {
        ok: true,
        orderId,
        orderStatus: 'completed',
        summary: 'Llamadas exitosas',
      };
    },
  },
};

const ordersServicePath = path.resolve(__dirname, '../lib/services/orders.js');
require.cache[ordersServicePath] = {
  id: ordersServicePath,
  filename: ordersServicePath,
  loaded: true,
  exports: {
    markCompleted: async (actor, orderId, note) => {
      lastCompletedOrderId = orderId;
      const ord = store.get(`orders/${orderId}`) || {};
      const updated = { ...ord, status: 'completed', estado: 'COMPLETADO' };
      store.set(`orders/${orderId}`, updated);
      return { id: orderId, ...updated };
    },
  },
};

// Import module under test
const {
  handleTelegramSupportWebhook,
  findOrder,
  isTelegramAdmin,
  resolveSupportBotToken,
} = require('../lib/services/telegramSupportBot.js');

test('1. resolveSupportBotToken & isTelegramAdmin', async () => {
  const token = await resolveSupportBotToken();
  assert.equal(token, '123456:TEST_SUPPORT_TOKEN');

  const isAdmin1 = await isTelegramAdmin('999888777');
  assert.equal(isAdmin1, true, 'Admin chat_id debe ser reconocido');

  const isClient = await isTelegramAdmin('111222333');
  assert.equal(isClient, false, 'Cliente normal no debe ser admin');
});

test('2. /start muestra Menú Principal con Inline Keyboard', async () => {
  sentMessages.length = 0;
  await handleTelegramSupportWebhook({
    update_id: 1,
    message: {
      message_id: 10,
      chat: { id: 111222333, type: 'private' },
      date: 1700000000,
      text: '/start',
    },
  });

  assert.equal(sentMessages.length, 1);
  const msg = sentMessages[0];
  assert.equal(msg.chat_id, '111222333');
  assert.match(msg.text, /Bienvenido al Asistente de Refill Store Test/i);
  assert.ok(msg.reply_markup?.inline_keyboard?.length >= 3);
  const buttonsText = msg.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(buttonsText.some((t) => t.includes('Consultar Estado de Orden')));
  assert.ok(buttonsText.some((t) => t.includes('Métodos de Pago')));
  assert.ok(buttonsText.some((t) => t.includes('Hablar con Soporte Humano')));
});

test('3. Búsqueda de órdenes (findOrder) por código, WhatsApp displayId y referencia bancaria', async () => {
  store.set('orders/ord-rf-1', {
    code: 'RF-AAA111',
    gameName: 'Free Fire',
    productName: '100 + 10 Diamantes',
    playerId: '123456789',
    status: 'completed',
    pricing: { totalBs: 850, totalUsd: 1.0 },
    user: { displayName: 'Juan Perez', email: 'juan@test.com' },
  });

  store.set('orders/wa_007855123456', {
    displayId: 'WA-123456',
    gameName: 'Roblox',
    productName: 'Robux 800',
    playerId: 'gamer_roblox',
    status: 'awaiting_manual',
    totalBs: 2500,
    totalUsd: 3.0,
    paymentDetails: { reference: '007855123456' },
    userName: 'Carlos Gomez',
    userPhone: '+584120000000',
  });

  store.set('paymentRefs/99887766', { orderId: 'ord-rf-1' });

  // 1. Por código
  const byCode = await findOrder('RF-AAA111');
  assert.ok(byCode);
  assert.equal(byCode.id, 'ord-rf-1');

  // 2. Por código en minúsculas
  const byCodeLower = await findOrder('rf-aaa111');
  assert.ok(byCodeLower);
  assert.equal(byCodeLower.id, 'ord-rf-1');

  // 3. Por WhatsApp displayId
  const byWa = await findOrder('WA-123456');
  assert.ok(byWa);
  assert.equal(byWa.id, 'wa_007855123456');

  // 4. Por referencia en paymentRefs
  const byPref = await findOrder('99887766');
  assert.ok(byPref);
  assert.equal(byPref.id, 'ord-rf-1');

  // 5. No encontrada
  const notFound = await findOrder('RF-999999');
  assert.equal(notFound, null);
});

test('4. Consulta de Orden: Privacidad Cliente vs Admin', async () => {
  store.set('orders/ord-priv-1', {
    code: 'RF-PRIV01',
    gameName: 'Free Fire',
    productName: '520 Diamantes',
    playerId: '7674177243',
    status: 'failed',
    pricing: { totalBs: 4000, totalUsd: 4.5 },
    payment: { reference: '0012345678', method: 'Pago Móvil' },
    user: { displayName: 'Yohelvis Garcia', email: 'yohelvis@secret.com' },
    contactPhone: '+584129999999',
    dispatch: { calls: [{ packageId: 5, status: 'error' }], lastError: 'Provider error 404' },
  });

  // A. Cliente consulta la orden
  sentMessages.length = 0;
  await handleTelegramSupportWebhook({
    update_id: 10,
    message: {
      message_id: 20,
      chat: { id: 111222333, type: 'private' }, // Cliente
      date: 1700000000,
      text: 'RF-PRIV01',
    },
  });

  assert.equal(sentMessages.length, 2); // 1: Buscando..., 2: Ficha
  const clientMsg = sentMessages[1];
  assert.match(clientMsg.text, /Detalle de tu Orden/i);
  assert.match(clientMsg.text, /RF-PRIV01/);
  assert.match(clientMsg.text, /7674177243/);
  // Privacidad estricta: NO debe incluir email ni teléfono
  assert.doesNotMatch(clientMsg.text, /yohelvis@secret\.com/);
  assert.doesNotMatch(clientMsg.text, /\+584129999999/);
  assert.doesNotMatch(clientMsg.text, /0012345678/); // Referencia privada

  // Botones de cliente (incluye Solicitar Reintento por estar fallida)
  const clientBtns = clientMsg.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(clientBtns.some((t) => t.includes('Solicitar Reintento')));
  assert.ok(!clientBtns.some((t) => t.includes('Marcar Completada')));

  // B. Admin consulta la misma orden
  sentMessages.length = 0;
  await handleTelegramSupportWebhook({
    update_id: 11,
    message: {
      message_id: 21,
      chat: { id: 999888777, type: 'private' }, // Admin
      date: 1700000000,
      text: 'RF-PRIV01',
    },
  });

  assert.equal(sentMessages.length, 2);
  const adminMsg = sentMessages[1];
  assert.match(adminMsg.text, /Ficha de Orden \(Panel Admin\)/i);
  assert.match(adminMsg.text, /Yohelvis Garcia/);
  assert.match(adminMsg.text, /yohelvis@secret\.com/);
  assert.match(adminMsg.text, /0012345678/);
  assert.match(adminMsg.text, /Provider error 404/);

  // Botones de Admin
  const adminBtns = adminMsg.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(adminBtns.some((t) => t.includes('Reintentar Despacho API')));
  assert.ok(adminBtns.some((t) => t.includes('Marcar Completada')));
  assert.ok(adminBtns.some((t) => t.includes('Sincronizar Proveedor')));
});

test('5. Acciones exclusivas de Admin: Reintentar, Completar y Sincronizar', async () => {
  lastDispatchedOrderId = null;
  lastCompletedOrderId = null;
  lastProviderSyncOrderId = null;
  sentMessages.length = 0;
  answeredCallbacks.length = 0;

  // No-admin intentando acción admin: rechazo
  await handleTelegramSupportWebhook({
    update_id: 30,
    callback_query: {
      id: 'cb-1',
      from: { id: 111222333, is_bot: false }, // Cliente
      message: { message_id: 50, chat: { id: 111222333 } },
      data: 'adm_comp_ord-priv-1',
    },
  });

  assert.equal(answeredCallbacks.length, 1);
  assert.match(answeredCallbacks[0].text, /exclusiva de Administrador/i);
  assert.equal(lastCompletedOrderId, null);

  // Admin ejecutando Completar Orden
  await handleTelegramSupportWebhook({
    update_id: 31,
    callback_query: {
      id: 'cb-2',
      from: { id: 999888777, is_bot: false }, // Admin
      message: { message_id: 51, chat: { id: 999888777 } },
      data: 'adm_comp_ord-priv-1',
    },
  });

  assert.equal(lastCompletedOrderId, 'ord-priv-1');
  const compConfirmMsg = sentMessages.find((m) => m.text?.includes('marcada como COMPLETADA'));
  assert.ok(compConfirmMsg);

  // Admin ejecutando Reintentar Despacho
  await handleTelegramSupportWebhook({
    update_id: 32,
    callback_query: {
      id: 'cb-3',
      from: { id: 999888777, is_bot: false }, // Admin
      message: { message_id: 52, chat: { id: 999888777 } },
      data: 'adm_retry_ord-priv-1',
    },
  });

  assert.equal(lastDispatchedOrderId, 'ord-priv-1');

  // Admin ejecutando Sincronizar Proveedor
  await handleTelegramSupportWebhook({
    update_id: 33,
    callback_query: {
      id: 'cb-4',
      from: { id: 999888777, is_bot: false }, // Admin
      message: { message_id: 53, chat: { id: 999888777 } },
      data: 'adm_sync_ord-priv-1',
    },
  });

  assert.equal(lastProviderSyncOrderId, 'ord-priv-1');
});

test('6. Cliente: Rate-limit de 5 minutos en Solicitar Reintento', async () => {
  lastDispatchedOrderId = null;
  answeredCallbacks.length = 0;

  // Primer reintento
  await handleTelegramSupportWebhook({
    update_id: 40,
    callback_query: {
      id: 'cb-cli-1',
      from: { id: 111222333, is_bot: false },
      message: { message_id: 60, chat: { id: 111222333 } },
      data: 'cli_retry_ord-priv-1',
    },
  });

  assert.equal(lastDispatchedOrderId, 'ord-priv-1');

  // Segundo reintento inmediato (debe ser bloqueado por rate-limit)
  lastDispatchedOrderId = null;
  await handleTelegramSupportWebhook({
    update_id: 41,
    callback_query: {
      id: 'cb-cli-2',
      from: { id: 111222333, is_bot: false },
      message: { message_id: 61, chat: { id: 111222333 } },
      data: 'cli_retry_ord-priv-1',
    },
  });

  assert.equal(lastDispatchedOrderId, null, 'No debe volver a despachar si está dentro del rate-limit');
  const alertCallback = answeredCallbacks[answeredCallbacks.length - 1];
  assert.match(alertCallback.text, /solicitaste un reintento hace poco/i);
});

test('7. FAQs: Respuestas interactivas con datos reales de la tienda', async () => {
  editedMessages.length = 0;

  // FAQ Pago Móvil (edita el mensaje del menú)
  await handleTelegramSupportWebhook({
    update_id: 50,
    callback_query: {
      id: 'cb-faq-1',
      from: { id: 111222333, is_bot: false },
      message: { message_id: 70, chat: { id: 111222333 } },
      data: 'faq_pagomovil',
    },
  });

  const pmMsg = editedMessages[editedMessages.length - 1];
  assert.ok(pmMsg);
  assert.match(pmMsg.text, /0412-2686326/);
  assert.match(pmMsg.text, /0102/);
  assert.match(pmMsg.text, /V-31\.955\.598/);
  assert.match(pmMsg.text, /Verificación Automática/i);

  // FAQ RefillCoins y Excedentes
  editedMessages.length = 0;
  await handleTelegramSupportWebhook({
    update_id: 51,
    callback_query: {
      id: 'cb-faq-2',
      from: { id: 111222333, is_bot: false },
      message: { message_id: 71, chat: { id: 111222333 } },
      data: 'faq_refillcoins',
    },
  });

  const rcMsg = editedMessages[editedMessages.length - 1];
  assert.ok(rcMsg);
  assert.match(rcMsg.text, /RefillCoins/i);
  assert.match(rcMsg.text, /Abono Automático de Excedentes/i);

  // FAQ Tiempos de entrega
  editedMessages.length = 0;
  await handleTelegramSupportWebhook({
    update_id: 52,
    callback_query: {
      id: 'cb-faq-3',
      from: { id: 111222333, is_bot: false },
      message: { message_id: 72, chat: { id: 111222333 } },
      data: 'faq_delivery',
    },
  });

  const dtMsg = editedMessages[editedMessages.length - 1];
  assert.ok(dtMsg);
  assert.match(dtMsg.text, /1 a 3 minutos/i);
  assert.match(dtMsg.text, /Roblox/i);
});

test('8. Escalamiento a Soporte Humano con alerta enriquecida al Admin', async () => {
  store.set('orders/ord-esc-1', {
    code: 'RF-ESC01',
    status: 'in_review',
    gameName: 'Free Fire',
    productName: '100 Diamantes',
    playerId: '11223344',
  });

  store.set('telegramSupportSessions/111222333', {
    chatId: '111222333',
    state: 'awaiting_support_message',
    lastOrderId: 'ord-esc-1',
    lastOrderCode: 'RF-ESC01',
  });

  sentMessages.length = 0;

  // Cliente envía su mensaje de reclamo
  await handleTelegramSupportWebhook({
    update_id: 60,
    message: {
      message_id: 80,
      from: {
        id: 111222333,
        first_name: 'Daniel',
        last_name: 'Gutierrez',
        username: 'daniel_gutierrez',
      },
      chat: { id: 111222333, type: 'private' },
      date: 1700000000,
      text: 'Hola, mi recarga de Free Fire aún no cae y ya pasaron 10 minutos',
    },
  });

  // Debe haber 2 mensajes: 1 de alerta al Admin ('999888777') y 1 de confirmación al Cliente ('111222333')
  const adminAlert = sentMessages.find((m) => String(m.chat_id) === '999888777');
  const clientConfirm = sentMessages.find((m) => String(m.chat_id) === '111222333');

  assert.ok(adminAlert, 'El admin debió recibir la alerta de soporte humano');
  assert.match(adminAlert.text, /NUEVA SOLICITUD DE SOPORTE HUMANO/i);
  assert.match(adminAlert.text, /Daniel Gutierrez/);
  assert.match(adminAlert.text, /@daniel_gutierrez/);
  assert.match(adminAlert.text, /RF-ESC01/);
  assert.match(adminAlert.text, /Hola, mi recarga de Free Fire aún no cae/);

  // Botones de acción directa en la alerta del admin
  const adminAlertBtns = adminAlert.reply_markup.inline_keyboard.flat();
  const chatBtn = adminAlertBtns.find((b) => b.text.includes('Abrir Chat'));
  assert.ok(chatBtn);
  assert.equal(chatBtn.url, 'https://t.me/daniel_gutierrez');

  // Botones de orden anexados a la alerta
  assert.ok(adminAlertBtns.some((b) => b.text.includes('Reintentar Despacho')));
  assert.ok(adminAlertBtns.some((b) => b.text.includes('Marcar Completada')));
  assert.ok(adminAlertBtns.some((b) => b.text.includes('Sincronizar Proveedor')));

  // Confirmación al cliente
  assert.ok(clientConfirm);
  assert.match(clientConfirm.text, /Tu mensaje ha sido enviado a nuestro equipo/i);

  // La sesión del cliente debe quedar limpia (state: null)
  const sessionAfter = store.get('telegramSupportSessions/111222333');
  assert.equal(sessionAfter.state, null);
});
