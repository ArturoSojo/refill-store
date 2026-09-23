/** Endpoints públicos: configuración de la tienda y catálogo. */
import { Router } from 'express';
import { z } from 'zod';
import { orders } from '../config/firebase';
import { asyncHandler, ok, parseParams, parseQuery } from '../lib/http';
import type { Order } from '../types/models';
import { usdToBs } from '../lib/money';
import { normalizeLadder } from '../lib/tiers';
import * as catalog from '../services/catalog';
import * as modalsService from '../services/modals';
import { getConfig, toPublicConfig } from '../services/settings';
import { buildSupportUrl } from '../services/whatsapp';
import { assertStorefrontGame, belongsToStorefront, resolveStorefront } from '../lib/storefront';
import { PAGE_LIMIT } from '../lib/pagination';

const FAZER_FAMILIES = ['topup', 'gift_card', 'game_key'] as const;
const HOME_CATEGORIES_PER_FAMILY = 8;

export const publicRouter = Router();

/** Estado de salud, útil para monitoreo. */
publicRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    ok(res, { status: 'ok', time: new Date().toISOString() });
  })
);

/** Configuración visible por cualquiera: tasa, datos bancarios, avisos. */
publicRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const config = await getConfig();
    ok(res, {
      ...toPublicConfig(config),
      supportUrl: buildSupportUrl(config.whatsapp.supportNumber),
      // La escalera se sirve entera para que la tienda la pinte tal cual y no
      // tenga que repetir umbrales que luego se desincronizan.
      tiers: normalizeLadder(config.tiers),
    });
  })
);

/**
 * Catálogo de portada.
 * Inefable tiene sólo dos juegos, así que incluye sus paquetes activos para
 * compatibilidad con la versión publicada en Netlify. FazerCards devuelve sólo
 * 8 categorías por familia y sus totales; el listado completo se consulta por
 * familia y las ofertas sólo al abrir una categoría.
 */
publicRouter.get(
  '/catalog',
  asyncHandler(async (req, res) => {
    const config = await getConfig();
    const storefront = resolveStorefront(req);
    const familyQuery = z.object({
      family: z.enum(FAZER_FAMILIES).optional(),
      cursor: z.string().max(400).optional(),
      limit: z.coerce.number().int().min(PAGE_LIMIT.min).max(PAGE_LIMIT.max).default(30),
    });
    const { family, cursor, limit } = parseQuery(req, familyQuery);

    if (storefront === 'fazercards') {
      const families = family ? [family] : [...FAZER_FAMILIES];
      const results = await Promise.all(
        families.map(async (currentFamily) => {
          const [page, total] = await Promise.all([
            family
              ? catalog.pageFazerGamesByFamily(currentFamily, { cursor, limit })
              : catalog.listFazerHomeGamesByFamily(currentFamily, HOME_CATEGORIES_PER_FAMILY).then((items) => ({
                  items,
                  nextCursor: null,
                })),
            family ? Promise.resolve(undefined) : catalog.countFazerGamesByFamily(currentFamily),
          ]);
          return { family: currentFamily, ...page, total };
        })
      );
      ok(res, {
        rate: config.rate.value,
        games: results.flatMap((result) => result.items.map(catalog.toPublicGame)),
        products: [],
        familyCounts: Object.fromEntries(results.flatMap((result) =>
          result.total === undefined ? [] : [[result.family, result.total]]
        )),
        nextCursor: family ? results[0]?.nextCursor ?? null : null,
        total: family ? results[0]?.total : undefined,
      });
      return;
    }

    const gameList = (await catalog.listGames({ onlyActive: true })).filter((game) =>
      belongsToStorefront(game, storefront)
    );
    const productList = (
      await Promise.all(
        gameList.map((game) => catalog.listProducts({ gameId: game.id, onlyActive: true }))
      )
    ).flat();

    ok(res, {
      rate: config.rate.value,
      games: gameList.map(catalog.toPublicGame),
      products: productList.map((product) =>
        catalog.toPublicProduct(product, config.rate.value, config.pricing.roundToBs)
      ),
      familyCounts: {},
    });
  })
);

/** Producto directo para que el checkout no dependa del catálogo entero. */
publicRouter.get(
  '/products/:productId',
  asyncHandler(async (req, res) => {
    const { productId } = parseParams(req, z.object({ productId: z.string().min(1) }));
    const config = await getConfig();
    const product = await catalog.getProduct(productId);
    const game = await catalog.getGame(product.gameId);
    assertStorefrontGame(req, game);
    if (!product.active || !game.active) throw new Error('Producto no disponible.');
    ok(res, {
      rate: config.rate.value,
      game: catalog.toPublicGame(game),
      product: catalog.toPublicProduct(product, config.rate.value, config.pricing.roundToBs),
    });
  })
);

/** Catálogo de un juego concreto. */
publicRouter.get(
  '/games/:gameId',
  asyncHandler(async (req, res) => {
    const { gameId } = parseParams(req, z.object({ gameId: z.string().min(1) }));
    const config = await getConfig();

    const [game, productList] = await Promise.all([
      catalog.getGame(gameId),
      catalog.listProducts({ gameId, onlyActive: true }),
    ]);
    assertStorefrontGame(req, game);

    ok(res, {
      game: catalog.toPublicGame(game),
      rate: config.rate.value,
      products: productList.map((product) =>
        catalog.toPublicProduct(product, config.rate.value, config.pricing.roundToBs)
      ),
    });
  })
);

/**
 * Últimas recargas entregadas, anonimizadas.
 *
 * Alimenta el ticker de actividad de la portada: es prueba social real, no
 * inventada. Se enmascara el nombre y el ID del jugador porque el endpoint es
 * público.
 */
publicRouter.get(
  '/activity',
  asyncHandler(async (_req, res) => {
    const snap = await orders()
      .where('status', '==', 'completed')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const items = snap.docs.map((doc) => {
      const order = doc.data() as Order;
      const name = order.user.displayName ?? order.user.email ?? 'Jugador';

      return {
        id: doc.id,
        // "Carlos" → "Car***"
        who: `${name.slice(0, 3)}***`,
        product: order.productName,
        game: order.gameName,
        gameId: order.gameId,
        at: order.createdAt.toMillis(),
      };
    });

    ok(res, { items });
  })
);

/** Conversión USD → Bs, para previsualizar montos sin crear una orden. */
publicRouter.get(
  '/quote',
  asyncHandler(async (req, res) => {
    const { usd } = parseQuery(req, z.object({ usd: z.coerce.number().positive().max(10_000) }));
    const config = await getConfig();

    ok(res, {
      usd,
      rate: config.rate.value,
      bs: usdToBs(usd, config.rate.value, config.pricing.roundToBs),
    });
  })
);

/**
 * Modales activos de la tienda.
 *
 * Se sirve aparte de `/config` para no engordar una respuesta que pide cada
 * página: los modales sólo hacen falta en la tienda, y el vídeo ya se resuelve
 * aquí a su forma incrustable.
 */
publicRouter.get(
  '/modals',
  asyncHandler(async (_req, res) => {
    const list = await modalsService.list({ onlyActive: true });
    ok(res, {
      modals: list.map((modal) => ({
        ...modal,
        videoUrl: modalsService.toEmbedUrl(modal.videoUrl),
      })),
    });
  })
);
