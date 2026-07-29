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
import { rm, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const resolve = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const HERO = resolve('../assets-src/hero-2.png');
const ICON = resolve('../assets-src/refill-store-icon.png');
const LOGO = resolve('../assets-src/refill-store-logo.png');
const OUT = resolve('../web/public/brand');

/** Fondo de los iconos de app: el emblema es rojo neón y necesita un tono oscuro. */
const ICON_TILE = '#0E0E16';

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

for (const size of [512, 192, 180, 96, 64, 32]) {
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

// --- Logotipo para superficies claras (facturas, correos) ------------------
await sharp(LOGO)
  .trim({ threshold: 1 })
  .resize({ width: 900 })
  .flatten({ background: '#ffffff' })
  .jpeg({ quality: 90, mozjpeg: true })
  .toFile(`${OUT}/logo-light-900.jpg`);

console.log('Recursos de marca generados en web/public/brand');
