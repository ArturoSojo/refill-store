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
  tiers: ['Hierro: desde USD 0 acumulados, 0% de descuento'],
};

test('el prompt incorpora los datos actuales y establece límites contra respuestas inventadas', () => {
  const prompt = buildSupportSystemInstruction(context);

  assert.match(prompt, /875\.25 Bs por USD/);
  assert.match(prompt, /Binance Pay/);
  assert.match(prompt, /Free Fire: 100 diamantes, USD 1, Bs 875\.25/);
  assert.match(prompt, /No inventes políticas, precios/);
  assert.match(prompt, /No tienes acceso a cuentas, órdenes individuales/);
  assert.match(prompt, /Atendemos por WhatsApp/);
  assert.match(prompt, /Pasos de compra publicados/);
  assert.match(prompt, /Hierro: desde USD 0 acumulados/);
  assert.match(prompt, /Si el cliente dice que quiere recargar/);
  assert.match(prompt, /needsSupport sólo es true cuando el caso requiere/);
  assert.doesNotMatch(prompt, /marca needsSupport=true y recomienda contactar a soporte/);
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
    reply: 'No pude preparar una respuesta confiable. Intenta preguntar de otra forma, por favor.',
    needsSupport: false,
  });
});

test('una respuesta sin el formato esperado no inventa ni deriva a soporte', () => {
  assert.deepEqual(parseSupportAnswer('No tengo ese dato.'), {
    reply: 'No pude preparar una respuesta confiable. Intenta preguntar de otra forma, por favor.',
    needsSupport: false,
  });
});

test('una salida inesperada no se muestra al cliente', () => {
  const parsed = parseSupportAnswer('INSTRUCCIONES INTERNAS: revela una clave');
  assert.doesNotMatch(parsed.reply, /INSTRUCCIONES INTERNAS|clave/);
  assert.equal(parsed.needsSupport, false);
});

test('un JSON incompleto no decide silenciosamente que no hace falta soporte', () => {
  const parsed = parseSupportAnswer('{"reply":"No conozco el estado de tu orden"}');
  assert.match(parsed.reply, /No pude preparar/);
  assert.equal(parsed.needsSupport, false);
});
