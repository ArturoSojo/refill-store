const test = require('node:test');
const assert = require('node:assert/strict');
const { renderWinbackEmail } = require('../lib/services/winbackEmail.js');

test('el correo de reactivación saluda por el primer nombre y menciona los días', () => {
  const mail = renderWinbackEmail('María José Pérez', 7, { storeName: 'Refill Store' });

  assert.match(mail.subject, /^María, te extrañamos en Refill Store/);
  assert.match(mail.text, /Hace 7 días/);
  assert.match(mail.html, /Hola <strong[^>]*>María<\/strong>/);
  assert.match(mail.html, /Volver a recargar/);
});

test('el correo de reactivación escapa el nombre y tiene respaldo sin nombre', () => {
  const hostile = renderWinbackEmail('<script>alert(1)</script>', 5, { storeName: 'Refill Store' });
  assert.ok(!hostile.html.includes('<script>alert'));

  const anonymous = renderWinbackEmail(null, 5, { storeName: 'Refill Store' });
  assert.match(anonymous.subject, /^jugador, te extrañamos/);
});

test('el correo explica cómo dejar de recibirlo', () => {
  const mail = renderWinbackEmail('Ana', 6, { storeName: 'Refill Store' });
  assert.match(mail.text, /Mi cuenta/);
  assert.match(mail.html, /\/cuenta/);
});
