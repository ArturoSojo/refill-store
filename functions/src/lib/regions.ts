/**
 * Diccionario y utilidades de normalización regional para Central One y FazerCards.
 */

export interface RegionInfo {
  regionCode: string;
  regionLabel: string;
  regionBadge: string;
  isRegionRestricted: boolean;
  regionWarning: string;
}

interface RegionDef {
  name: string;
  flag: string;
  badge: string;
  restricted: boolean;
}

export const KNOWN_REGIONS: Record<string, RegionDef> = {
  GLOBAL: { name: 'Global', flag: '🌎', badge: 'GLOBAL', restricted: false },
  LATAM: { name: 'LATAM', flag: '🌎', badge: 'LATAM', restricted: false },
  AMERICAS: { name: 'América', flag: '🌎', badge: 'AMÉRICAS', restricted: false },
  BR: { name: 'Brasil', flag: '🇧🇷', badge: 'BRASIL', restricted: true },
  US: { name: 'EE.UU.', flag: '🇺🇸', badge: 'EE.UU.', restricted: true },
  USA: { name: 'EE.UU.', flag: '🇺🇸', badge: 'EE.UU.', restricted: true },
  ID: { name: 'Indonesia', flag: '🇮🇩', badge: 'INDONESIA', restricted: true },
  MY: { name: 'Malasia', flag: '🇲🇾', badge: 'MALASIA', restricted: true },
  PH: { name: 'Filipinas', flag: '🇵🇭', badge: 'FILIPINAS', restricted: true },
  TR: { name: 'Turquía', flag: '🇹🇷', badge: 'TURQUÍA', restricted: true },
  EU: { name: 'Europa', flag: '🇪🇺', badge: 'EUROPA', restricted: true },
  MX: { name: 'México', flag: '🇲🇽', badge: 'MÉXICO', restricted: true },
  CO: { name: 'Colombia', flag: '🇨🇴', badge: 'COLOMBIA', restricted: true },
  CL: { name: 'Chile', flag: '🇨🇱', badge: 'CHILE', restricted: true },
  AR: { name: 'Argentina', flag: '🇦🇷', badge: 'ARGENTINA', restricted: true },
  PE: { name: 'Perú', flag: '🇵🇪', badge: 'PERÚ', restricted: true },
  UY: { name: 'Uruguay', flag: '🇺🇾', badge: 'URUGUAY', restricted: true },
  CR: { name: 'Costa Rica', flag: '🇨🇷', badge: 'COSTA RICA', restricted: true },
  ES: { name: 'España', flag: '🇪🇸', badge: 'ESPAÑA', restricted: true },
  DE: { name: 'Alemania', flag: '🇩🇪', badge: 'ALEMANIA', restricted: true },
  FR: { name: 'Francia', flag: '🇫🇷', badge: 'FRANCIA', restricted: true },
  IT: { name: 'Italia', flag: '🇮🇹', badge: 'ITALIA', restricted: true },
  PT: { name: 'Portugal', flag: '🇵🇹', badge: 'PORTUGAL', restricted: true },
  NL: { name: 'Países Bajos', flag: '🇳🇱', badge: 'PAÍSES BAJOS', restricted: true },
  BE: { name: 'Bélgica', flag: '🇧🇪', badge: 'BÉLGICA', restricted: true },
  AT: { name: 'Austria', flag: '🇦🇹', badge: 'AUSTRIA', restricted: true },
  CH: { name: 'Suiza', flag: '🇨🇭', badge: 'SUIZA', restricted: true },
  SE: { name: 'Suecia', flag: '🇸🇪', badge: 'SUECIA', restricted: true },
  NO: { name: 'Noruega', flag: '🇳🇴', badge: 'NORUEGA', restricted: true },
  DK: { name: 'Dinamarca', flag: '🇩🇰', badge: 'DINAMARCA', restricted: true },
  FI: { name: 'Finlandia', flag: '🇫🇮', badge: 'FINLANDIA', restricted: true },
  PL: { name: 'Polonia', flag: '🇵🇱', badge: 'POLONIA', restricted: true },
  CZ: { name: 'Rep. Checa', flag: '🇨🇿', badge: 'REP. CHECA', restricted: true },
  HR: { name: 'Croacia', flag: '🇭🇷', badge: 'CROACIA', restricted: true },
  HU: { name: 'Hungría', flag: '🇭🇺', badge: 'HUNGRÍA', restricted: true },
  RO: { name: 'Rumania', flag: '🇷🇴', badge: 'RUMANIA', restricted: true },
  IE: { name: 'Irlanda', flag: '🇮🇪', badge: 'IRLANDA', restricted: true },
  LU: { name: 'Luxemburgo', flag: '🇱🇺', badge: 'LUXEMBURGO', restricted: true },
  SG: { name: 'Singapur', flag: '🇸🇬', badge: 'SINGAPUR', restricted: true },
  VN: { name: 'Vietnam', flag: '🇻🇳', badge: 'VIETNAM', restricted: true },
  KH: { name: 'Camboya', flag: '🇰🇭', badge: 'CAMBOYA', restricted: true },
  BD: { name: 'Bangladesh', flag: '🇧🇩', badge: 'BANGLADESH', restricted: true },
  PK: { name: 'Pakistán', flag: '🇵🇰', badge: 'PAKISTÁN', restricted: true },
  EG: { name: 'Egipto', flag: '🇪🇬', badge: 'EGIPTO', restricted: true },
  KW: { name: 'Kuwait', flag: '🇰🇼', badge: 'KUWAIT', restricted: true },
  BH: { name: 'Baréin', flag: '🇧🇭', badge: 'BARÉIN', restricted: true },
  QA: { name: 'Catar', flag: '🇶🇦', badge: 'CATAR', restricted: true },
  LB: { name: 'Líbano', flag: '🇱🇧', badge: 'LÍBANO', restricted: true },
  ZA: { name: 'Sudáfrica', flag: '🇿🇦', badge: 'SUDÁFRICA', restricted: true },
  NG: { name: 'Nigeria', flag: '🇳🇬', badge: 'NIGERIA', restricted: true },
  MM: { name: 'Myanmar', flag: '🇲🇲', badge: 'MYANMAR', restricted: true },
  KZ: { name: 'Kazajistán', flag: '🇰🇿', badge: 'KAZAJISTÁN', restricted: true },
  BY: { name: 'Bielorrusia', flag: '🇧🇾', badge: 'BIELORRUSIA', restricted: true },
  RU: { name: 'Rusia', flag: '🇷🇺', badge: 'RUSIA', restricted: true },
  TH: { name: 'Tailandia', flag: '🇹🇭', badge: 'TAILANDIA', restricted: true },
  KR: { name: 'Corea del Sur', flag: '🇰🇷', badge: 'COREA DEL SUR', restricted: true },
  JP: { name: 'Japón', flag: '🇯🇵', badge: 'JAPÓN', restricted: true },
  IN: { name: 'India', flag: '🇮🇳', badge: 'INDIA', restricted: true },
  NA: { name: 'Norteamérica', flag: '🌎', badge: 'NORTEAMÉRICA', restricted: true },
  NAEU: { name: 'Norteamérica / Europa', flag: '🌎', badge: 'NA / EU', restricted: true },
  SEA: { name: 'Sudeste Asiático', flag: '🌏', badge: 'SEA', restricted: true },
  MENA: { name: 'Medio Oriente', flag: '🌍', badge: 'MENA', restricted: true },
  UK: { name: 'Reino Unido', flag: '🇬🇧', badge: 'UK', restricted: true },
  GB: { name: 'Reino Unido', flag: '🇬🇧', badge: 'UK', restricted: true },
  CA: { name: 'Canadá', flag: '🇨🇦', badge: 'CANADÁ', restricted: true },
  AU: { name: 'Australia', flag: '🇦🇺', badge: 'AUSTRALIA', restricted: true },
  NZ: { name: 'Nueva Zelanda', flag: '🇳🇿', badge: 'N. ZELANDA', restricted: true },
  TW: { name: 'Taiwán', flag: '🇹🇼', badge: 'TAIWÁN', restricted: true },
  HK: { name: 'Hong Kong', flag: '🇭🇰', badge: 'HONG KONG', restricted: true },
};

/**
 * Resuelve la información regional completa y normalizada de un juego o paquete.
 */
export function resolveRegionInfo(
  rawRegion?: string | null,
  name?: string | null,
  familyName?: string | null
): RegionInfo {
  let code = (rawRegion || '').trim().toUpperCase();
  if (!code || code === 'NULL' || code === 'UNDEFINED' || code === 'NONE' || code === 'UNKNOWN') {
    code = '';
  }
  if (code === 'WW' || code === 'WORLD' || code === 'WORLDWIDE' || code === 'ROW' || code === 'GLO') code = 'GLOBAL';
  if (code === 'LA' || code === 'LATIN' || code === 'SA' || code === 'SOUTH AMERICA') code = 'LATAM';
  if (code === 'USA') code = 'US';

  // Si no hay código o dice GLOBAL pero el título o familia tiene entre paréntesis (BR), (US), etc.
  if (!code || code === 'GLOBAL') {
    const combined = `${familyName ?? ''} ${name ?? ''}`;
    const match = /\b(?:Solo\s+)?\((GLOBAL|LATAM|AMERICAS|NA|NAEU|EU|BR|US|USA|MX|CO|CL|AR|PE|UY|CR|ES|DE|FR|IT|PT|NL|BE|AT|CH|SE|NO|DK|FI|PL|CZ|HR|HU|RO|IE|SG|VN|KH|BD|PK|EG|KW|BH|QA|LB|ZA|NG|MM|KZ|BY|RU|ID|MY|PH|TR|TH|KR|JP|IN|SEA|MENA|UK|GB|CA|AU|NZ|TW|HK)\)/i.exec(combined);
    if (match) {
      const parsed = match[1].toUpperCase();
      code = parsed === 'USA' ? 'US' : parsed === 'GB' ? 'UK' : parsed;
    }
  }

  if (!code) code = 'GLOBAL';

  const def = KNOWN_REGIONS[code];
  if (def) {
    const isGlobalOrLatam = code === 'GLOBAL' || code === 'LATAM' || code === 'AMERICAS';
    const regionLabel = isGlobalOrLatam
      ? `${def.flag} ${def.name}`
      : `${def.flag} Solo ${def.name}`;
    const regionWarning = isGlobalOrLatam
      ? (code === 'LATAM'
          ? '✅ Válido para cuentas Global / LATAM (Venezuela y Latinoamérica)'
          : '✅ Válido para cuentas Global / LATAM')
      : `⚠️ Exclusivo para cuentas registradas en ${def.name} (No válido para cuentas Global o LATAM)`;

    return {
      regionCode: code,
      regionLabel,
      regionBadge: def.badge,
      isRegionRestricted: def.restricted,
      regionWarning,
    };
  }

  // Código ISO de 2 letras desconocido
  return {
    regionCode: code,
    regionLabel: `Solo ${code}`,
    regionBadge: code,
    isRegionRestricted: true,
    regionWarning: `⚠️ Exclusivo para cuentas registradas en ${code} (No válido para Global o LATAM)`,
  };
}

/**
 * Limpia sufijos repetidos de región entre paréntesis en el título de un juego
 * (ej. `PUBG Mobile (GLOBAL)` -> `PUBG Mobile`, `Mobile Legends (BR)` -> `Mobile Legends`).
 */
export function cleanGameTitle(title?: string | null): string {
  if (!title) return '';
  return title
    .replace(/\s*(?:[-–—]\s*)?\((?:Solo\s+)?[A-Z\u00C0-\u00DC\s\/\-_]+\)\s*$/i, (match) => {
      if (/\b(?:GLOBAL|LATAM|AMERICAS|NA|NAEU|EU|BR|US|USA|MX|CO|CL|AR|PE|UY|CR|ES|DE|FR|IT|PT|NL|BE|AT|CH|SE|NO|DK|FI|PL|CZ|HR|HU|RO|IE|LU|SG|VN|KH|BD|PK|EG|KW|BH|QA|LB|ZA|NG|MM|KZ|BY|RU|ID|MY|PH|TR|TH|KR|JP|IN|SEA|MENA|UK|GB|CA|AU|NZ|TW|HK|BFC|USDC)\b/i.test(match)) {
        return '';
      }
      return match;
    })
    .replace(/\s+(?:GLOBAL|LATAM)\s*$/i, '')
    .trim();
}

/**
 * Detecta notas de restricción regional en nombres de paquetes (ej. `(excepto VN/TH/ID/Medio Oriente)`).
 */
export function extractPackageRegionNotice(packageName?: string | null): string | null {
  if (!packageName) return null;
  const match = /\((excepto[^)]+|solo[^)]+|only[^)]+|exclusivo[^)]+)\)/i.exec(packageName);
  if (match) return match[1].trim();
  if (/\[webshop only\]/i.test(packageName)) return 'Webshop Oficial Only';
  return null;
}

/**
 * Prioridad de Región:
 * Tier 1 (Máxima prioridad): GLOBAL, LATAM, VE, AMERICAS o sin restricción regional.
 * Tier 2 (Prioridad Media): EE.UU. / US (vital para Gift Cards como Google Play, Apple, Steam, PlayStation, Razer Gold).
 * Tier 3 (Otras regiones específicas): BR, SG, AT, BE, DE, FR, EU, etc.
 */
export function getRegionTier(game: {
  regionCode?: string | null;
  region?: string | null;
  isRegionRestricted?: boolean | null;
  providerFamily?: string | null;
}): number {
  const code = (game.regionCode || game.region || '').trim().toUpperCase();
  const isRestricted = game.isRegionRestricted === true;

  if (!isRestricted || code === 'GLOBAL' || code === 'LATAM' || code === 'AMERICAS' || code === 'VE') {
    return 1;
  }
  // En Gift Cards, US es la región primaria para las marcas globales (Google Play, PlayStation, Xbox, Apple, etc.)
  if (game.providerFamily === 'gift_card' && (code === 'US' || code === 'USA')) {
    return 1;
  }
  if (code === 'US' || code === 'USA') {
    return 2;
  }
  return 3;
}

export const TOPUP_POPULARITY_RANK = [
  { pattern: /free\s*fire/i, rank: 10 },
  { pattern: /blood\s*strike/i, rank: 20 },
  { pattern: /call\s*of\s*duty|cod\s*mobile|\bcodm\b/i, rank: 30 },
  { pattern: /roblox/i, rank: 40 },
  { pattern: /pubg/i, rank: 50 },
  { pattern: /mobile\s*legends|\bmlbb\b/i, rank: 60 },
  { pattern: /clash\s*royale|brawl\s*stars|clash\s*of\s*clans/i, rank: 70 },
  { pattern: /genshin/i, rank: 80 },
  { pattern: /valorant/i, rank: 90 },
  { pattern: /honor\s*of\s*kings/i, rank: 100 },
];

export const GIFT_CARD_POPULARITY_RANK = [
  { pattern: /roblox/i, rank: 10 },
  { pattern: /free\s*fire/i, rank: 20 },
  { pattern: /playstation|\bpsn\b/i, rank: 30 },
  { pattern: /steam\s*(?:wallet|card|tarjeta|$)/i, rank: 40 },
  { pattern: /google\s*play/i, rank: 50 },
  { pattern: /apple|itunes|app\s*store/i, rank: 60 },
  { pattern: /razer\s*gold/i, rank: 70 },
  { pattern: /^xbox\b|xbox\s*(?:gift|card|tarjeta|game\s*pass)/i, rank: 80 },
  { pattern: /nintendo/i, rank: 90 },
  { pattern: /binance/i, rank: 100 },
];

export function getBasePopularityRank(name?: string | null, family?: string | null): number {
  if (!name) return 999;
  const list = family === 'gift_card' ? GIFT_CARD_POPULARITY_RANK : TOPUP_POPULARITY_RANK;
  for (const item of list) {
    if (item.pattern.test(name)) return item.rank;
  }
  return 999;
}

/**
 * Comparador universal para el catálogo de la tienda:
 * 1. Disponibilidad de Stock (productos con paquetes disponibles antes que agotados).
 * 2. Prioridad de Región (Tier 1: Global/LATAM/US Gift cards -> Tier 2: USA -> Tier 3: Específicos).
 * 3. Compras reales históricas (`salesCount` descendente).
 * 4. Relevancia Base del Juego (Base Popularity Rank ascendente).
 * 5. Desempate alfabético por título limpio.
 */
export function compareCatalogGames(
  a: {
    name?: string | null;
    regionCode?: string | null;
    region?: string | null;
    isRegionRestricted?: boolean | null;
    salesCount?: number | null;
    providerFamily?: string | null;
    productCount?: number | null;
  },
  b: {
    name?: string | null;
    regionCode?: string | null;
    region?: string | null;
    isRegionRestricted?: boolean | null;
    salesCount?: number | null;
    providerFamily?: string | null;
    productCount?: number | null;
  }
): number {
  const stockA = (a.productCount ?? 1) > 0 ? 1 : 0;
  const stockB = (b.productCount ?? 1) > 0 ? 1 : 0;
  if (stockA !== stockB) return stockB - stockA;

  const tierA = getRegionTier(a);
  const tierB = getRegionTier(b);
  if (tierA !== tierB) return tierA - tierB;

  const salesA = a.salesCount || 0;
  const salesB = b.salesCount || 0;
  if (salesA !== salesB) return salesB - salesA;

  const rankA = getBasePopularityRank(a.name, a.providerFamily);
  const rankB = getBasePopularityRank(b.name, b.providerFamily);
  if (rankA !== rankB) return rankA - rankB;

  return cleanGameTitle(a.name).localeCompare(cleanGameTitle(b.name));
}

/**
 * Calcula un número entero positivo `sortOrder` para almacenar en Firestore,
 * de modo que `.orderBy('sortOrder', 'asc')` reproduzca exactamente la jerarquía:
 * - Tier 1: [50,000,000 .. 100,010,000]
 * - Tier 2: [150,000,000 .. 200,010,000]
 * - Tier 3: [250,000,000 .. 300,010,000]
 * - Sin stock (0 paquetes): +500,000,000
 * Dentro de cada tier: más ventas -> menor número (mayor prioridad).
 * Desempate por base rank (menor rank -> menor número).
 */
export function calculateGameSortOrder(game: {
  regionCode?: string | null;
  region?: string | null;
  isRegionRestricted?: boolean | null;
  salesCount?: number | null;
  name?: string | null;
  providerFamily?: string | null;
  productCount?: number | null;
}): number {
  const hasStock = (game.productCount ?? 1) > 0;
  const stockPenalty = hasStock ? 0 : 500_000_000;

  const tier = getRegionTier(game);
  const baseOffset = tier * 100_000_000;
  const sales = Math.min(game.salesCount || 0, 5000);
  const salesReduction = sales * 10_000;
  const rank = getBasePopularityRank(game.name, game.providerFamily);
  const rankAddition = rank * 10;

  return stockPenalty + baseOffset - salesReduction + rankAddition;
}
