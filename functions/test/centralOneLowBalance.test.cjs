const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Setup environment
process.env.FUNCTIONS_EMULATOR = 'true';
process.env.CENTRAL_ONE_BASE_URL = 'https://portal.centraloneglobal.com/api/v1';

const firebaseConfig = require('../lib/config/firebase');
const adminAlerts = require('../lib/services/adminAlerts');

// In-memory doc mock
const memoryDoc = {
  data: {},
  async get() {
    return {
      exists: Object.keys(this.data).length > 0,
      data: () => ({ ...this.data }),
    };
  },
  async set(update, options) {
    if (options && options.merge) {
      this.data = { ...this.data, ...update };
    } else {
      this.data = { ...update };
    }
  },
};

// In-memory adminAlerts collection mock to prevent tests from writing to production Firestore
const memoryAlerts = [];
const mockAlertsCollection = {
  async add(doc) {
    memoryAlerts.push(doc);
    return { id: `mock-alert-${memoryAlerts.length}` };
  },
  doc() {
    return {
      async set() { return {}; },
      async get() { return { exists: false, data: () => ({}) }; },
    };
  },
  where() {
    return {
      count: () => ({ async get() { return { data: () => ({ count: memoryAlerts.length }) }; } }),
      async get() {
        return {
          size: memoryAlerts.length,
          docs: memoryAlerts.map((d, i) => ({ id: `mock-${i}`, data: () => d })),
        };
      },
    };
  },
};

// Override configs to point to memory
firebaseConfig.privateCentralOneConfigDoc = () => memoryDoc;
firebaseConfig.adminAlerts = () => mockAlertsCollection;

test('Central One Low Balance Alert tras cada despacho (Umbral < $35.00 USD)', async (t) => {
  // Reset memory
  memoryDoc.data = {};
  memoryAlerts.length = 0;

  // 1. Cuando se despacha y available_balance baja a 34.00 (< 35), se dispara la alerta a Telegram
  const result1 = await adminAlerts.checkCentralOneBalance({
    availableUsd: 34.00,
    heldUsd: 2.10,
    thresholdUsd: 35.0,
    orderCode: 'RF-DESP01',
    fromDispatch: true,
  });

  assert.equal(result1.alertSent, true, 'Debe disparar la alerta cuando disponible baja de 35 en el despacho');
  assert.equal(result1.rearmed, false);
  assert.equal(result1.availableUsd, 34.00);
  assert.equal(result1.heldUsd, 2.10);
  assert.equal(result1.threshold, 35.0);
  assert.equal(memoryDoc.data.lowBalanceAlerted, true, 'Debe registrar lowBalanceAlerted: true en Firestore');
  assert.equal(memoryDoc.data.lowBalanceAvailableUsd, 34.00);

  // 2. Despacho consecutivo: de 34.00 baja a 29.00 -> VUELVE A AVISAR en Telegram
  const result2 = await adminAlerts.checkCentralOneBalance({
    availableUsd: 29.00,
    heldUsd: 2.10,
    thresholdUsd: 35.0,
    orderCode: 'RF-DESP02',
    fromDispatch: true,
  });

  assert.equal(result2.alertSent, true, 'Debe volver a alertar tras el segundo despacho si saldo queda en 29 (< 35)');
  assert.equal(result2.rearmed, false);
  assert.equal(memoryDoc.data.lowBalanceAlerted, true);
  assert.equal(memoryDoc.data.lowBalanceAvailableUsd, 29.00);

  // 2b. Consulta pasiva repetida sin despacho y con el mismo saldo exacto: NO envía spam duplicado
  const result2b = await adminAlerts.checkCentralOneBalance({
    availableUsd: 29.00,
    heldUsd: 2.10,
    thresholdUsd: 35.0,
    fromDispatch: false,
  });

  assert.equal(result2b.alertSent, false, 'No debe disparar si es consulta pasiva sin cambio de saldo ni despacho');

  // 2c. Tercer despacho consecutivo: de 29.00 baja a 24.00 -> VUELVE A AVISAR
  const result2c = await adminAlerts.checkCentralOneBalance({
    availableUsd: 24.00,
    heldUsd: 1.50,
    thresholdUsd: 35.0,
    orderCode: 'RF-DESP03',
    fromDispatch: true,
  });

  assert.equal(result2c.alertSent, true, 'Debe volver a alertar en cada despacho sucesivo con saldo < 35');
  assert.equal(memoryDoc.data.lowBalanceAvailableUsd, 24.00);

  // 3. Cuando available_balance se recupera a >= 35.0000, no dispara alerta y REARMA el estado
  const result3 = await adminAlerts.checkCentralOneBalance({
    availableUsd: 70.00,
    heldUsd: 0.00,
    thresholdUsd: 35.0,
  });

  assert.equal(result3.alertSent, false);
  assert.equal(result3.rearmed, true, 'Debe rearmar el estado a false cuando saldo >= 35');
  assert.equal(memoryDoc.data.lowBalanceAlerted, false, 'Firestore debe registrar lowBalanceAlerted: false');

  // 4. Si el saldo vuelve a bajar de 35 en el futuro, tras haber sido rearmado, dispara NUEVA alerta
  const result4 = await adminAlerts.checkCentralOneBalance({
    availableUsd: 33.00,
    heldUsd: 1.00,
    thresholdUsd: 35.0,
    fromDispatch: true,
  });

  assert.equal(result4.alertSent, true, 'Debe disparar una nueva alerta una vez rearmado');
  assert.equal(memoryDoc.data.lowBalanceAlerted, true);

  // 5. checkProviderBalance con 'Central One' delega a checkCentralOneBalance con fromDispatch: true
  memoryDoc.data = {};
  await adminAlerts.checkProviderBalance(30.00, 'Central One', 'RF-DESP05');
  assert.equal(memoryDoc.data.lowBalanceAlerted, true, 'checkProviderBalance debe haber delegado a Central One');
  assert.equal(memoryDoc.data.lowBalanceAvailableUsd, 30.00);

  // Verificar que las alertas se acumularon en memoria y no en Firestore
  assert.equal(memoryAlerts.length, 5, 'Deben haberse generado 5 alertas en el mock en memoria');
});
