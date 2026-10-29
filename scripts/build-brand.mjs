/**
 * Generación de los recursos de marca a partir del arte de `assets-src/`.
 *
 *   node scripts/build-brand.mjs
 *
 * Fuentes:
 *   hero-2.png            banner completo (rojo neón sobre circuito oscuro)
 *   refill-store-icon.png emblema suelto, CON transparencia
 *   refill-store-logo.png emblema + rótulo «REFILL STORE», CON transparencia
 *
 * Que el icono y el logotipo lleguen con canal alfa real simplifica todo: se
 * usan tal cual sobre el tema oscuro, sin recortarlos del banner ni recurrir a
 * modos de mezcla para esconder un fondo opaco.
 *
 * Formatos: WebP como principal y PNG como respaldo. Aquí el PNG sí es la
 * elección correcta (y no JPEG) porque hace falta la transparencia; el arte es
 * vectorial y plano, así que comprime bien. El banner, en cambio, es
 * fotográfico y opaco: ahí el respaldo es JPEG.
 */
import sharp from 'sharp';
import { rm, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const resolve = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const HERO = resolve('../assets-src/hero-2.png');
const ICON = resolve('../assets-src/refill-store-icon.png');
const LOGO = resolve('../assets-src/refill-store-logo.png');
const OUT = resolve('../web/public/brand');
const PUBLIC = resolve('../web/public');

/** Fondo de los iconos de app: el emblema es rojo neón y necesita un tono oscuro. */
const ICON_TILE = '#0E0E16';

/**
 * Empaqueta imágenes PNG en formato ICO estándar de Microsoft.
 */
function createIco(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(count, 4); // Number of images

  let offset = 6 + 16 * count;
  const dirEntries = [];

  for (let i = 0; i < count; i++) {
    const buf = pngBuffers[i];
    const size = sizes[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buf.length, 8); // image size
    entry.writeUInt32LE(offset, 12); // image offset
    dirEntries.push(entry);
    offset += buf.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers]);
}

await mkdir(OUT, { recursive: true });
for (const file of await readdir(OUT)) {
  await rm(`${OUT}/${file}`, { recursive: true });
}

// --- Banner ---------------------------------------------------------------
for (const width of [1920, 1200, 800]) {
  await sharp(HERO)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 74 })
    .toFile(`${OUT}/hero-${width}.webp`);
}

await sharp(HERO)
  .resize({ width: 1600 })
  .flatten({ background: '#0a0708' })
  .jpeg({ quality: 80, mozjpeg: true })
  .toFile(`${OUT}/hero-1600.jpg`);

// OpenGraph banner (1200x630, 1.91:1)
await sharp(HERO)
  .resize({ width: 1200, height: 630, fit: 'cover', position: 'center' })
  .png({ compressionLevel: 9, quality: 90 })
  .toFile(`${OUT}/og-banner.png`);
await copyFile(`${OUT}/og-banner.png`, `${PUBLIC}/og-banner.png`);

// --- Emblema y rótulo -----------------------------------------------------
// `trim` recorta el margen transparente sobrante para que el arte llene la caja
// que le da la interfaz: sin esto, el emblema se ve pequeño y descentrado.
const MARKS = {
  emblem: { src: ICON, widths: [128, 256, 512] },
  wordmark: { src: LOGO, widths: [320, 640] },
};

for (const [name, { src, widths }] of Object.entries(MARKS)) {
  const trimmed = await sharp(src).trim({ threshold: 1 }).png().toBuffer();

  for (const width of widths) {
    await sharp(trimmed)
      .resize({ width })
      .webp({ quality: 92, alphaQuality: 100 })
      .toFile(`${OUT}/${name}-${width}.webp`);

    await sharp(trimmed)
      .resize({ width })
      .png({ compressionLevel: 9, palette: true, quality: 92 })
      .toFile(`${OUT}/${name}-${width}.png`);
  }
}

// --- Iconos de aplicación -------------------------------------------------
const iconArt = await sharp(ICON).trim({ threshold: 1 }).png().toBuffer();

for (const size of [512, 192, 180, 96, 64, 48, 32]) {
  // 82 % del lienzo: deja aire para que el icono no toque los bordes al
  // redondearse en la pantalla de inicio.
  const inner = Math.round(size * 0.82);

  await sharp({
    create: { width: size, height: size, channels: 4, background: ICON_TILE },
  })
    .composite([{ input: await sharp(iconArt).resize({ width: inner }).toBuffer(), gravity: 'center' }])
    .png({ compressionLevel: 9, palette: true, quality: 92 })
    .toFile(`${OUT}/app-icon-${size}.png`);
}

// Versión «maskable»: Android recorta hasta un 20 % de cada borde, así que el
// arte va más pequeño y centrado sobre el lienzo completo.
await sharp({ create: { width: 512, height: 512, channels: 4, background: ICON_TILE } })
  .composite([{ input: await sharp(iconArt).resize({ width: 300 }).toBuffer(), gravity: 'center' }])
  .png({ compressionLevel: 9, palette: true, quality: 92 })
  .toFile(`${OUT}/app-icon-maskable-512.png`);

// Favicons canónicos y nombres de alto alcance (Google Search, Apple, etc.)
// Favicon 48x48 (múltiplo exigido por Google Search Central)
await copyFile(`${OUT}/app-icon-48.png`, `${OUT}/favicon-48x48.png`);
await copyFile(`${OUT}/app-icon-48.png`, `${PUBLIC}/favicon-48x48.png`);

// Icono 192 (Google Search, Android, PWA, Schema.org logo)
await copyFile(`${OUT}/app-icon-192.png`, `${OUT}/icon-192.png`);
await copyFile(`${OUT}/app-icon-192.png`, `${PUBLIC}/icon-192.png`);

// Apple touch icon 180x180
await copyFile(`${OUT}/app-icon-180.png`, `${OUT}/apple-touch-icon.png`);
await copyFile(`${OUT}/app-icon-180.png`, `${PUBLIC}/apple-touch-icon.png`);

// Multi-resolución favicon.ico (16x16, 32x32, 48x48)
const icoPngBuffers = [];
const icoSizes = [16, 32, 48];
for (const s of icoSizes) {
  const inner = Math.round(s * 0.82);
  const buf = await sharp({
    create: { width: s, height: s, channels: 4, background: ICON_TILE },
  })
    .composite([{ input: await sharp(iconArt).resize({ width: inner }).toBuffer(), gravity: 'center' }])
    .png({ compressionLevel: 9, palette: true, quality: 92 })
    .toBuffer();
  icoPngBuffers.push(buf);
}
const icoBuffer = createIco(icoPngBuffers, icoSizes);
await writeFile(`${OUT}/favicon.ico`, icoBuffer);
await writeFile(`${PUBLIC}/favicon.ico`, icoBuffer);

// --- Logotipo para superficies claras (facturas, correos) ------------------
await sharp(LOGO)
  .trim({ threshold: 1 })
  .resize({ width: 900 })
  .flatten({ background: '#ffffff' })
  .jpeg({ quality: 90, mozjpeg: true })
  .toFile(`${OUT}/logo-light-900.jpg`);

console.log('Recursos de marca generados exitosamente en web/public/brand y web/public');
