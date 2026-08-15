/** Endpoints de compra: crear orden, verificar pago, consultar y cancelar. */
import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler,
  clientIp,
  ok,
  parseBody,
  parseParams,
  parseQuery,
  userAgent,
} from '../lib/http';
import { invalidArgument } from '../lib/errors';
import { requireAuth, currentUser } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import * as ordersService from '../services/orders';
import * as usersService from '../services/users';
import * as couponsService from '../services/coupons';
import * as catalog from '../services/catalog';
import { listEvents } from '../services/orderEvents';
import { getConfig } from '../services/settings';

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

const orderIdParam = z.object({ orderId: z.string().min(1) });

// ---------------------------------------------------------------------------
// Crear orden
// ---------------------------------------------------------------------------

const createOrderSchema = z.object({
  gameId: z.string().min(1),
  productId: z.string().min(1),
  /**
   * Datos de la cuenta a recargar, por clave de campo.
   *
   * Aquí sólo se acotan tamaños: qué campos existen, cuáles son obligatorios y
   * con qué patrón se validan lo decide el juego, y eso vive en el servicio.
   * Ya no se puede exigir «sólo números» porque hay juegos que piden correo y
   * contraseña.
   */
  playerFields: z.record(z.string().min(1).max(40), z.string().trim().max(120)).optional(),
  /** Formato anterior: un único ID suelto. Se mantiene por compatibilidad. */
  playerId: z.string().trim().max(120).optional(),
  quantity: z.coerce.number().int().min(1).max(10).default(1),
  couponCode: z.string().trim().max(32).optional().nullable(),
  useWallet: z.boolean().default(false),
  customerNote: z.string().trim().max(300).optional().nullable(),
});

ordersRouter.post(
  '/',
  rateLimit({
    name: 'order_create',
    max: 10,
    windowSeconds: 300,
    message: 'Creaste muchas órdenes seguidas. Espera unos minutos.',
  }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(req, createOrderSchema);
    const profile = await usersService.ensureProfile(user);

    if (!body.playerFields && !body.playerId) {
      throw invalidArgument('Faltan los datos de la cuenta a recargar.');
    }

    const order = await ordersService.createOrder(user, profile, {
      gameId: body.gameId,
      productId: body.productId,
      playerFields: body.playerFields ?? body.playerId!,
      quantity: body.quantity,
      couponCode: body.couponCode ?? null,
      useWallet: body.useWallet,
      customerNote: body.customerNote ?? null,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });

    const config = await getConfig();
    ok(
      res,
      {
        order: ordersService.toCustomerOrder(order),
        payment: ordersService.toPaymentInstructions(order, config),
      },
      201
    );
  })
);

// ---------------------------------------------------------------------------
// Verificar pago
// ---------------------------------------------------------------------------

const verifySchema = z.object({
  reference: z.string().trim().min(1, 'Ingresa el número de referencia.').max(40),
});

ordersRouter.post(
  '/:orderId/verify',
  // Este es el endpoint que golpea a Pabilo: el más sensible a fuerza bruta.
  rateLimit({
    name: 'order_verify',
    max: 12,
    windowSeconds: 300,
    message: 'Demasiados intentos de verificación. Espera unos minutos.',
  }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { orderId } = parseParams(req, orderIdParam);
    const { reference } = parseBody(req, verifySchema);

    const result = await ordersService.verifyPayment(user, orderId, reference, clientIp(req));

    ok(res, {
      order: ordersService.toCustomerOrder(result.order),
      verified: result.verified,
      message: result.message,
      whatsappUrl: result.order.whatsappUrl,
    });
  })
);

// ---------------------------------------------------------------------------
// Consultar
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.string().optional(),
  cursor: z.string().max(400).optional(),
});

ordersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(req, listQuerySchema);

    const page = await ordersService.listOrdersPage({
      uid: user.uid,
      limit: query.limit,
      status: query.status
        ? (query.status.split(',') as Parameters<typeof ordersService.listOrders>[0]['status'])
        : undefined,
      cursor: query.cursor,
    });

    ok(res, {
      orders: page.items.map(ordersService.toCustomerOrder),
      nextCursor: page.nextCursor,
    });
  })
);

ordersRouter.get(
  '/:orderId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { orderId } = parseParams(req, orderIdParam);

    const order = await ordersService.getOrderFor(orderId, user);
    const [events, config, game] = await Promise.all([
      listEvents(orderId),
      getConfig(),
      catalog.getGame(order.gameId).catch(() => null),
    ]);

    ok(res, {
      order: ordersService.toCustomerOrder(order),
      events,
      // Con esto la pantalla de pago se puede reconstruir tal cual sin volver a
      // crear la orden ni pedir de nuevo los datos del jugador.
      payment: ordersService.toPaymentInstructions(order, config),
      // Etiquetas de los campos que se pidieron, para poder mostrarlos con su
      // nombre («Zone ID») en vez de con la clave interna.
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

ordersRouter.post(
  '/:orderId/cancel',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { orderId } = parseParams(req, orderIdParam);
    const order = await ordersService.cancelOrder(user, orderId);
    ok(res, { order: ordersService.toCustomerOrder(order) });
  })
);

// ---------------------------------------------------------------------------
// Herramientas de checkout
// ---------------------------------------------------------------------------

/** Previsualiza el precio final con cupón y descuento por nivel, sin crear orden. */
const previewSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(10).default(1),
  couponCode: z.string().trim().max(32).optional().nullable(),
  useWallet: z.boolean().default(false),
  /** Opcional: permite comprobar ya el límite del cupón por ID de jugador. */
  playerId: z.string().trim().max(120).optional().nullable(),
});

ordersRouter.post(
  '/preview',
  rateLimit({ name: 'order_preview', max: 40, windowSeconds: 60 }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(req, previewSchema);
    const [config, profile, product] = await Promise.all([
      getConfig(),
      usersService.ensureProfile(user),
      catalog.getProduct(body.productId),
    ]);

    const subtotalUsd = Number((product.priceUsd * body.quantity).toFixed(2));
    const tierPercent = await usersService.tierDiscountPercent(profile.tier);
    let discountUsd = Number(((subtotalUsd * tierPercent) / 100).toFixed(2));
    let couponError: string | null = null;
    let couponCode: string | null = null;

    if (body.couponCode && config.features.couponsEnabled) {
      try {
        const evaluation = await couponsService.evaluate({
          code: body.couponCode,
          uid: user.uid,
          subtotalUsd,
          gameId: product.gameId,
          productId: product.id,
          // Si el cliente ya escribió el ID, se avisa aquí de que el cupón está
          // agotado para esa cuenta, en vez de dejarle llegar hasta el pago.
          playerId: body.playerId ?? null,
        });
        discountUsd = Number((discountUsd + evaluation.discountUsd).toFixed(2));
        couponCode = evaluation.coupon.code;
      } catch (error) {
        couponError = error instanceof Error ? error.message : 'Cupón inválido.';
      }
    }

    discountUsd = Math.min(discountUsd, Number((subtotalUsd - 0.01).toFixed(2)));
    const totalUsd = Number((subtotalUsd - discountUsd).toFixed(2));

    // Espejo exacto del cálculo de `createOrder`: lo que se muestra aquí es lo
    // que se va a cobrar.
    const walletEnabled = config.checkout.walletEnabled !== false;
    const walletBalanceUsd = Number((profile.walletBalanceUsd ?? 0).toFixed(2));
    let walletAppliedUsd =
      body.useWallet && walletEnabled ? Math.min(walletBalanceUsd, totalUsd) : 0;
    let amountDueUsd = Number((totalUsd - walletAppliedUsd).toFixed(2));
    if (amountDueUsd > 0 && amountDueUsd < 0.01) {
      walletAppliedUsd = totalUsd;
      amountDueUsd = 0;
    }

    ok(res, {
      subtotalUsd,
      discountUsd,
      totalUsd,
      walletEnabled,
      walletBalanceUsd,
      walletAppliedUsd,
      amountDueUsd,
      totalBs: Number((amountDueUsd * config.rate.value).toFixed(2)),
      rate: config.rate.value,
      tierPercent,
      tier: profile.tier,
      couponCode,
      couponError,
    });
  })
);
