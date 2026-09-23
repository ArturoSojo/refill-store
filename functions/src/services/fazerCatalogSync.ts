/**
 * Sincroniza el catálogo vendible de FazerCards con Refill Store.
 *
 * Las categorías importadas viven en documentos nuevos (`fz-*`), por lo que
 * nunca se reescriben los juegos ni las órdenes históricas de Inefable.
 */
import { games, now, products } from '../config/firebase';
import { applyMargin, round } from '../lib/money';
import { slugify } from '../lib/ids';
import { getConfig } from './settings';
import * as fazercards from './fazercards';
import type { PlayerField } from '../types/models';

type Family = 'topup' | 'gift_card' | 'game_key';

const LATAM = new Set([
  'LATAM', 'GLOBAL', 'WORLD', 'WORLDWIDE', 'VE', 'CO', 'MX', 'AR', 'BR', 'CL', 'PE', 'EC', 'BO',
  'PY', 'UY', 'CR', 'PA', 'DO', 'GT', 'HN', 'SV', 'NI', 'PR', 'CU', 'AMERICAS',
]);

const FOREIGN_REGION = /\b(?:CIS|MENA|ASIA|SEA|EU|UK|US|CA|RU|UA|TR|IN|ID|MY|PH|TH|KR|JP|CN|TW|HK|AU|NZ|AFRICA|AE|SA)\b/i;

function visibleInLatam(name: string, note: string | null, region: string | null): boolean {
  const source = `${region ?? ''} ${(name ?? '')} ${note ?? ''}`.toUpperCase();
  const tokens = source.match(/\b[A-Z]{2,12}\b/g) ?? [];
  if (tokens.some((token) => LATAM.has(token))) return true;
  // Sin región declarada es común en recargas globales; se mantiene visible.
  return !FOREIGN_REGION.test(source);
}

function gameId(family: Family, categoryId: string) {
  return `fz-${family}-${slugify(categoryId)}`;
}

function productId(category: string, offer: string) {
  return `${category}--${slugify(offer)}`;
}

function familyMeta(family: Family) {
  if (family === 'gift_card') return { label: 'Gift cards', icon: '🎁', color: '#10B981' };
  if (family === 'game_key') return { label: 'Game keys', icon: '🔑', color: '#3B82F6' };
  return { label: 'Recargas', icon: '🎮', color: '#F03030' };
}

/** Prioridad inicial de categorías en portada; las demás se ordenan después. */
const HOME_CATEGORY_ORDER: Partial<Record<Family, Record<string, number>>> = {
  topup: {
    'fz-topup-free-fire-latam': 10,
    'fz-topup-blood-strike': 20,
    'fz-topup-pubg-mobile-auto': 30,
    'fz-topup-mobile-legends-global': 40,
    'fz-topup-delta-force': 50,
    'fz-topup-genshin-impact-global': 60,
  },
  gift_card: {
    'fz-gift_card-google-play-es': 10,
    'fz-gift_card-app-store-itunes-es': 20,
    'fz-gift_card-app-store-itunes-mx': 30,
    'fz-gift_card-steam-wallet-mx': 40,
  },
};

function categorySortOrder(family: Family, id: string): number {
  return HOME_CATEGORY_ORDER[family]?.[id] ?? 100;
}

function parseAmount(name: string): number {
  const match = name.replace(/,/g, '').match(/\b(\d{1,6})\b/);
  return match ? Number(match[1]) : 1;
}

function fieldsFromProvider(raw: Record<string, unknown>[]): PlayerField[] {
  return raw
    .map((field) => {
      const providerKey = String(field.key ?? '').trim();
      if (!providerKey) return null;
      const type = String(field.type ?? 'text').toLowerCase();
      return {
        key: providerKey,
        label: String(field.label ?? providerKey),
        pattern: type === 'number' ? '^\\d{1,30}$' : '^.{1,120}$',
        help: 'Revisa este dato antes de pagar: una entrega al identificador equivocado no se puede recuperar.',
        placeholder: '',
        type: type === 'number' ? 'number' : 'text',
        providerField: null,
        required: true,
        sensitive: /pass|password|secret/i.test(providerKey),
      } as PlayerField;
    })
    .filter((field): field is PlayerField => field !== null);
}

export interface FazerCatalogSummary {
  createdGames: number;
  updatedGames: number;
  createdProducts: number;
  updatedProducts: number;
  skipped: number;
  errors: string[];
  family: Family;
  offset: number;
  nextOffset: number;
  totalCategories: number;
  done: boolean;
}

/**
 * Lee todas las categorías de recargas, tarjetas y keys permitidas para LATAM.
 * Los precios se recalculan con el margen vigente de la tienda.
 */
export async function syncFazerCatalog(input: { family: Family; offset: number; limit: number }): Promise<FazerCatalogSummary> {
  const config = await getConfig();
  const summary: FazerCatalogSummary = {
    createdGames: 0,
    updatedGames: 0,
    createdProducts: 0,
    updatedProducts: 0,
    skipped: 0,
    errors: [],
    family: input.family,
    offset: input.offset,
    nextOffset: input.offset,
    totalCategories: 0,
    done: false,
  };
  const timestamp = now();
  const family = input.family;
  const listed = await fazercards.listFazerCategories(family);
  if (!listed.ok) {
    summary.errors.push(`${family}: ${listed.message ?? 'no se pudo listar'}`);
    return summary;
  }
  summary.totalCategories = listed.items.length;
  const selected = listed.items.slice(input.offset, input.offset + input.limit);
  summary.nextOffset = input.offset + selected.length;
  summary.done = summary.nextOffset >= listed.items.length;

  await Promise.all(selected.map(async (category) => {
      if (!visibleInLatam(category.name, category.note, category.region)) {
        summary.skipped += 1;
        return;
      }

      const detail = await fazercards.getFazerOffers(family, category.categoryId);
      if (!detail.ok || detail.offers.length === 0) {
        summary.skipped += 1;
        if (!detail.ok) summary.errors.push(`${family}/${category.categoryId}: ${detail.message ?? 'sin detalle'}`);
        return;
      }

      const id = gameId(family, category.categoryId);
      const existingGame = await games().doc(id).get();
      const meta = familyMeta(family);
      const playerFields = family === 'topup' ? fieldsFromProvider(detail.fields) : [];
      const minPriceUsd = Math.min(
        ...detail.offers.map((offer) => applyMargin(offer.priceUsd, config.pricing.defaultMarginPercent, config.pricing.roundToUsd))
      );

      await games().doc(id).set(
        {
          name: detail.name || category.name,
          shortName: detail.name || category.name,
          apiGameId: category.categoryId,
          apiGameType: family,
          provider: 'fazercards',
          providerFamily: family,
          requiresPlayerData: family === 'topup',
          region: category.region,
          platform: category.platform,
          currencyLabel: meta.label,
          currencyIcon: meta.icon,
          currencyIconUrl: '',
          playerFields,
          validatesPlayerId: false,
          playerIdLabel: playerFields[0]?.label ?? '',
          playerIdPattern: playerFields[0]?.pattern ?? '',
          playerIdHelp: playerFields[0]?.help ?? '',
          howToFindId: family === 'topup' ? ['Abre el juego y copia los datos que solicita el formulario.'] : [],
          logoUrl: detail.imageUrl || category.imageUrl || '',
          coverUrl: detail.imageUrl || category.imageUrl || '',
          accentColor: meta.color,
          accentColorSecondary: family === 'gift_card' ? '#059669' : family === 'game_key' ? '#2563EB' : '#B01B1B',
          active: true,
          sortOrder: categorySortOrder(family, id),
          productCount: detail.offers.length,
          minPriceUsd: round(minPriceUsd, 2),
          providerSyncedAt: timestamp,
          createdAt: existingGame.exists ? existingGame.data()?.createdAt ?? timestamp : timestamp,
          updatedAt: timestamp,
        },
        { merge: true }
      );
      if (existingGame.exists) summary.updatedGames += 1;
      else summary.createdGames += 1;

      for (const offer of detail.offers) {
        const pid = productId(id, offer.offerId);
        const existingProduct = await products().doc(pid).get();
        const priceUsd = applyMargin(offer.priceUsd, config.pricing.defaultMarginPercent, config.pricing.roundToUsd);
        await products().doc(pid).set(
          {
            gameId: id,
            sku: `FZ-${family === 'topup' ? 'TOP' : family === 'gift_card' ? 'GIFT' : 'KEY'}-${offer.offerId}`.slice(0, 40),
            name: offer.name,
            description:
              family === 'gift_card'
                ? 'Código digital para canjear en la región indicada.'
                : family === 'game_key'
                  ? 'Clave digital para la plataforma indicada.'
                  : `Recarga automática de ${detail.name || category.name}.`,
            fulfillment: 'auto',
            manualFlow: 'notify',
            kind: family === 'topup' ? 'package' : 'special',
            amount: family === 'topup' ? parseAmount(offer.name) : 1,
            bonus: 0,
            costUsd: offer.priceUsd,
            priceUsd,
            compareAtUsd: null,
            calls: [{ packageId: offer.offerId, quantity: 1 }],
            providerOfferId: offer.offerId,
            imageUrl: detail.imageUrl || category.imageUrl || '',
            badge: family === 'gift_card' ? 'GIFT CARD' : family === 'game_key' ? 'KEY' : null,
            active: offer.stock === null || offer.stock > 0,
            featured: false,
            sortOrder: family === 'topup' ? parseAmount(offer.name) : 99,
            stock: offer.stock,
            deliveryEtaMinutes: family === 'topup' ? 2 : 5,
            providerSyncedAt: timestamp,
            createdAt: existingProduct.exists ? existingProduct.data()?.createdAt ?? timestamp : timestamp,
            updatedAt: timestamp,
          },
          { merge: true }
        );
        if (existingProduct.exists) summary.updatedProducts += 1;
        else summary.createdProducts += 1;
      }
  }));

  return summary;
}
