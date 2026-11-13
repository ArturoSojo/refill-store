/**
 * Costos de tabla para órdenes manuales de WhatsApp (Roblox y TikTok).
 * Debe mantenerse idéntico a `refillbot-pro/services/catalogSync.js`.
 *
 * Roblox: costo de proveedor + margen base; WhatsApp = base * 1.02.
 * TikTok: costo = monedas * 0.0104; base = costo * 1.30; WhatsApp = max(base, costo * 1.32).
 */

export const WHATSAPP_MARKUP = 1.02;
const TIKTOK_COSTO_POR_MONEDA = 0.0104;
const TIKTOK_MARGEN = 1.30;
const TIKTOK_BOT_MARGEN = 1.32;

function round2(n: number): number {
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
}

function round4(n: number): number {
  return Math.round(Number((n * 10000).toPrecision(12))) / 10000;
}

export interface ManualCatalogItem {
  nombre: string;
  costUsd: number;
  baseUsd: number;
  whatsappUsd: number;
}

interface RobloxRow {
  key: string;
  robux: number | null;
  nombre: string;
  costUsd: number;
  webUsd: number;
}

const ROBLOX_ROWS: RobloxRow[] = [
  { key: '40', robux: 40, nombre: '40 Robux', costUsd: 0.5, webUsd: 0.72 },
  { key: '80', robux: 80, nombre: '80 Robux', costUsd: 1.0, webUsd: 1.25 },
  { key: '500', robux: 500, nombre: '500 Robux', costUsd: 5.0, webUsd: 6.0 },
  { key: '1000', robux: 1000, nombre: '1000 Robux', costUsd: 10.0, webUsd: 12.0 },
  { key: '2000', robux: 2000, nombre: '2000 Robux', costUsd: 20.0, webUsd: 24.0 },
  { key: '5250', robux: 5250, nombre: '5250 Robux', costUsd: 50.0, webUsd: 57.0 },
  { key: 'plus', robux: null, nombre: 'Roblox Plus', costUsd: 4.99, webUsd: 6.0 },
  { key: 'plus500', robux: null, nombre: 'Plus 500', costUsd: 8.99, webUsd: 11.0 },
  { key: 'plus1000', robux: null, nombre: 'Plus 1000', costUsd: 12.99, webUsd: 16.5 },
];

export const ROBLOX_CATALOG: (ManualCatalogItem & { key: string; robux: number | null })[] =
  ROBLOX_ROWS.map((r) => ({
    key: r.key,
    robux: r.robux,
    nombre: r.nombre,
    costUsd: r.costUsd,
    baseUsd: r.webUsd,
    whatsappUsd: round2(r.webUsd * WHATSAPP_MARKUP),
  }));

export const TIKTOK_COINS = [30, 60, 180, 350, 700, 1400, 3500];

export function tiktokPrice(coins: number): ManualCatalogItem & { monedas: number } {
  const rawCost = coins * TIKTOK_COSTO_POR_MONEDA;
  const baseUsd = round2(rawCost * TIKTOK_MARGEN);
  return {
    monedas: coins,
    nombre: `${coins} Monedas`,
    costUsd: round4(rawCost),
    baseUsd,
    whatsappUsd: Math.max(baseUsd, round2(rawCost * TIKTOK_BOT_MARGEN)),
  };
}

export const TIKTOK_CATALOG = TIKTOK_COINS.map(tiktokPrice);

function numbersIn(text: string): number[] {
  return (text.match(/\d[\d.,]*/g) ?? [])
    .map((s) => Number(s.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function nearest<T extends { whatsappUsd: number }>(items: T[], amountUsd?: number): T | null {
  if (!amountUsd || amountUsd <= 0) return null;
  const best = items
    .map((item) => ({ item, diff: Math.abs(item.whatsappUsd - amountUsd) }))
    .sort((a, b) => a.diff - b.diff)[0];
  return best && best.diff <= Math.max(0.06, best.item.whatsappUsd * 0.03) ? best.item : null;
}

function findRoblox(text: string, amountUsd?: number) {
  const t = text.toLowerCase();
  if (/plus/.test(t)) {
    if (/1[.,]?000|1k/.test(t)) return ROBLOX_CATALOG.find((p) => p.key === 'plus1000') ?? null;
    if (/500/.test(t)) return ROBLOX_CATALOG.find((p) => p.key === 'plus500') ?? null;
    return ROBLOX_CATALOG.find((p) => p.key === 'plus') ?? null;
  }
  for (const n of numbersIn(t)) {
    const hit = ROBLOX_CATALOG.find((p) => p.robux === n);
    if (hit) return hit;
  }
  return nearest(ROBLOX_CATALOG, amountUsd);
}

function findTikTok(text: string, amountUsd?: number) {
  for (const n of numbersIn(text)) {
    const hit = TIKTOK_CATALOG.find((p) => p.monedas === n);
    if (hit) return hit;
  }
  return nearest(TIKTOK_CATALOG, amountUsd);
}

/**
 * Costo real de tabla para una orden manual de Roblox o TikTok.
 * Devuelve `null` si el juego/paquete no se reconoce (el llamador usa su fallback).
 */
export function resolveManualCatalogCost(input: {
  juego: string;
  paqueteNombre: string;
  montoUsd?: number;
}): { costUsd: number; nombre: string } | null {
  const pieces = input.paqueteNombre
    .split(/\s*,\s*|\s+y\s+|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pieces.length === 0) pieces.push('');

  let cost = 0;
  const names: string[] = [];
  for (const piece of pieces) {
    const context = `${input.juego} ${piece}`;
    const amount = pieces.length === 1 ? input.montoUsd : undefined;
    let hit: ManualCatalogItem | null = null;
    if (/roblox|robux/i.test(context)) hit = findRoblox(piece || input.juego, amount);
    else if (/tik\s*-?\s*tok/i.test(context)) hit = findTikTok(piece || input.juego, amount);
    if (!hit) return null;
    cost += hit.costUsd;
    names.push(hit.nombre);
  }
  return { costUsd: round4(cost), nombre: names.join(' + ') };
}

