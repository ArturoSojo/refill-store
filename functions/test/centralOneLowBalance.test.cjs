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

// Override privateCentralOneConfigDoc to point to memoryDoc
const origPrivateCentralOneConfigDoc = firebaseConfig.privateCentralOneConfigDoc;
firebaseConfig.privateCentralOneConfigDoc = () => memoryDoc;

test('Central One Low Balance Alert & Anti-Spam (Umbral < $35.00 USD)', async (t) => {
  // Reset memory
  memoryDoc.data = {};

  // 1. Cuando available_balance es 34.5000 (< 35), se dispara la alerta a Telegram
  const result1 = await adminAlerts.checkCentralOneBalance({
    availableUsd: 34.50,
    heldUsd: 2.10,
    thresholdUsd: 35.0,
  });

  assert.equal(result1.alertSent, true, 'Debe disparar la alerta cuando disponible < 35');
  assert.equal(result1.rearmed, false);
  assert.equal(result1.availableUsd, 34.50);
  assert.equal(result1.heldUsd, 2.10);
  assert.equal(result1.threshold, 35.0);
  assert.equal(memoryDoc.data.lowBalanceAlerted, true, 'Debe registrar lowBalanceAlerted: true en Firestore');

  // 2. Compras consecutivas mientras siga bajo el mismo umbral (< 35): NO debe enviar spam duplicado
  const result2 = await adminAlerts.checkCentralOneBalance({
    availableUsd: 33.80,
    heldUsd: 2.10,
    thresholdUsd: 35.0,
  });

  assert.equal(result2.alertSent, false, 'No debe disparar alerta repetida en el mismo episodio de saldo bajo');
  assert.equal(result2.rearmed, false);
  assert.equal(memoryDoc.data.lowBalanceAlerted, true);

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
    availableUsd: 29.00,
    heldUsd: 1.00,
    thresholdUsd: 35.0,
  });

  assert.equal(result4.alertSent, true, 'Debe disparar una nueva alerta una vez rearmado');
  assert.equal(memoryDoc.data.lowBalanceAlerted, true);

  // 5. checkProviderBalance con 'Central One' delega a checkCentralOneBalance
  memoryDoc.data = {};
  await adminAlerts.checkProviderBalance(30.00, 'Central One');
  assert.equal(memoryDoc.data.lowBalanceAlerted, true, 'checkProviderBalance debe haber delegado a Central One');
});
