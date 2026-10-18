/** Endpoints públicos: configuración de la tienda y catálogo. */
import { Router } from 'express';
import { z } from 'zod';
import { orders } from '../config/firebase';
import { asyncHandler, ok, parseBody, parseParams, parseQuery } from '../lib/http';
import type { Order } from '../types/models';
import { usdToBs } from '../lib/money';
import { normalizeLadder } from '../lib/tiers';
import * as catalog from '../services/catalog';
import * as modalsService from '../services/modals';
import { getConfig, toPublicConfig } from '../services/settings';
import { buildSupportUrl } from '../services/whatsapp';
import { assertStorefrontGame, belongsToStorefront, resolveStorefront, FAZER_FREE_FIRE_ID, INEFABLE_FREE_FIRE_ID } from '../lib/storefront';
import { PAGE_LIMIT } from '../lib/pagination';
import { rateLimit } from '../middleware/rateLimit';
import * as fazerCards from '../services/fazercards';
import * as chatbotService from '../services/chatbot';
import { invalidArgument, providerError } from '../lib/errors';
import { resolveFazerValidationCategory } from '../lib/validation';

const FAZER_FAMILIES = ['topup', 'gift_card', 'game_key'] as const;
const HOME_CATEGORIES_PER_FAMILY = 8;

export const publicRouter = Router();

const chatbotAnswerSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(1500),
      })
    )
    .min(1)
    .max(12)
    .superRefine((messages, context) => {
      if (messages[messages.length - 1]?.role !== 'user') {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'El último mensaje debe ser una pregunta.' });
      }
    }),
});

/** Estado de salud, útil para monitoreo. */
publicRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    ok(res, { status: 'ok', time: new Date().toISOString() });
  })
);

/** Respuesta pública del asistente de preguntas, fundamentada en datos del servidor. */
publicRouter.post(
  '/chatbot/answer',
  rateLimit({
    name: 'support_chatbot',
    max: 20,
    windowSeconds: 300,
    message: 'Enviaste varias preguntas seguidas. Espera un momento e inténtalo de nuevo.',
  }),
  asyncHandler(async (req, res) => {
    const { messages } = parseBody(req, chatbotAnswerSchema);
    const answer = await chatbotService.answerSupportQuestion(messages, resolveStorefront(req));
    ok(res, answer);
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
 * compatibilidad con clientes antiguos. FazerCards devuelve sólo
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
      search: z.string().trim().min(2).max(60).optional(),
      cursor: z.string().max(400).optional(),
      limit: z.coerce.number().int().min(PAGE_LIMIT.min).max(PAGE_LIMIT.max).default(30),
    });
    const { family, search, cursor, limit } = parseQuery(req, familyQuery);

    if (storefront === 'fazercards') {
      const families = family ? [family] : [...FAZER_FAMILIES];
      const results = await Promise.all(
        families.map(async (currentFamily) => {
          const [page, total] = await Promise.all([
            family
              ? search
                ? catalog.searchFazerGamesByFamily(currentFamily, search, { cursor, limit })
                : catalog.pageFazerGamesByFamily(currentFamily, { cursor, limit })
              : catalog.listFazerHomeGamesByFamily(currentFamily, HOME_CATEGORIES_PER_FAMILY).then((items) => ({
                  items,
                  nextCursor: null,
                  total: undefined,
                })),
            family ? Promise.resolve(undefined) : catalog.countFazerGamesByFamily(currentFamily),
          ]);
          if (currentFamily === 'topup' && family && !cursor && (!search || 'free-fire'.includes(search.toLowerCase()) || 'freefire'.includes(search.toLowerCase()) || search.toLowerCase().includes('free'))) {
            const inefableGames = await Promise.all([
              catalog.getGame('freefire-id').catch(() => null),
              catalog.getGame(INEFABLE_FREE_FIRE_ID).catch(() => null),
            ]);
            for (const freeFire of inefableGames) {
              if (freeFire?.active && freeFire.provider === 'inefable' && !page.items.some((g) => g.id === freeFire.id)) {
                const fazerIndex = page.items.findIndex((item) => item.id === FAZER_FREE_FIRE_ID);
                page.items.splice(fazerIndex >= 0 ? fazerIndex + 1 : 0, 0, freeFire);
                if (page.total !== undefined) page.total += 1;
              }
            }
          }
          let extraCount = 0;
          if (currentFamily === 'topup' && !cursor) {
            const term = search?.toLowerCase();
            const known = new Set(page.items.map((item) => item.id));
            const extras = (await catalog.listManualInefableGames()).filter(
              (game) => !known.has(game.id) && (!term || game.name.toLowerCase().includes(term))
            );
            page.items.push(...extras);
            if (page.total !== undefined) page.total += extras.length;
            extraCount = extras.length;
          }
          return {
            family: currentFamily,
            ...page,
            categoryTotal: total === undefined ? undefined : total + extraCount,
          };
        })
      );
      ok(res, {
        rate: config.rate.value,
        games: results.flatMap((result) => result.items.map(catalog.toPublicGame)),
        products: [],
        familyCounts: Object.fromEntries(results.flatMap((result) =>
          result.categoryTotal === undefined ? [] : [[result.family, result.categoryTotal +
            Number(result.family === 'topup' && result.items.some((game) => game.id === INEFABLE_FREE_FIRE_ID))]]
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

/** Valida Player ID / User ID en FazerCards antes de ordenar. Esta consulta no crea una orden. */
publicRouter.post(
  '/games/:gameId/validate-player',
  rateLimit({
    name: 'player_id_validation',
    max: 15,
    windowSeconds: 300,
    message: 'Hiciste varias verificaciones seguidas. Espera unos minutos.',
  }),
  asyncHandler(async (req, res) => {
    const { gameId } = parseParams(req, z.object({ gameId: z.string().min(1) }));
    const body = parseBody(
      req,
      z.object({
        playerId: z.string().trim().optional(),
        zoneId: z.string().trim().optional(),
        fields: z.record(z.string()).optional(),
      })
    );

    const game = await catalog.getGame(gameId).catch(() => null);
    const categoryInfo = resolveFazerValidationCategory(game ?? { id: gameId });

    if (!categoryInfo || !fazerCards.isFazerCardsConfigured()) {
      throw invalidArgument('Esta categoría no soporta validación de ID.');
    }

    const rawFields = body.fields ?? {};
    const playerId = (
      body.playerId ||
      rawFields.player_id ||
      rawFields.playerId ||
      rawFields.userId ||
      rawFields.user_id ||
      ''
    ).trim();

    const zoneId = (
      body.zoneId ||
      rawFields.zone_id ||
      rawFields.zoneId ||
      rawFields.server_id ||
      rawFields.serverId ||
      ''
    ).trim();

    if (!playerId) {
      throw invalidArgument('Debes ingresar tu Player ID / User ID para verificar.');
    }

    const needsZone = categoryInfo.requiredFields.includes('zone_id');
    if (needsZone && !zoneId) {
      throw invalidArgument('Debes ingresar tu Zone ID para verificar.');
    }

    const fieldsToValidate: Record<string, string> = { player_id: playerId };
    if (needsZone) {
      fieldsToValidate.zone_id = zoneId;
    }

    let result: fazerCards.FazerPlayerValidation;
    try {
      result = await fazerCards.validatePlayerId(categoryInfo.categoryId, fieldsToValidate);
    } catch (error) {
      if (error && typeof error === 'object' && (error as any).status === 400) {
        throw invalidArgument((error as Error).message || 'Esta categoría no soporta validación de ID.');
      }
      const message = error instanceof Error ? error.message : 'No se pudo verificar el ID con FazerCards.';
      throw providerError(message);
    }

    ok(res, result);
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
