const test = require('node:test');
const assert = require('node:assert/strict');
const { answerKnownSupportQuestion } = require('../lib/services/chatbotAnswers.js');

const context = {
  paymentMethods: ['Pago Móvil', 'transferencia bancaria', 'Binance Pay'],
  orderExpiryMinutes: 15,
  couponsEnabled: true,
};

const cases = [
  ['quiero recargar', 'start_recharge'],
  ['Quiero recargar Free Fire', 'start_recharge'],
  ['necesito una recarga', 'start_recharge'],
  ['quisiera comprar diamantes', 'start_recharge'],
  ['me gustaría comprar un paquete', 'start_recharge'],
  ['quiero hacer una recarga', 'start_recharge'],
  ['¿Cómo puedo recargar?', 'start_recharge'],
  ['¿Dónde puedo comprar diamantes?', 'start_recharge'],
  ['recargar', 'start_recharge'],
  ['comprar ahora', 'start_recharge'],
  ['quiero comprar una gift card', 'start_recharge'],
  ['¿Cómo puedo pagar?', 'start_recharge'],
  ['¿Cuáles son los métodos de pago?', 'start_recharge'],
  ['¿Aceptan Binance?', 'start_recharge'],
  ['¿Dónde consigo la referencia?', undefined],
  ['¿Cómo veo el número de referencia?', undefined],
  ['¿Cuál es la referencia?', undefined],
  ['¿Cuánto dura la orden?', undefined],
  ['¿Cuánto tiempo tengo para pagar?', undefined],
  ['¿Cuándo expira mi pedido?', undefined],
  ['¿Cómo uso un cupón?', undefined],
  ['¿Dónde pongo mi código de descuento?', undefined],
  ['¿Cómo aplico el cupón?', undefined],
  ['¿Dónde veo mis órdenes?', 'view_orders'],
  ['¿Cómo consulto mis pedidos?', 'view_orders'],
  ['¿Dónde están mis compras?', 'view_orders'],
  ['¿Qué pasa si pago de menos?', undefined],
  ['¿Puedo pagar por partes?', undefined],
  ['Pagué menos, ¿qué hago?', undefined],
  ['¿Qué pasa si pago de más?', undefined],
  ['¿Cómo funcionan los niveles?', undefined],
  ['¿Cómo subo de nivel?', undefined],
  ['¿Qué es el descuento por nivel?', undefined],
];

for (const [question, expectedAction] of cases) {
  test(`autoservicio: ${question}`, () => {
    const result = answerKnownSupportQuestion(question, context);
    assert.ok(result, `No reconoció «${question}»`);
    assert.equal(result.needsSupport, false);
    assert.equal(result.action, expectedAction);
    assert.ok(result.reply.length > 35);
    assert.doesNotMatch(result.reply, /contacta(?:r)? (?:a )?soporte|agente humano/i);
  });
}

const individualCases = [
  'quiero recargar pero no me deja',
  'quiero comprar, me sale error al pagar',
  'quiero recargar, ya pagué y no llegó',
  'no quiero recargar',
  'mi orden RF-ABC123 aparece rechazada',
  'mi recarga no llegó',
  'pagué pero la referencia sale usada',
  'mi cupón no funciona',
  'no puedo pagar con Binance',
  'quiero cancelar mi orden',
  '¿Cuánto cuesta el paquete 520 de Free Fire?',
  '¿Tienen stock de Steam Wallet?',
  'asdfghjkl',
];

for (const question of individualCases) {
  test(`no responde con una receta para un caso particular: ${question}`, () => {
    assert.equal(answerKnownSupportQuestion(question, context), null);
  });
}

test('los métodos de pago salen del contexto vigente, sin inventar opciones', () => {
  const result = answerKnownSupportQuestion('¿Qué métodos de pago aceptan?', {
    ...context,
    paymentMethods: ['Pago Móvil'],
  });
  assert.match(result.reply, /Pago Móvil/);
  assert.doesNotMatch(result.reply, /Binance Pay|transferencia bancaria/);
});

test('el tiempo se toma de la configuración actual', () => {
  const result = answerKnownSupportQuestion('¿Cuánto dura la orden?', {
    ...context,
    orderExpiryMinutes: 22,
  });
  assert.match(result.reply, /22 minutos/);
  assert.doesNotMatch(result.reply, /15 minutos/);
});

test('no presenta cupones como disponibles cuando están deshabilitados', () => {
  const result = answerKnownSupportQuestion('¿Cómo uso un cupón?', {
    ...context,
    couponsEnabled: false,
  });
  assert.match(result.reply, /no están habilitados/);
});

test('el pago parcial conserva la misma orden y exige otra referencia', () => {
  const result = answerKnownSupportQuestion('Pagué menos, ¿qué hago?', context);
  assert.match(result.reply, /misma orden/);
  assert.match(result.reply, /nueva referencia/);
});

test('las respuestas desconocidas permanecen disponibles para Gemini', () => {
  assert.equal(answerKnownSupportQuestion('¿Cómo cambio mi correo?', context), null);
});
