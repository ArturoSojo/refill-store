#!/usr/bin/env node
/**
 * Configuración inicial de Refill Store.
 *
 * Llama a las rutas `/api/setup/*` de la API desplegada (protegidas por
 * SETUP_TOKEN) para crear el documento de configuración, sembrar el catálogo
 * del documento técnico y convertir una cuenta en administrador.
 *
 * Uso:
 *   node scripts/setup.mjs bootstrap --email=tucorreo@gmail.com
 *   node scripts/setup.mjs seed [--overwrite-prices]
 *
 * Variables de entorno:
 *   SETUP_TOKEN   obligatorio, el mismo valor del secreto en Cloud Functions
 *   API_BASE_URL  opcional, por defecto https://refill-e254f.web.app
 */

const DEFAULT_BASE = 'https://refill-e254f.web.app';

function parseArgs(argv) {
  const command = argv[2];
  const flags = {};

  for (const arg of argv.slice(3)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    flags[key] = value ?? true;
  }

  return { command, flags };
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/setup${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail(`Respuesta inesperada del servidor (${response.status}):\n${text.slice(0, 400)}`);
  }

  if (!response.ok || payload.ok === false) {
    fail(payload?.error?.message ?? `Error ${response.status}`);
  }

  return payload.data;
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  const token = process.env.SETUP_TOKEN;
  const baseUrl = process.env.API_BASE_URL ?? DEFAULT_BASE;

  if (!token) {
    fail(
      'Falta SETUP_TOKEN.\n   Ejemplo: SETUP_TOKEN=xxxx node scripts/setup.mjs bootstrap --email=tu@correo.com'
    );
  }

  if (command === 'bootstrap') {
    const email = typeof flags.email === 'string' ? flags.email : null;
    const password = typeof flags.password === 'string' ? flags.password : undefined;
    if (!email) fail('Falta --email=tucorreo@gmail.com');

    console.log(`\n🚀 Configurando ${baseUrl}…`);
    const data = await post(baseUrl, '/bootstrap', { token, email, password, seed: true });

    console.log(
      `\n✅ ${email} ahora es administrador${data.admin.created ? ' (cuenta creada)' : ''}.`
    );
    if (data.seed) {
      console.log(
        `   Catálogo: ${data.seed.gamesCreated} juegos y ${data.seed.productsCreated} productos creados ` +
          `(margen por defecto ${data.seed.marginPercent}%).`
      );
    }
    console.log(`\n${data.message}\n`);
    console.log('   Cuando termines, borra el secreto para cerrar estas rutas:');
    console.log('   firebase functions:secrets:destroy SETUP_TOKEN\n');
    return;
  }

  if (command === 'seed') {
    console.log(`\n🌱 Sembrando el catálogo en ${baseUrl}…`);
    const data = await post(baseUrl, '/seed', {
      token,
      overwritePrices: flags['overwrite-prices'] === true,
    });

    console.log(
      `\n✅ Juegos: ${data.gamesCreated} nuevos, ${data.gamesUpdated} actualizados.` +
        `\n   Productos: ${data.productsCreated} nuevos, ${data.productsUpdated} actualizados.` +
        `\n   Margen aplicado a los nuevos: ${data.marginPercent}%.\n`
    );
    return;
  }

  console.log(`
Refill Store — configuración inicial

  node scripts/setup.mjs bootstrap --email=tucorreo@gmail.com [--password=...]
      Crea la configuración, siembra el catálogo y te vuelve administrador.
      Sin --password la cuenta debe existir ya (haber entrado con Google).
      Con --password se crea la cuenta y puedes entrar sin Google.

  node scripts/setup.mjs seed [--overwrite-prices]
      Sólo siembra o actualiza el catálogo del documento técnico.
      Con --overwrite-prices también recalcula los precios de venta.

Requiere SETUP_TOKEN en el entorno.
`);
}

main().catch((error) => fail(error.message));
