/** Endpoints públicos: configuración de la tienda y catálogo. */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { orders, playerIdCache, now } from '../config/firebase';
import { centralOneApiKey, centralOneBaseUrl } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { log } from '../lib/logger';
import type { Game, Order } from '../types/models';
import { asyncHandler, ok, parseBody, parseParams, parseQuery } from '../lib/http';
import { usdToBs } from '../lib/money';
import { normalizeLadder } from '../lib/tiers';
import * as catalog from '../services/catalog';
import * as modalsService from '../services/modals';
import { getConfig, toPublicConfig } from '../services/settings';
import { buildSupportUrl } from '../services/whatsapp';
import {
  assertStorefrontGame,
  belongsToStorefront,
  resolveStorefront,
  FAZER_FREE_FIRE_ID,
  INEFABLE_FREE_FIRE_ID,
  INEFABLE_FREE_FIRE_ID_NEW,
} from '../lib/storefront';
import { PAGE_LIMIT } from '../lib/pagination';
import { rateLimit } from '../middleware/rateLimit';
import * as fazerCards from '../services/fazercards';
import * as chatbotService from '../services/chatbot';
import * as centralOne from '../services/centralOne';
import { invalidArgument, providerError } from '../lib/errors';
import { resolveFazerValidationCategory } from '../lib/validation';

/**
 * Familias del catálogo .com. `game_key` queda vacía tras pasar a Central One
 * (no vende keys), pero se conserva: el conteo da 0 y la tienda oculta la
 * sección, mientras que quitarla rompería `?family=game_key` en enlaces viejos.
 */
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
      telegramSupportUrl: `https://t.me/${(config.telegramSupportBotUsername || 'V2RefillBot').replace(/^@/, '')}`,
      // La escalera se sirve entera para que la tienda la pinte tal cual y no
      // tenga que repetir umbrales que luego se desincronizan.
      tiers: normalizeLadder(config.tiers),
    });
  })
);

/**
 * Catálogo de portada.
 * Inefable tiene sólo dos juegos, así que incluye sus paquetes activos para
 * compatibilidad con clientes antiguos. La tienda .com (catálogo sincronizado
 * de Central One, y de FazerCards mientras conviva) devuelve sólo 8 categorías
 * por familia y sus totales; el listado completo se consulta por familia y las
 * ofertas sólo al abrir una categoría.
 *
 * Totales: el conteo del catálogo sincronizado sólo incluye
 * `provider in ['fazercards','centralone']`; los juegos de Inefable que se
 * añaden a mano (Free Fire y los manuales) se suman aparte, una vez cada uno.
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
                ? catalog.searchStorefrontGamesByFamily(currentFamily, search, { cursor, limit })
                : catalog.pageStorefrontGamesByFamily(currentFamily, { cursor, limit })
              : catalog.listStorefrontHomeGamesByFamily(currentFamily, HOME_CATEGORIES_PER_FAMILY).then((items) => ({
                  items,
                  nextCursor: null,
                  total: undefined,
                })),
            family ? Promise.resolve(undefined) : catalog.countStorefrontGamesByFamily(currentFamily),
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
        // En portada los dos Free Fire de Inefable llegan fijados (no por el
        // conteo ni como «extras»), así que se suman aquí, cada uno una vez.
        // Antes sólo contaba `free-fire` y `freefire-id` quedaba fuera del total.
        familyCounts: Object.fromEntries(results.flatMap((result) =>
          result.categoryTotal === undefined ? [] : [[result.family, result.categoryTotal +
            (result.family === 'topup'
              ? result.items.filter((game) => game.id === INEFABLE_FREE_FIRE_ID || game.id === INEFABLE_FREE_FIRE_ID_NEW).length
              : 0)]]
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
 * Valida un Player ID en tiempo real usando Central One v1 con caché inteligente.
 * Endpoint público protegido con rate-limiting por IP.
 */
publicRouter.post(
  ['/public/validate-player', '/validate-player'],
  rateLimit({
    name: 'validate_player_public',
    max: 30,
    windowSeconds: 60,
    message: 'Has realizado varias consultas seguidas. Espera un momento antes de intentar de nuevo.',
  }),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        gameSlug: z.string().trim().min(1),
        playerId: z.string().trim().min(1),
        serverId: z.string().trim().optional().nullable(),
      })
    );

    const result = await centralOne.validatePlayerId({
      gameSlug: body.gameSlug,
      playerId: body.playerId,
      serverId: body.serverId ?? undefined,
    });

    ok(res, {
      status: result.status,
      playerName: result.playerName,
      message: result.message,
      supported: result.supported,
      cached: result.cached,
    });
  })
);

// ---------------------------------------------------------------------------
// Validación genérica para los juegos del catálogo de Central One
// ---------------------------------------------------------------------------

/**
 * Central One permite 30 validaciones por minuto para TODA la cuenta, y el
 * límite por IP de la ruta se esquiva cambiando de IP. Por eso las consultas
 * de los juegos `co-*` pasan además por un cupo global compartido (Firestore,
 * clave constante) un poco por debajo del tope, para dejar aire a los reintentos
 * del despacho. Se consume sólo si no hubo acierto de caché.
 */
const CENTRAL_ONE_VALIDATE_GLOBAL = { max: 25, windowSeconds: 60 } as const;
const centralOneValidateBudget = rateLimit({
  name: 'centralone_validate',
  max: CENTRAL_ONE_VALIDATE_GLOBAL.max,
  windowSeconds: CENTRAL_ONE_VALIDATE_GLOBAL.windowSeconds,
  keyResolver: () => 'centralone_validate_global',
});

/** `true` si queda cupo global. Si Firestore falla, el middleware deja pasar. */
function consumeCentralOneValidateBudget(req: Request, res: Response): Promise<boolean> {
  return new Promise((resolve) => {
    void centralOneValidateBudget(req, res, (error?: unknown) => resolve(!error));
  });
}

const CENTRAL_ONE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNVERIFIED_MESSAGE =
  'No fue posible verificar el nombre en este momento. Asegúrate de que el ID sea correcto.';

type GameValidationResponse = {
  valid: boolean;
  playerName: string | null;
  region: null;
  status: 'valid' | 'invalid' | 'unverified';
  message?: string;
};

function unverifiedResponse(message = UNVERIFIED_MESSAGE): GameValidationResponse {
  // «Sin verificar» nunca bloquea la compra: el comprador sigue bajo su
  // responsabilidad, igual que con el camino por slug.
  return { valid: true, playerName: null, region: null, status: 'unverified', message };
}

/**
 * `POST /player/validate` sobre una oferta concreta. Nunca lanza; sin reintentos
 * (cada intento gasta cupo de la cuenta) y con el mismo timeout que el
 * validador por slug.
 */
async function callCentralOneValidate(
  productId: string,
  targetPayload: Record<string, string>
): Promise<{ status: 'valid' | 'invalid' | 'unverified'; playerName: string | null; reason: string | null }> {
  const apiKey = centralOneApiKey();
  if (!apiKey) return { status: 'unverified', playerName: null, reason: 'not_configured' };
  try {
    const response = await fetchJson<{ status?: unknown; player?: { name?: unknown } | null; reason?: unknown }>(
      `${centralOneBaseUrl().replace(/\/+$/, '')}/player/validate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: { product_id: productId, target_payload: targetPayload },
        timeoutMs: 10_000,
        retries: 0,
      }
    );
    if (!response.ok) {
      log.warn('Central One rechazó la validación de ID', { status: response.status, productId });
      return { status: 'unverified', playerName: null, reason: `http_${response.status}` };
    }
    const status = response.data?.status;
    const rawName = response.data?.player?.name;
    const playerName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
    if (status === 'valid') return { status: 'valid', playerName, reason: null };
    if (status === 'invalid') return { status: 'invalid', playerName: null, reason: null };
    const reason = response.data?.reason;
    return { status: 'unverified', playerName: null, reason: typeof reason === 'string' ? reason : 'unverified' };
  } catch (error) {
    log.warn('Fallo de red o timeout validando ID en Central One', {
      productId,
      error: error instanceof Error ? error.name : String(error),
    });
    return { status: 'unverified', playerName: null, reason: 'network_error' };
  }
}

/**
 * Valida contra Central One un juego de su catálogo (`provider: 'centralone'`).
 *
 * No usa el mapa fijo por slug (`CENTRAL_ONE_SUPPORTED_GAMES`): un id como
 * `co-topup-free-fire-global` caería en el `product_id` de Free Fire LATAM y
 * validaría contra otra región. Aquí manda la oferta real del juego —la que
 * eligió el comprador si es de este juego, si no la primera activa— y el
 * `target_payload` lleva exactamente las claves que esa oferta declara.
 */
async function validateCentralOneCatalogGame(
  req: Request,
  res: Response,
  game: Game,
  input: { playerId: string; zoneId: string; fields: Record<string, string>; productId?: string }
): Promise<GameValidationResponse> {
  if (!game.validatesPlayerId || game.requiresPlayerData === false) {
    return unverifiedResponse('Este juego no admite comprobación previa del ID. Revisa el dato antes de pagar.');
  }
  if (!centralOne.isCentralOneConfigured()) return unverifiedResponse();

  const productList = await catalog.listProducts({ gameId: game.id, onlyActive: true });
  const target = catalog.pickCentralOneValidationTarget(game, productList, input.productId ?? null);
  if (!target || target.targetFields.length === 0) return unverifiedResponse();

  const payload = centralOne.buildTargetPayloadFromFields(target.targetFields, input.fields, {
    playerId: input.playerId,
    playerId2: input.zoneId || null,
  });
  const missing = target.targetFields.find((key) => !payload[key]);
  if (missing) {
    const label = catalog.resolvePlayerFields(game).find((field) => field.key === missing)?.label ?? missing;
    throw invalidArgument(`Completa «${label}» para verificar.`);
  }

  // Caché por juego y datos de la cuenta (no por oferta: la cuenta es la misma
  // en todo el juego). Sólo se guardan los `valid`, como en el validador por slug.
  const cacheKey = centralOne.buildCacheKey(
    game.id,
    target.targetFields.map((key) => payload[key]).join('__')
  );
  try {
    const cached = await playerIdCache().doc(cacheKey).get();
    const data = cached.exists ? cached.data() : undefined;
    const cachedAtMs = typeof data?.cachedAt?.toMillis === 'function' ? data.cachedAt.toMillis() : 0;
    if (data?.status === 'valid' && cachedAtMs > 0 && Date.now() - cachedAtMs < CENTRAL_ONE_CACHE_TTL_MS) {
      return { valid: true, playerName: data.playerName ?? null, region: null, status: 'valid' };
    }
  } catch (error) {
    log.warn('Error al consultar caché de playerIdCache', { error: String(error) });
  }

  if (!(await consumeCentralOneValidateBudget(req, res))) {
    log.warn('Cupo global de validaciones de Central One agotado', CENTRAL_ONE_VALIDATE_GLOBAL);
    return unverifiedResponse('Hay muchas verificaciones en este momento. Revisa el dato antes de pagar o intenta en un minuto.');
  }

  const result = await callCentralOneValidate(target.productId, payload);
  if (result.status === 'valid') {
    playerIdCache()
      .doc(cacheKey)
      .set({
        gameSlug: game.id,
        playerId: input.playerId,
        serverId: input.zoneId || null,
        playerName: result.playerName,
        status: 'valid',
        cachedAt: now(),
        updatedAt: now(),
      })
      .catch((error) => log.warn('Fallo al escribir en playerIdCache', { error: String(error) }));
    return { valid: true, playerName: result.playerName, region: null, status: 'valid' };
  }
  if (result.status === 'invalid') {
    return {
      valid: false,
      playerName: null,
      region: null,
      status: 'invalid',
      message: 'El ID ingresado no existe en este juego. Verifica tus datos.',
    };
  }
  return unverifiedResponse(
    result.reason === 'not_supported' ? 'Este juego no admite comprobación previa del ID. Revisa el dato antes de pagar.' : UNVERIFIED_MESSAGE
  );
}

/** Valida Player ID / User ID antes de ordenar. Esta consulta no crea una orden. */
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
        /** Oferta elegida: en los juegos de Central One se valida contra ella. */
        productId: z.string().trim().max(200).optional(),
      })
    );

    const rawFields = body.fields ?? {};
    const playerId = (
      body.playerId ||
      rawFields.player_id ||
      rawFields.game_user_id ||
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

    const game = await catalog.getGame(gameId).catch(() => null);

    // Catálogo de Central One: va antes del camino por slug porque
    // `isSupportedGame` reconoce cualquier id que contenga «free-fire» o
    // «blood-strike», también los `co-*`, y los mandaría al producto fijo.
    if (game?.provider === 'centralone') {
      return ok(
        res,
        await validateCentralOneCatalogGame(req, res, game, {
          playerId,
          zoneId,
          fields: rawFields,
          productId: body.productId,
        })
      );
    }

    if (centralOne.isSupportedGame(gameId)) {
      const cOneResult = await centralOne.validatePlayerId({
        gameSlug: gameId,
        playerId,
        serverId: zoneId || undefined,
      });

      if (cOneResult.status === 'valid') {
        return ok(res, {
          valid: true,
          playerName: cOneResult.playerName,
          region: null,
          status: 'valid',
        });
      }

      if (cOneResult.status === 'invalid') {
        return ok(res, {
          valid: false,
          playerName: null,
          region: null,
          status: 'invalid',
          message: cOneResult.message,
        });
      }

      const normalized = centralOne.normalizeGameSlug(gameId);
      const isFazerSupported =
        normalized &&
        ['free-fire', 'pubg-mobile', 'mobile-legends'].includes(normalized);

      if (!fazerCards.isFazerCardsConfigured() || !isFazerSupported) {
        return ok(res, {
          valid: true,
          playerName: null,
          region: null,
          status: 'unverified',
          message: cOneResult.message,
        });
      }
    }

    const categoryInfo = resolveFazerValidationCategory(game ?? { id: gameId });

    if (!categoryInfo || !fazerCards.isFazerCardsConfigured()) {
      throw invalidArgument('Esta categoría no soporta validación de ID.');
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

    return ok(res, result);
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
