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
  // El patrón exacto lo valida el servicio contra la configuración del juego;
  // aquí sólo se descartan entradas absurdas.
  playerId: z
    .string()
    .trim()
    .regex(/^\d{4,20}$/, 'El ID de jugador debe contener sólo números.'),
  quantity: z.coerce.number().int().min(1).max(10).default(1),
  couponCode: z.string().trim().max(32).optional().nullable(),
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

    const order = await ordersService.createOrder(user, profile, {
      gameId: body.gameId,
      productId: body.productId,
      playerId: body.playerId,
      quantity: body.quantity,
      couponCode: body.couponCode ?? null,
      customerNote: body.customerNote ?? null,
      ip: clientIp(req),
      userAgent: userAgent(req),
    });

    const config = await getConfig();
    ok(
      res,
      {
        order: ordersService.toCustomerOrder(order),
        payment: {
          bank: order.payment.bankSnapshot,
          amountBs: order.pricing.totalBs,
          amountUsd: order.pricing.totalUsd,
          rate: order.pricing.rate,
          expiresAt: order.expiresAt.toMillis(),
          referenceMinLength: config.checkout.referenceMinLength,
          referenceMaxLength: config.checkout.referenceMaxLength,
        },
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
  before: z.coerce.number().int().optional(),
});

ordersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = parseQuery(req, listQuerySchema);

    const list = await ordersService.listOrders({
      uid: user.uid,
      limit: query.limit,
      status: query.status
        ? (query.status.split(',') as Parameters<typeof ordersService.listOrders>[0]['status'])
        : undefined,
      beforeMillis: query.before,
    });

    ok(res, {
      orders: list.map(ordersService.toCustomerOrder),
      nextCursor:
        list.length === query.limit ? list[list.length - 1].createdAt.toMillis() : null,
    });
  })
);

ordersRouter.get(
  '/:orderId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { orderId } = parseParams(req, orderIdParam);

    const order = await ordersService.getOrderFor(orderId, user);
    const events = await listEvents(orderId);

    ok(res, { order: ordersService.toCustomerOrder(order), events });
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
    const tierPercent = usersService.tierDiscountPercent(profile.tier);
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
        });
        discountUsd = Number((discountUsd + evaluation.discountUsd).toFixed(2));
        couponCode = evaluation.coupon.code;
      } catch (error) {
        couponError = error instanceof Error ? error.message : 'Cupón inválido.';
      }
    }

    discountUsd = Math.min(discountUsd, Number((subtotalUsd - 0.01).toFixed(2)));
    const totalUsd = Number((subtotalUsd - discountUsd).toFixed(2));

    ok(res, {
      subtotalUsd,
      discountUsd,
      totalUsd,
      totalBs: Number((totalUsd * config.rate.value).toFixed(2)),
      rate: config.rate.value,
      tierPercent,
      tier: profile.tier,
      couponCode,
      couponError,
    });
  })
);
