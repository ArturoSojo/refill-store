/**
 * Panel de administración.
 *
 * Todo aquí exige rol staff; las operaciones que mueven dinero o permisos
 * exigen además rol admin. Cada acción sensible queda en la bitácora.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  games,
  products,
  users,
  tickets,
  orders,
  coupons,
  now,
  Timestamp,
} from '../config/firebase';
import { asyncHandler, clientIp, ok, parseBody, parseParams, parseQuery } from '../lib/http';
import { failedPrecondition, invalidArgument, notFound } from '../lib/errors';
import { applyMargin, round } from '../lib/money';
import { slugify } from '../lib/ids';
import { requireAuth, requireStaff, requireAdmin, currentUser } from '../middleware/auth';
import * as ordersService from '../services/orders';
import * as usersService from '../services/users';
import * as catalog from '../services/catalog';
import * as couponsService from '../services/coupons';
import * as statsService from '../services/stats';
import * as rateService from '../services/rate';
import * as audit from '../services/audit';
import * as notificationsService from '../services/notifications';
import * as pabilo from '../services/pabilo';
import * as inefable from '../services/inefable';
import { listEvents } from '../services/orderEvents';
import { getConfig, updateConfig } from '../services/settings';
import { seedCatalog } from '../seed/catalog.seed';
import * as alertsService from '../services/adminAlerts';
import { DEFAULT_PLAYER_FIELD } from '../types/models';
import type { Coupon, Order, Ticket, UserProfile } from '../types/models';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireStaff);

const idParam = z.object({ id: z.string().min(1) });

// ===========================================================================
// Dashboard
// ===========================================================================

adminRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const { days } = parseQuery(
      req,
      z.object({ days: z.coerce.number().int().min(1).max(90).default(30) })
    );

    const [totals, previousTotals, series, counters, config] = await Promise.all([
      statsService.getTotals(days),
      // Periodo anterior del mismo largo, para calcular la variación.
      statsService.getTotals(days * 2),
      statsService.getSeries(days),
      statsService.getLiveCounters(),
      getConfig(),
    ]);

    const previous = {
      revenueUsd: round(previousTotals.revenueUsd - totals.revenueUsd, 2),
      orders: previousTotals.orders - totals.orders,
      profitUsd: round(previousTotals.profitUsd - totals.profitUsd, 2),
    };

    const change = (current: number, before: number) =>
      before > 0 ? round(((current - before) / before) * 100, 1) : current > 0 ? 100 : 0;

    ok(res, {
      days,
      totals,
      counters,
      series,
      trends: {
        revenue: change(totals.revenueUsd, previous.revenueUsd),
        orders: change(totals.orders, previous.orders),
        profit: change(totals.profitUsd, previous.profitUsd),
      },
      rate: config.rate,
      maintenanceMode: config.features.maintenanceMode,
    });
  })
);

/**
 * Estado de las integraciones externas.
 *
 * Incluye el saldo de la cuenta de revendedor: si se agota, todas las recargas
 * automáticas empiezan a fallar y hasta ahora no había forma de verlo desde el
 * panel —había que deducirlo de las órdenes rotas—.
 */
adminRouter.get(
  '/providers/status',
  asyncHandler(async (_req, res) => {
    const [balance, pabiloHealth] = await Promise.all([
      inefable.isInefableConfigured()
        ? inefable.getBalance()
        : Promise.resolve({
            ok: false,
            balanceUsd: null,
            accountName: null,
            message: 'Sin API key.',
          }),
      // No basta con que el secreto exista: la cuenta puede haber dejado de
      // existir en Pabilo y los pagos fallarían sin que nadie se entere.
      pabilo.checkAccount(),
    ]);

    ok(res, {
      pabilo: pabiloHealth,
      inefable: {
        configured: inefable.isInefableConfigured(),
        reachable: balance.ok,
        balanceUsd: balance.balanceUsd,
        accountName: balance.accountName,
        message: balance.message,
      },
    });
  })
);

/** Top de productos del periodo, resuelto contra el catálogo. */
adminRouter.get(
  '/top-products',
  asyncHandler(async (req, res) => {
    const { days, limit } = parseQuery(
      req,
      z.object({
        days: z.coerce.number().int().min(1).max(90).default(30),
        limit: z.coerce.number().int().min(1).max(20).default(8),
      })
    );

    const totals = await statsService.getTotals(days);
    const catalogProducts = await catalog.listProducts();
    const byId = new Map(catalogProducts.map((product) => [product.id, product]));

    const top = Object.entries(totals.byProduct)
      .map(([productId, value]) => ({
        productId,
        name: byId.get(productId)?.name ?? productId,
        gameId: byId.get(productId)?.gameId ?? null,
        orders: value.orders,
        revenueUsd: round(value.revenueUsd, 2),
      }))
      .sort((a, b) => b.revenueUsd - a.revenueUsd)
      .slice(0, limit);

    ok(res, { products: top, byGame: totals.byGame });
  })
);

// ===========================================================================
// Órdenes
// ===========================================================================

const adminOrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  status: z.string().optional(),
  gameId: z.string().optional(),
  fulfillment: z.enum(['auto', 'manual']).optional(),
  playerId: z.string().optional(),
  uid: z.string().optional(),
  before: z.coerce.number().int().optional(),
});

adminRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const query = parseQuery(req, adminOrdersQuery);

    const list = await ordersService.listOrders({
      uid: query.uid,
      gameId: query.gameId,
      fulfillment: query.fulfillment,
      playerId: query.playerId,
      status: query.status
        ? (query.status.split(',') as Parameters<typeof ordersService.listOrders>[0]['status'])
        : undefined,
      limit: query.limit,
      beforeMillis: query.before,
    });

    ok(res, {
      orders: list,
      nextCursor:
        list.length === query.limit ? list[list.length - 1].createdAt.toMillis() : null,
    });
  })
);

/** Búsqueda por código de orden, ID de jugador o referencia. */
adminRouter.get(
  '/orders/search',
  asyncHandler(async (req, res) => {
    const { q } = parseQuery(req, z.object({ q: z.string().trim().min(3).max(40) }));
    const term = q.trim();

    const [byCode, byPlayer, byReference] = await Promise.all([
      orders().where('code', '==', term.toUpperCase()).limit(10).get(),
      orders().where('playerId', '==', term).orderBy('createdAt', 'desc').limit(10).get(),
      orders()
        .where('payment.reference', '==', term.replace(/\D/g, ''))
        .limit(10)
        .get(),
    ]);

    const found = new Map<string, Order>();
    for (const snap of [byCode, byPlayer, byReference]) {
      snap.docs.forEach((doc) => found.set(doc.id, { id: doc.id, ...doc.data() } as Order));
    }

    ok(res, { orders: Array.from(found.values()) });
  })
);

adminRouter.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const [order, events] = await Promise.all([ordersService.getOrder(id), listEvents(id)]);
    const [profile, game] = await Promise.all([
      usersService.getProfileOrNull(order.uid),
      catalog.getGame(order.gameId).catch(() => null),
    ]);

    ok(res, {
      order,
      events,
      customer: profile,
      // Sin esto, una orden de Mobile Legends mostraría `zoneId: 2345` con la
      // clave interna en lugar de «Zone ID».
      playerFieldLabels: game
        ? catalog.resolvePlayerFields(game).map((field) => ({
            key: field.key,
            label: field.label,
            sensitive: field.sensitive,
          }))
        : [],
    });
  })
);

adminRouter.post(
  '/orders/:id/retry',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const order = await ordersService.retryDispatch(currentUser(req), id);
    ok(res, { order });
  })
);

adminRouter.post(
  '/orders/:id/complete',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { note } = parseBody(req, z.object({ note: z.string().trim().max(300).optional() }));
    const order = await ordersService.markCompleted(currentUser(req), id, note ?? null);
    ok(res, { order });
  })
);

adminRouter.post(
  '/orders/:id/refund',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({
        toWallet: z.boolean().default(true),
        note: z.string().trim().max(300).optional(),
      })
    );
    const order = await ordersService.refundOrder(currentUser(req), id, {
      toWallet: body.toWallet,
      note: body.note ?? null,
    });
    ok(res, { order });
  })
);

adminRouter.post(
  '/orders/:id/note',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { note } = parseBody(req, z.object({ note: z.string().trim().max(1000) }));
    const order = await ordersService.setAdminNote(currentUser(req), id, note);
    ok(res, { order });
  })
);

/** Exportación CSV del periodo indicado. */
adminRouter.get(
  '/orders/export/csv',
  asyncHandler(async (req, res) => {
    const { limit } = parseQuery(
      req,
      z.object({ limit: z.coerce.number().int().min(1).max(2000).default(500) })
    );

    const list = await ordersService.listOrders({ limit });
    const header = [
      'codigo',
      'fecha',
      'estado',
      'juego',
      'producto',
      'modalidad',
      'id_jugador',
      'cliente',
      'referencia',
      'total_usd',
      'total_bs',
      'tasa',
      'costo_usd',
      'utilidad_usd',
    ].join(',');

    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const rows = list.map((order) =>
      [
        order.code,
        order.createdAt.toDate().toISOString(),
        order.status,
        order.gameName,
        order.productName,
        order.fulfillment,
        order.playerId,
        order.user.email ?? '',
        order.payment.reference ?? '',
        order.pricing.totalUsd,
        order.pricing.totalBs,
        order.pricing.rate,
        order.pricing.costUsd,
        order.pricing.profitUsd,
      ]
        .map(escape)
        .join(',')
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ordenes-refill-store.csv"');
    // BOM para que Excel abra los acentos correctamente.
    res.send(`\uFEFF${[header, ...rows].join('\n')}`);
  })
);

// ===========================================================================
// Catálogo — juegos
// ===========================================================================

adminRouter.get(
  '/games',
  asyncHandler(async (_req, res) => {
    const list = await catalog.listGames();
    ok(res, { games: list.map(catalog.toPublicGame) });
  })
);

/**
 * Un campo del formulario de compra.
 *
 * El proveedor sólo acepta dos identificadores (`player_id` y `player_id2`),
 * así que ese es el techo de campos que pueden viajar al API; los demás se
 * admiten con `providerField: null` para las entregas manuales (correo y clave
 * de Roblox o CoD, que las gestiona una persona).
 */
const playerFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'La clave del campo sólo admite letras, números y guion bajo.'),
  label: z.string().trim().min(1).max(40),
  pattern: z.string().trim().min(1).max(200),
  help: z.string().trim().max(200).default(''),
  placeholder: z.string().trim().max(60).default(''),
  type: z.enum(['text', 'number', 'email', 'password']).default('text'),
  providerField: z.enum(['player_id', 'player_id2']).nullable().default(null),
  required: z.boolean().default(true),
  sensitive: z.boolean().default(false),
});

const gameSchema = z.object({
  name: z.string().trim().min(2).max(60),
  shortName: z.string().trim().min(2).max(40).optional(),
  apiGameId: z.coerce.number().int(),
  apiGameType: z.string().trim().min(1).max(40),
  currencyLabel: z.string().trim().min(1).max(30),
  currencyIcon: z.string().trim().max(8).optional(),
  currencyIconUrl: z.string().trim().max(500).optional(),
  playerFields: z.array(playerFieldSchema).min(1).max(3).optional(),
  validatesPlayerId: z.boolean().optional(),
  playerIdLabel: z.string().trim().min(2).max(40).optional(),
  playerIdPattern: z.string().trim().min(2).max(120).optional(),
  playerIdHelp: z.string().trim().max(200).optional(),
  howToFindId: z.array(z.string().max(200)).max(6).optional(),
  logoUrl: z.string().trim().max(500).optional(),
  coverUrl: z.string().trim().max(500).optional(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  accentColorSecondary: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});

/** Un patrón de ID mal escrito rompería el checkout: se valida al guardar. */
function assertValidPattern(pattern?: string) {
  if (!pattern) return;
  try {
    new RegExp(pattern);
  } catch {
    throw invalidArgument('El patrón de validación del ID no es una expresión regular válida.');
  }
}

type PlayerFieldInput = z.infer<typeof playerFieldSchema>;

/**
 * Valida la lista de campos de un juego.
 *
 * Tres reglas que, de saltárselas, dejan el juego imposible de despachar:
 * exactamente un campo tiene que ser `player_id`, no puede haber dos con la
 * misma clave, y cada patrón tiene que compilar.
 */
function assertValidPlayerFields(fields?: PlayerFieldInput[]) {
  if (!fields || fields.length === 0) return;

  const keys = new Set<string>();
  let primaries = 0;
  let secondaries = 0;

  for (const field of fields) {
    if (keys.has(field.key)) {
      throw invalidArgument(`Hay dos campos con la clave «${field.key}».`);
    }
    keys.add(field.key);
    assertValidPattern(field.pattern);

    if (field.providerField === 'player_id') primaries += 1;
    if (field.providerField === 'player_id2') secondaries += 1;
  }

  if (primaries !== 1) {
    throw invalidArgument(
      'Exactamente un campo debe enviarse como «player_id»: es el identificador principal que exige el proveedor.'
    );
  }
  if (secondaries > 1) {
    throw invalidArgument('El proveedor sólo admite un campo «player_id2» (Zone ID).');
  }
}

/**
 * Mantiene sincronizados los campos sueltos heredados con `playerFields[0]`.
 *
 * Todavía hay pantallas y órdenes viejas que leen `playerIdLabel`; si sólo se
 * actualizara la lista nueva, esas mostrarían la etiqueta anterior.
 */
function legacyIdFields(fields?: PlayerFieldInput[]): Record<string, unknown> {
  const primary = fields?.find((field) => field.providerField === 'player_id') ?? fields?.[0];
  if (!primary) return {};

  return {
    playerIdLabel: primary.label,
    playerIdPattern: primary.pattern,
    playerIdHelp: primary.help,
  };
}

adminRouter.post(
  '/games',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, gameSchema.extend({ id: z.string().trim().max(40).optional() }));
    assertValidPattern(body.playerIdPattern);
    assertValidPlayerFields(body.playerFields);

    const id = slugify(body.id || body.name);
    const existing = await games().doc(id).get();
    if (existing.exists) throw failedPrecondition('Ya existe un juego con ese identificador.');

    const playerFields = body.playerFields ?? [
      {
        ...DEFAULT_PLAYER_FIELD,
        label: body.playerIdLabel ?? DEFAULT_PLAYER_FIELD.label,
        pattern: body.playerIdPattern ?? DEFAULT_PLAYER_FIELD.pattern,
        help: body.playerIdHelp ?? DEFAULT_PLAYER_FIELD.help,
      },
    ];

    const timestamp = now();
    await games().doc(id).set({
      name: body.name,
      shortName: body.shortName ?? body.name,
      apiGameId: body.apiGameId,
      apiGameType: body.apiGameType,
      currencyLabel: body.currencyLabel,
      currencyIcon: body.currencyIcon ?? '🎮',
      currencyIconUrl: body.currencyIconUrl ?? '',
      playerFields,
      // Sólo Free Fire valida el ID contra el juego; el resto acepta cualquier
      // número. Se asume lo conservador y la tienda pedirá confirmarlo.
      validatesPlayerId: body.validatesPlayerId ?? false,
      ...legacyIdFields(playerFields),
      howToFindId: body.howToFindId ?? [],
      logoUrl: body.logoUrl ?? '',
      coverUrl: body.coverUrl ?? '',
      accentColor: body.accentColor ?? '#7C3AED',
      accentColorSecondary: body.accentColorSecondary ?? '#22D3EE',
      active: body.active ?? true,
      sortOrder: body.sortOrder ?? 99,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await audit.record({
      action: audit.ACTIONS.GAME_CREATED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'game',
      targetId: id,
      summary: `Juego creado: ${body.name}.`,
      ip: clientIp(req),
    });

    ok(res, { game: await catalog.getGame(id) }, 201);
  })
);

adminRouter.patch(
  '/games/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, gameSchema.partial());
    assertValidPattern(body.playerIdPattern);
    assertValidPlayerFields(body.playerFields);

    await catalog.getGame(id);
    await games()
      .doc(id)
      .set(
        { ...body, ...legacyIdFields(body.playerFields), updatedAt: now() },
        // `merge` fusiona mapas pero REEMPLAZA arrays, que es justo lo que hace
        // falta: quitar un campo del juego tiene que quitarlo de verdad.
        { merge: true }
      );

    await audit.record({
      action: audit.ACTIONS.GAME_UPDATED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'game',
      targetId: id,
      summary: `Juego actualizado: ${id}.`,
      data: body,
      ip: clientIp(req),
    });

    ok(res, { game: await catalog.getGame(id) });
  })
);

adminRouter.delete(
  '/games/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);

    const linked = await products().where('gameId', '==', id).count().get();
    if (linked.data().count > 0) {
      throw failedPrecondition(
        `Ese juego tiene ${linked.data().count} productos. Desactívalo en lugar de borrarlo, o elimina antes sus productos.`
      );
    }

    await games().doc(id).delete();
    await audit.record({
      action: audit.ACTIONS.GAME_DELETED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'game',
      targetId: id,
      summary: `Juego eliminado: ${id}.`,
      ip: clientIp(req),
    });

    ok(res, { deleted: true });
  })
);

// ===========================================================================
// Catálogo — productos
// ===========================================================================

adminRouter.get(
  '/products',
  asyncHandler(async (req, res) => {
    const { gameId } = parseQuery(req, z.object({ gameId: z.string().optional() }));
    ok(res, { products: await catalog.listProducts({ gameId }) });
  })
);

const productSchema = z.object({
  gameId: z.string().min(1),
  sku: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).optional(),
  fulfillment: z.enum(['auto', 'manual']),
  kind: z.enum(['package', 'combo', 'special']),
  amount: z.coerce.number().int().min(0),
  bonus: z.coerce.number().int().min(0),
  costUsd: z.coerce.number().min(0).max(10_000),
  priceUsd: z.coerce.number().min(0.01).max(10_000),
  compareAtUsd: z.coerce.number().min(0).max(10_000).nullable().optional(),
  calls: z
    .array(
      z.object({
        packageId: z.coerce.number().int(),
        quantity: z.coerce.number().int().min(1).max(10),
      })
    )
    .max(10)
    .optional(),
  imageUrl: z.string().trim().max(500).optional(),
  badge: z.string().trim().max(20).nullable().optional(),
  active: z.boolean().optional(),
  featured: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  stock: z.coerce.number().int().min(0).nullable().optional(),
  deliveryEtaMinutes: z.coerce.number().int().min(1).max(1440).optional(),
});

/** Un producto automático sin llamadas configuradas no se puede despachar. */
function assertCallsConsistent(input: {
  fulfillment: 'auto' | 'manual';
  calls?: Array<{ packageId: number; quantity: number }>;
}) {
  if (input.fulfillment === 'auto' && (!input.calls || input.calls.length === 0)) {
    throw invalidArgument(
      'Un producto automático necesita al menos una llamada al proveedor (package_id).'
    );
  }
}

adminRouter.post(
  '/products',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, productSchema.extend({ id: z.string().trim().max(60).optional() }));
    assertCallsConsistent(body);
    await catalog.getGame(body.gameId);

    const id = slugify(body.id || body.sku);
    const existing = await products().doc(id).get();
    if (existing.exists) throw failedPrecondition('Ya existe un producto con ese identificador.');

    const timestamp = now();
    await products().doc(id).set({
      gameId: body.gameId,
      sku: body.sku,
      name: body.name,
      description: body.description ?? '',
      fulfillment: body.fulfillment,
      kind: body.kind,
      amount: body.amount,
      bonus: body.bonus,
      costUsd: round(body.costUsd, 4),
      priceUsd: round(body.priceUsd, 2),
      compareAtUsd: body.compareAtUsd ?? null,
      calls: body.calls ?? [],
      imageUrl: body.imageUrl ?? '',
      badge: body.badge ?? null,
      active: body.active ?? true,
      featured: body.featured ?? false,
      sortOrder: body.sortOrder ?? 99,
      stock: body.stock ?? null,
      deliveryEtaMinutes: body.deliveryEtaMinutes ?? (body.fulfillment === 'auto' ? 2 : 15),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await audit.record({
      action: audit.ACTIONS.PRODUCT_CREATED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'product',
      targetId: id,
      summary: `Producto creado: ${body.name}.`,
      ip: clientIp(req),
    });

    ok(res, { product: await catalog.getProduct(id) }, 201);
  })
);

adminRouter.patch(
  '/products/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, productSchema.partial());
    const current = await catalog.getProduct(id);

    assertCallsConsistent({
      fulfillment: body.fulfillment ?? current.fulfillment,
      calls: body.calls ?? current.calls,
    });

    const patch: Record<string, unknown> = { ...body, updatedAt: now() };
    if (body.costUsd !== undefined) patch.costUsd = round(body.costUsd, 4);
    if (body.priceUsd !== undefined) patch.priceUsd = round(body.priceUsd, 2);

    await products().doc(id).set(patch, { merge: true });

    await audit.record({
      action: audit.ACTIONS.PRODUCT_UPDATED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'product',
      targetId: id,
      summary: `Producto actualizado: ${current.name}.`,
      data: body,
      ip: clientIp(req),
    });

    ok(res, { product: await catalog.getProduct(id) });
  })
);

adminRouter.delete(
  '/products/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const product = await catalog.getProduct(id);
    await products().doc(id).delete();

    await audit.record({
      action: audit.ACTIONS.PRODUCT_DELETED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'product',
      targetId: id,
      summary: `Producto eliminado: ${product.name}.`,
      ip: clientIp(req),
    });

    ok(res, { deleted: true });
  })
);

/** Recalcula precios en masa a partir del costo y un margen. */
adminRouter.post(
  '/products/reprice',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        marginPercent: z.coerce.number().min(0).max(500),
        gameId: z.string().optional(),
        productIds: z.array(z.string()).max(200).optional(),
        dryRun: z.boolean().default(false),
      })
    );

    const config = await getConfig();

    if (body.dryRun) {
      const list = await catalog.listProducts({ gameId: body.gameId });
      const target = body.productIds?.length
        ? list.filter((product) => body.productIds!.includes(product.id))
        : list;

      ok(res, {
        dryRun: true,
        changes: target.map((product) => ({
          id: product.id,
          name: product.name,
          from: product.priceUsd,
          to: applyMargin(product.costUsd, body.marginPercent, config.pricing.roundToUsd),
        })),
      });
      return;
    }

    const result = await catalog.repriceProducts({
      marginPercent: body.marginPercent,
      roundToUsd: config.pricing.roundToUsd,
      gameId: body.gameId,
      onlyIds: body.productIds,
    });

    await audit.record({
      action: audit.ACTIONS.PRODUCTS_REPRICED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'product',
      targetId: body.gameId ?? 'all',
      summary: `Recalculados ${result.updated} precios con margen ${body.marginPercent}%.`,
      ip: clientIp(req),
    });

    ok(res, result);
  })
);

/** Siembra o actualiza el catálogo del documento de especificaciones. */
adminRouter.post(
  '/catalog/seed',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { overwritePrices } = parseBody(
      req,
      z.object({ overwritePrices: z.boolean().default(false) })
    );

    const result = await seedCatalog({ overwritePrices });

    await audit.record({
      action: audit.ACTIONS.CATALOG_SEEDED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'catalog',
      targetId: 'seed',
      summary: `Catálogo sembrado: ${result.productsCreated} nuevos, ${result.productsUpdated} actualizados.`,
      ip: clientIp(req),
    });

    ok(res, result);
  })
);

// ===========================================================================
// Usuarios
// ===========================================================================

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        role: z.enum(['user', 'staff', 'admin']).optional(),
        search: z.string().trim().max(80).optional(),
      })
    );

    if (query.search) {
      const term = query.search.toLowerCase();
      // Firestore no hace búsqueda parcial: se busca por igualdad de email y,
      // si no hay resultado, se filtra un lote reciente en memoria.
      const byEmail = await users().where('email', '==', term).limit(5).get();
      if (!byEmail.empty) {
        ok(res, {
          users: byEmail.docs.map((doc) => ({ uid: doc.id, ...doc.data() }) as UserProfile),
        });
        return;
      }

      const recent = await users().orderBy('createdAt', 'desc').limit(300).get();
      const filtered = recent.docs
        .map((doc) => ({ uid: doc.id, ...doc.data() }) as UserProfile)
        .filter(
          (profile) =>
            profile.email?.toLowerCase().includes(term) ||
            profile.displayName?.toLowerCase().includes(term) ||
            profile.referralCode?.toLowerCase().includes(term)
        )
        .slice(0, query.limit);

      ok(res, { users: filtered });
      return;
    }

    let ref = users().orderBy('createdAt', 'desc').limit(query.limit);
    if (query.role) {
      ref = users()
        .where('role', '==', query.role)
        .orderBy('createdAt', 'desc')
        .limit(query.limit);
    }

    const snap = await ref.get();
    ok(res, {
      users: snap.docs.map((doc) => ({ uid: doc.id, ...doc.data() }) as UserProfile),
    });
  })
);

adminRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const [profile, userOrders] = await Promise.all([
      usersService.getProfile(id),
      ordersService.listOrders({ uid: id, limit: 25 }),
    ]);
    ok(res, { profile, orders: userOrders });
  })
);

adminRouter.post(
  '/users/:id/role',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { role } = parseBody(req, z.object({ role: z.enum(['user', 'staff', 'admin']) }));
    const actor = currentUser(req);

    if (id === actor.uid && role !== 'admin') {
      throw failedPrecondition('No puedes quitarte a ti mismo el rol de administrador.');
    }

    await usersService.setRole(id, role);
    await audit.record({
      action: audit.ACTIONS.USER_ROLE_CHANGED,
      actorUid: actor.uid,
      actorEmail: actor.email,
      targetType: 'user',
      targetId: id,
      summary: `Rol cambiado a ${role}.`,
      ip: clientIp(req),
    });

    ok(res, { profile: await usersService.getProfile(id) });
  })
);

adminRouter.post(
  '/users/:id/ban',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({ banned: z.boolean(), reason: z.string().trim().max(200).optional() })
    );
    const actor = currentUser(req);

    if (id === actor.uid) throw failedPrecondition('No puedes bloquear tu propia cuenta.');

    await usersService.setBanned(id, body.banned, body.reason ?? null);
    await audit.record({
      action: body.banned ? audit.ACTIONS.USER_BANNED : audit.ACTIONS.USER_UNBANNED,
      actorUid: actor.uid,
      actorEmail: actor.email,
      targetType: 'user',
      targetId: id,
      summary: body.banned ? `Usuario bloqueado: ${body.reason ?? 'sin motivo'}.` : 'Usuario desbloqueado.',
      ip: clientIp(req),
    });

    ok(res, { profile: await usersService.getProfile(id) });
  })
);

/** Movimientos de la cartera de un usuario, para auditar de dónde sale su saldo. */
adminRouter.get(
  '/users/:id/wallet',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const [profile, transactions] = await Promise.all([
      usersService.getProfile(id),
      usersService.listWalletTransactions(id, 50),
    ]);
    ok(res, { balanceUsd: profile.walletBalanceUsd ?? 0, transactions });
  })
);

adminRouter.post(
  '/users/:id/wallet',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({
        deltaUsd: z.coerce.number().min(-10_000).max(10_000),
        reason: z.string().trim().max(200),
      })
    );

    const actor = currentUser(req);
    const balance = await usersService.adjustWallet(id, body.deltaUsd, {
      reason: body.reason,
      actorUid: actor.uid,
    });

    await Promise.all([
      audit.record({
        action: audit.ACTIONS.USER_WALLET_ADJUSTED,
        actorUid: actor.uid,
        actorEmail: actor.email,
        targetType: 'user',
        targetId: id,
        summary: `Saldo ajustado en $${body.deltaUsd.toFixed(2)}: ${body.reason}`,
        ip: clientIp(req),
      }),
      notificationsService.notify({
        uid: id,
        title: body.deltaUsd >= 0 ? 'Saldo acreditado' : 'Saldo ajustado',
        body: `${body.deltaUsd >= 0 ? '+' : ''}$${body.deltaUsd.toFixed(2)} — ${body.reason}`,
        type: 'system',
      }),
    ]);

    ok(res, { walletBalanceUsd: balance });
  })
);

/** Envía una notificación puntual a un usuario. */
adminRouter.post(
  '/users/:id/notify',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(
      req,
      z.object({
        title: z.string().trim().min(2).max(80),
        body: z.string().trim().min(2).max(300),
        link: z.string().trim().max(200).optional(),
      })
    );

    await notificationsService.notify({
      uid: id,
      title: body.title,
      body: body.body,
      link: body.link ?? null,
      type: 'system',
    });

    ok(res, { sent: true });
  })
);

// ===========================================================================
// Avisos al equipo
// ===========================================================================

adminRouter.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(40),
        onlyUnread: z.coerce.boolean().default(false),
      })
    );

    const [alerts, unread] = await Promise.all([
      alertsService.listAlerts({ limit: query.limit, onlyUnread: query.onlyUnread }),
      alertsService.countUnread(),
    ]);

    ok(res, { alerts, unread });
  })
);

adminRouter.post(
  '/alerts/read-all',
  asyncHandler(async (_req, res) => {
    ok(res, { marked: await alertsService.markAllRead() });
  })
);

adminRouter.post(
  '/alerts/:id/read',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    await alertsService.markRead(id);
    ok(res, { read: true });
  })
);

/** Chats a los que el bot de Telegram puede escribir, para no buscarlos a mano. */
adminRouter.get(
  '/alerts/telegram/chats',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    ok(res, await alertsService.detectTelegramChats());
  })
);

/**
 * Envía un aviso de prueba por los canales configurados.
 *
 * Es la única forma razonable de comprobar que el chat de Telegram y el webhook
 * están bien puestos sin tener que provocar un despacho fallido de verdad.
 */
adminRouter.post(
  '/alerts/test',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const actor = currentUser(req);

    await alertsService.alert({
      kind: 'test',
      severity: 'info',
      title: 'Aviso de prueba',
      body: `Si lees esto, los avisos de Refill Store funcionan. Enviado por ${actor.email ?? actor.uid}.`,
      link: '/admin',
    });

    // Se relee para poder decirle al panel por qué canales salió de verdad.
    const [latest] = await alertsService.listAlerts({ limit: 1 });
    ok(res, { sent: true, delivery: latest?.delivery ?? null });
  })
);

// ===========================================================================
// Configuración
// ===========================================================================

adminRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    ok(res, { config: await getConfig({ fresh: true }) });
  })
);

const configPatchSchema = z.object({
  storeName: z.string().trim().min(2).max(60).optional(),
  tagline: z.string().trim().max(120).optional(),
  bank: z
    .object({
      code: z.string().trim().max(8),
      name: z.string().trim().max(60),
      idNumber: z.string().trim().max(30),
      phone: z.string().trim().max(30),
      holder: z.string().trim().max(60),
    })
    .partial()
    .optional(),
  whatsapp: z
    .object({
      adminNumber: z.string().trim().regex(/^\d{7,20}$/),
      supportNumber: z.string().trim().regex(/^\d{7,20}$/),
    })
    .partial()
    .optional(),
  checkout: z
    .object({
      referenceMinLength: z.coerce.number().int().min(1).max(30),
      referenceMaxLength: z.coerce.number().int().min(1).max(40),
      orderExpiryMinutes: z.coerce.number().int().min(5).max(1440),
      amountTolerancePercent: z.coerce.number().min(0).max(10),
      maxVerifyAttempts: z.coerce.number().int().min(1).max(20),
      maxOpenOrdersPerUser: z.coerce.number().int().min(1).max(20),
      walletEnabled: z.boolean(),
    })
    .partial()
    .optional(),
  alerts: z
    .object({
      enabled: z.boolean(),
      telegramChatId: z.string().trim().max(40),
      webhookUrl: z.string().trim().max(400),
      notifyOnDispatchFailed: z.boolean(),
      notifyOnManualOrder: z.boolean(),
      notifyOnNewTicket: z.boolean(),
      notifyOnPaymentRejected: z.boolean(),
      lowBalanceThresholdUsd: z.coerce.number().min(0).max(10_000),
    })
    .partial()
    .optional(),
  features: z
    .object({
      maintenanceMode: z.boolean(),
      maintenanceMessage: z.string().trim().max(200),
      autoDispatchEnabled: z.boolean(),
      manualProductsEnabled: z.boolean(),
      couponsEnabled: z.boolean(),
      referralsEnabled: z.boolean(),
    })
    .partial()
    .optional(),
  announcement: z
    .object({
      enabled: z.boolean(),
      text: z.string().trim().max(200),
      type: z.enum(['info', 'success', 'warning']),
    })
    .partial()
    .optional(),
  pricing: z
    .object({
      defaultMarginPercent: z.coerce.number().min(0).max(500),
      roundToUsd: z.coerce.number().min(0.01).max(1),
      roundToBs: z.coerce.number().min(0.01).max(100),
    })
    .partial()
    .optional(),
  contact: z
    .object({
      email: z.string().trim().max(120),
      instagram: z.string().trim().max(80),
      telegram: z.string().trim().max(80),
    })
    .partial()
    .optional(),
});

adminRouter.patch(
  '/config',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, configPatchSchema);
    const current = await getConfig({ fresh: true });

    // Mezcla campo a campo para no borrar sub-claves que no vinieron.
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        patch[key] = { ...(current as unknown as Record<string, object>)[key], ...value };
      } else {
        patch[key] = value;
      }
    }

    const actor = currentUser(req);
    const config = await updateConfig(patch, actor.uid);

    await audit.record({
      action: audit.ACTIONS.CONFIG_UPDATED,
      actorUid: actor.uid,
      actorEmail: actor.email,
      targetType: 'config',
      targetId: 'app',
      summary: `Configuración actualizada: ${Object.keys(patch).join(', ')}.`,
      data: patch,
      ip: clientIp(req),
    });

    ok(res, { config });
  })
);

// --- Tasa ---

adminRouter.post(
  '/config/rate',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({ value: z.coerce.number().positive().max(1_000_000) })
    );
    const actor = currentUser(req);
    const result = await rateService.setManualRate(body.value, actor.uid);

    await audit.record({
      action: audit.ACTIONS.RATE_UPDATED,
      actorUid: actor.uid,
      actorEmail: actor.email,
      targetType: 'config',
      targetId: 'rate',
      summary: `Tasa cambiada de ${result.previous} a ${result.current} Bs/USD.`,
      ip: clientIp(req),
    });

    ok(res, result);
  })
);

adminRouter.post(
  '/config/rate/auto',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      req,
      z.object({
        autoRefresh: z.boolean(),
        markupPercent: z.coerce.number().min(-50).max(200).optional(),
      })
    );

    const current = await getConfig({ fresh: true });
    const config = await updateConfig(
      {
        rate: {
          ...current.rate,
          autoRefresh: body.autoRefresh,
          markupPercent: body.markupPercent ?? current.rate.markupPercent,
        },
      },
      currentUser(req).uid
    );

    ok(res, { rate: config.rate });
  })
);

adminRouter.post(
  '/config/rate/refresh',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    ok(res, await rateService.refreshAutoRate(true));
  })
);

adminRouter.get(
  '/config/rate/history',
  asyncHandler(async (_req, res) => {
    ok(res, { history: await rateService.history(50) });
  })
);

// ===========================================================================
// Cupones
// ===========================================================================

adminRouter.get(
  '/coupons',
  asyncHandler(async (_req, res) => {
    ok(res, { coupons: await couponsService.list() });
  })
);

const couponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/, 'El código sólo admite letras, números, guion y guion bajo.'),
  description: z.string().trim().max(160).optional(),
  type: z.enum(['percent', 'fixed']),
  value: z.coerce.number().positive().max(10_000),
  minOrderUsd: z.coerce.number().min(0).max(10_000).default(0),
  maxDiscountUsd: z.coerce.number().min(0).max(10_000).nullable().optional(),
  usageLimit: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  perUserLimit: z.coerce.number().int().min(0).max(100).default(1),
  validFromMillis: z.coerce.number().int().nullable().optional(),
  validUntilMillis: z.coerce.number().int().nullable().optional(),
  gameIds: z.array(z.string()).max(20).default([]),
  productIds: z.array(z.string()).max(100).default([]),
  active: z.boolean().default(true),
});

adminRouter.post(
  '/coupons',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(req, couponSchema);
    const code = body.code.toUpperCase();

    if (body.type === 'percent' && body.value > 100) {
      throw invalidArgument('Un descuento porcentual no puede superar el 100%.');
    }

    const existing = await coupons().doc(code).get();
    if (existing.exists) throw failedPrecondition('Ya existe un cupón con ese código.');

    await coupons()
      .doc(code)
      .set({
        description: body.description ?? '',
        type: body.type,
        value: body.value,
        minOrderUsd: body.minOrderUsd,
        maxDiscountUsd: body.maxDiscountUsd ?? null,
        usageLimit: body.usageLimit ?? null,
        usageCount: 0,
        perUserLimit: body.perUserLimit,
        validFrom: body.validFromMillis ? Timestamp.fromMillis(body.validFromMillis) : null,
        validUntil: body.validUntilMillis ? Timestamp.fromMillis(body.validUntilMillis) : null,
        gameIds: body.gameIds,
        productIds: body.productIds,
        active: body.active,
        createdAt: now(),
        createdBy: currentUser(req).uid,
      });

    await audit.record({
      action: audit.ACTIONS.COUPON_CREATED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'coupon',
      targetId: code,
      summary: `Cupón creado: ${code}.`,
      ip: clientIp(req),
    });

    ok(res, { code }, 201);
  })
);

adminRouter.patch(
  '/coupons/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const body = parseBody(req, couponSchema.partial().omit({ code: true }));

    const code = id.toUpperCase();
    const snap = await coupons().doc(code).get();
    if (!snap.exists) throw notFound('Cupón no encontrado.');

    const patch: Record<string, unknown> = { ...body, updatedAt: now() };
    delete patch.validFromMillis;
    delete patch.validUntilMillis;
    if (body.validFromMillis !== undefined) {
      patch.validFrom = body.validFromMillis ? Timestamp.fromMillis(body.validFromMillis) : null;
    }
    if (body.validUntilMillis !== undefined) {
      patch.validUntil = body.validUntilMillis
        ? Timestamp.fromMillis(body.validUntilMillis)
        : null;
    }

    await coupons().doc(code).set(patch, { merge: true });

    await audit.record({
      action: audit.ACTIONS.COUPON_UPDATED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'coupon',
      targetId: code,
      summary: `Cupón actualizado: ${code}.`,
      ip: clientIp(req),
    });

    const updated = await coupons().doc(code).get();
    ok(res, { coupon: { code, ...updated.data() } as Coupon });
  })
);

adminRouter.delete(
  '/coupons/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    await coupons().doc(id.toUpperCase()).delete();

    await audit.record({
      action: audit.ACTIONS.COUPON_DELETED,
      actorUid: currentUser(req).uid,
      actorEmail: currentUser(req).email,
      targetType: 'coupon',
      targetId: id,
      summary: `Cupón eliminado: ${id}.`,
      ip: clientIp(req),
    });

    ok(res, { deleted: true });
  })
);

// ===========================================================================
// Soporte y bitácora
// ===========================================================================

adminRouter.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const { status } = parseQuery(
      req,
      z.object({ status: z.enum(['open', 'pending', 'closed']).optional() })
    );

    const snap = status
      ? await tickets()
          .where('status', '==', status)
          .orderBy('updatedAt', 'desc')
          .limit(50)
          .get()
      : await tickets().orderBy('updatedAt', 'desc').limit(50).get();

    ok(res, { tickets: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Ticket) });
  })
);

adminRouter.post(
  '/tickets/:id/status',
  asyncHandler(async (req, res) => {
    const { id } = parseParams(req, idParam);
    const { status } = parseBody(
      req,
      z.object({ status: z.enum(['open', 'pending', 'closed']) })
    );

    await tickets().doc(id).set({ status, updatedAt: now() }, { merge: true });
    ok(res, { updated: true });
  })
);

adminRouter.get(
  '/logs',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const query = parseQuery(
      req,
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        action: z.string().optional(),
        actorUid: z.string().optional(),
      })
    );

    ok(res, { logs: await audit.list(query) });
  })
);
