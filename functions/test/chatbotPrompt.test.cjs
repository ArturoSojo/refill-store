const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSupportSystemInstruction,
  parseSupportAnswer,
} = require('../lib/services/chatbotPrompt.js');

const context = {
  storeName: 'Refill Store',
  tagline: 'Recargas para tus juegos',
  rate: 875.25,
  paymentMethods: ['Pago Móvil', 'Binance Pay'],
  paymentDetails: ['Pago Móvil: Banco de Venezuela'],
  orderExpiryMinutes: 30,
  referenceMinLength: 4,
  referenceMaxLength: 20,
  supportUrl: 'https://wa.me/584120000000',
  customInformation: 'Atendemos por WhatsApp.',
  games: ['Free Fire'],
  matchingProducts: ['Free Fire: 100 diamantes, USD 1, Bs 875.25'],
};

test('el prompt incorpora los datos actuales y establece límites contra respuestas inventadas', () => {
  const prompt = buildSupportSystemInstruction(context);

  assert.match(prompt, /875\.25 Bs por USD/);
  assert.match(prompt, /Binance Pay/);
  assert.match(prompt, /Free Fire: 100 diamantes, USD 1, Bs 875\.25/);
  assert.match(prompt, /no inventes políticas, precios/);
  assert.match(prompt, /No tienes acceso a cuentas, órdenes individuales/);
  assert.match(prompt, /Atendemos por WhatsApp/);
  assert.match(prompt, /Pasos de compra publicados/);
});

test('parsea la respuesta estructurada de Gemini', () => {
  assert.deepEqual(
    parseSupportAnswer('{"reply":"La orden vence en 30 minutos.","needsSupport":false}'),
    { reply: 'La orden vence en 30 minutos.', needsSupport: false }
  );
});

test('acepta JSON envuelto en fences y limita la respuesta', () => {
  const parsed = parseSupportAnswer(`\`\`\`json\n${JSON.stringify({ reply: 'x'.repeat(1800), needsSupport: true })}\n\`\`\``);
  assert.equal(parsed.reply.length, 1600);
  assert.equal(parsed.needsSupport, true);
});

test('una salida JSON inválida nunca se presenta como una respuesta confiable', () => {
  assert.deepEqual(parseSupportAnswer('{"reply":'), {
    reply: 'No pude preparar una respuesta confiable. Escríbenos por WhatsApp y te ayudamos.',
    needsSupport: true,
  });
});

test('una respuesta sin el formato esperado se deriva a soporte', () => {
  assert.deepEqual(parseSupportAnswer('No tengo ese dato.'), {
    reply: 'No tengo ese dato.',
    needsSupport: true,
  });
});
