#!/usr/bin/env node
/**
 * Extractor de correos de clientes y usuarios para listas de Testers (Google Play / APK).
 *
 * Escanea de forma exhaustiva:
 *  1. Firebase Authentication (todos los usuarios registrados y sus proveedores).
 *  2. Colección de Firestore `users` (perfiles de usuarios).
 *  3. Colección de Firestore `orders` (compradores que hicieron pedidos).
 *
 * Genera automáticamente en la carpeta `testers-export/`:
 *  - `testers-emails.txt` (uno por línea, listo para copiar y pegar en Google Play Console).
 *  - `testers-emails.csv` (formato CSV para subir directo como archivo).
 *  - `testers-emails-comma.txt` (separados por coma, para campos de texto que lo exijan).
 *
 * Uso:
 *   npm run extract:testers
 *   o directamente:
 *   node scripts/extract-tester-emails.mjs
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Cargar firebase-admin desde functions/node_modules
let admin;
try {
  admin = require(path.join(rootDir, 'functions', 'node_modules', 'firebase-admin'));
} catch {
  try {
    admin = require('firebase-admin');
  } catch (err) {
    console.error('\n❌ No se encontró firebase-admin. Asegúrate de ejecutar antes:');
    console.error('   npm install --prefix functions\n');
    process.exit(1);
  }
}

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'refill-e254f';

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: PROJECT_ID,
  });
}

const auth = admin.auth();
const db = admin.firestore();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(cleaned)) return null;
  // Descartar correos temporales, placeholders o dominios dummy conocidos
  if (cleaned.endsWith('@example.com') || cleaned.endsWith('@test.com') || cleaned.endsWith('@localhost')) {
    return null;
  }
  return cleaned;
}

async function extractAuthEmails() {
  const emails = new Set();
  let pageToken;
  process.stdout.write('🔍 Extrayendo usuarios de Firebase Authentication... ');

  do {
    const listResult = await auth.listUsers(1000, pageToken);
    for (const user of listResult.users) {
      const email = normalizeEmail(user.email);
      if (email) emails.add(email);

      for (const provider of user.providerData || []) {
        const provEmail = normalizeEmail(provider.email);
        if (provEmail) emails.add(provEmail);
      }
    }
    pageToken = listResult.pageToken;
  } while (pageToken);

  console.log(`✅ (${emails.size} correos únicos)`);
  return emails;
}

async function extractFirestoreUsers() {
  const emails = new Set();
  process.stdout.write('🔍 Extrayendo perfiles de Firestore (/users)... ');

  const snapshot = await db.collection('users').get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const email = normalizeEmail(data.email);
    if (email) emails.add(email);
  }

  console.log(`✅ (${emails.size} correos únicos)`);
  return emails;
}

async function extractFirestoreOrders() {
  const emails = new Set();
  process.stdout.write('🔍 Extrayendo compradores de órdenes (/orders)... ');

  const snapshot = await db.collection('orders').select('user', 'clienteContacto').get();
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const userEmail = normalizeEmail(data?.user?.email);
    if (userEmail) emails.add(userEmail);

    const contact = normalizeEmail(data?.clienteContacto);
    if (contact) emails.add(contact);
  }

  console.log(`✅ (${emails.size} correos únicos)`);
  return emails;
}

async function main() {
  console.log('\n======================================================');
  console.log(`🚀 Extrayendo correos de testers de Refill Store [${PROJECT_ID}]`);
  console.log('======================================================\n');

  try {
    const [authEmails, usersEmails, ordersEmails] = await Promise.all([
      extractAuthEmails(),
      extractFirestoreUsers(),
      extractFirestoreOrders(),
    ]);

    // Unificar todos los correos
    const allEmailsSet = new Set([
      ...authEmails,
      ...usersEmails,
      ...ordersEmails,
    ]);

    // Ordenar alfabéticamente
    const sortedEmails = Array.from(allEmailsSet).sort();

    console.log('\n----------------- RESUMEN DE EXTRACCIÓN -----------------');
    console.log(`• Firebase Auth:         ${authEmails.size} correos`);
    console.log(`• Firestore /users:      ${usersEmails.size} correos`);
    console.log(`• Firestore /orders:     ${ordersEmails.size} correos`);
    console.log(`• TOTAL ÚNICOS LIMPIOS:  ${sortedEmails.length} correos`);
    console.log('---------------------------------------------------------\n');

    if (sortedEmails.length === 0) {
      console.warn('⚠️ No se encontraron correos para exportar.');
      return;
    }

    // Crear directorio de salida
    const outDir = path.join(rootDir, 'testers-export');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // 1. Archivo de texto plano (uno por línea)
    const txtPath = path.join(outDir, 'testers-emails.txt');
    fs.writeFileSync(txtPath, sortedEmails.join('\n') + '\n', 'utf8');

    // 2. Archivo CSV (con encabezado estándar para Google Play Console)
    const csvPath = path.join(outDir, 'testers-emails.csv');
    fs.writeFileSync(csvPath, 'Email\n' + sortedEmails.join('\n') + '\n', 'utf8');

    // 3. Archivo con correos separados por comas
    const commaPath = path.join(outDir, 'testers-emails-comma.txt');
    fs.writeFileSync(commaPath, sortedEmails.join(', ') + '\n', 'utf8');

    console.log('📁 Archivos generados con éxito en la carpeta "testers-export/":\n');
    console.log(`  1. testers-emails.txt       -> ${sortedEmails.length} correos (uno por línea, ideal para copiar y pegar)`);
    console.log(`  2. testers-emails.csv       -> Archivo CSV listo para importar en Google Play`);
    console.log(`  3. testers-emails-comma.txt -> Correos separados por coma (email1, email2, ...)`);
    console.log('\n💡 Instrucciones para Google Play Console:');
    console.log('   1. Ve a tu app en Google Play Console.');
    console.log('   2. Entra a Pruebas internas (o Pruebas cerradas) -> pestaña "Evaluadores".');
    console.log('   3. En tu lista de evaluadores, pega el contenido de "testers-emails.txt" o sube "testers-emails.csv".');
    console.log('   4. Guarda los cambios. ¡Listo!\n');

  } catch (error) {
    console.error('\n❌ Ocurrió un error al extraer los datos:', error);
    process.exit(1);
  }
}

main();

