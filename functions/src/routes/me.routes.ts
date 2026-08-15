/** Área privada del usuario: perfil, IDs guardados, notificaciones y soporte. */
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { users, tickets, now } from '../config/firebase';
import { asyncHandler, ok, parseBody, parseParams } from '../lib/http';
import { forbidden, notFound } from '../lib/errors';
import { requireAuth, currentUser } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import * as usersService from '../services/users';
import * as notificationsService from '../services/notifications';
import * as adminAlerts from '../services/adminAlerts';
import * as ordersService from '../services/orders';
import * as catalog from '../services/catalog';
import { getConfig } from '../services/settings';
import { buildSupportUrl } from '../services/whatsapp';
import type { SavedPlayerId, Ticket, TicketMessage, UserNotification } from '../types/models';

export const meRouter = Router();

meRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

meRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const profile = await usersService.ensureProfile(user);

    const [recentOrders, unread] = await Promise.all([
      ordersService.listOrders({ uid: user.uid, limit: 5 }),
      users().doc(user.uid).collection('notifications').where('read', '==', false).count().get(),
    ]);

    ok(res, {
      profile,
      isAdmin: user.isAdmin,
      isStaff: user.isStaff,
      unreadNotifications: unread.data().count,
      recentOrders: recentOrders.map(ordersService.toCustomerOrder),
      tierDiscountPercent: await usersService.tierDiscountPercent(profile.tier),
    });
  })
);

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(60).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^[\d+\s()-]{7,20}$/, 'Teléfono inválido.')
    .optional()
    .nullable(),
  preferences: z
    .object({
      notifyEmail: z.boolean().optional(),
      notifyOrderUpdates: z.boolean().optional(),
    })
    .optional(),
});

meRouter.patch(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(req, updateProfileSchema);
    const profile = await usersService.ensureProfile(user);

    const patch: Record<string, unknown> = { updatedAt: now() };
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.preferences) {
      patch.preferences = { ...profile.preferences, ...body.preferences };
    }

    await users().doc(user.uid).set(patch, { merge: true });
    ok(res, { profile: await usersService.getProfile(user.uid) });
  })
);

// ---------------------------------------------------------------------------
// IDs de jugador guardados
// ---------------------------------------------------------------------------

meRouter.get(
  '/player-ids',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const snap = await users()
      .doc(user.uid)
      .collection('playerIds')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    ok(res, {
      playerIds: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as SavedPlayerId),
    });
  })
);

const savePlayerIdSchema = z.object({
  gameId: z.string().min(1),
  playerId: z.string().trim().min(1).max(120),
  /**
   * Campos adicionales del juego (Zone ID…).
   *
   * Las contraseñas NO se guardan aquí: un acceso guardado es una comodidad,
   * y guardar credenciales de la cuenta del jugador para «la próxima vez» es
   * un riesgo que no compensa. El servidor las descarta más abajo.
   */
  playerFields: z.record(z.string().min(1).max(40), z.string().trim().max(120)).optional(),
  label: z.string().trim().min(1).max(40),
  isDefault: z.boolean().default(false),
});

meRouter.post(
  '/player-ids',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(req, savePlayerIdSchema);
    const collection = users().doc(user.uid).collection('playerIds');

    // Se descartan los campos sensibles antes de guardar nada.
    const game = await catalog.getGame(body.gameId);
    const sensitiveKeys = new Set(
      catalog
        .resolvePlayerFields(game)
        .filter((field) => field.sensitive || field.type === 'password')
        .map((field) => field.key)
    );

    const playerFields = Object.fromEntries(
      Object.entries(body.playerFields ?? {}).filter(([key]) => !sensitiveKeys.has(key))
    );

    // Un mismo ID para un mismo juego no se duplica: se actualiza la etiqueta.
    const existing = await collection
      .where('gameId', '==', body.gameId)
      .where('playerId', '==', body.playerId)
      .limit(1)
      .get();

    if (!existing.empty) {
      await existing.docs[0].ref.set({ label: body.label, playerFields }, { merge: true });
      ok(res, { id: existing.docs[0].id, updated: true });
      return;
    }

    if (body.isDefault) {
      const previous = await collection.where('gameId', '==', body.gameId).get();
      await Promise.all(
        previous.docs.map((doc) => doc.ref.set({ isDefault: false }, { merge: true }))
      );
    }

    const ref = await collection.add({
      gameId: body.gameId,
      playerId: body.playerId,
      playerFields,
      label: body.label,
      isDefault: body.isDefault,
      createdAt: now(),
    });
    ok(res, { id: ref.id, updated: false }, 201);
  })
);

// ---------------------------------------------------------------------------
// Cartera
// ---------------------------------------------------------------------------

meRouter.get(
  '/wallet',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const [profile, transactions, config] = await Promise.all([
      usersService.ensureProfile(user),
      usersService.listWalletTransactions(user.uid, 40),
      getConfig(),
    ]);

    ok(res, {
      balanceUsd: profile.walletBalanceUsd ?? 0,
      enabled: config.checkout.walletEnabled !== false,
      transactions,
    });
  })
);

meRouter.delete(
  '/player-ids/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { id } = parseParams(req, z.object({ id: z.string().min(1) }));
    await users().doc(user.uid).collection('playerIds').doc(id).delete();
    ok(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------------
// Notificaciones
// ---------------------------------------------------------------------------

meRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const snap = await users()
      .doc(user.uid)
      .collection('notifications')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    ok(res, {
      notifications: snap.docs.map(
        (doc) => ({ id: doc.id, ...doc.data() }) as UserNotification
      ),
    });
  })
);

meRouter.post(
  '/notifications/read-all',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const count = await notificationsService.markAllRead(user.uid);
    ok(res, { marked: count });
  })
);

// ---------------------------------------------------------------------------
// Referidos
// ---------------------------------------------------------------------------

meRouter.post(
  '/referral',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { code } = parseBody(req, z.object({ code: z.string().trim().min(4).max(20) }));

    const config = await getConfig();
    if (!config.features.referralsEnabled) {
      throw forbidden('El programa de referidos está desactivado.');
    }

    await usersService.applyReferral(user.uid, code);
    ok(res, { applied: true, profile: await usersService.getProfile(user.uid) });
  })
);

// ---------------------------------------------------------------------------
// Soporte
// ---------------------------------------------------------------------------

meRouter.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const snap = await tickets()
      .where('uid', '==', user.uid)
      .orderBy('updatedAt', 'desc')
      .limit(30)
      .get();

    ok(res, { tickets: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as Ticket) });
  })
);

const createTicketSchema = z.object({
  subject: z.string().trim().min(4).max(120),
  message: z.string().trim().min(4).max(2000),
  orderId: z.string().optional().nullable(),
});

meRouter.post(
  '/tickets',
  rateLimit({ name: 'ticket_create', max: 5, windowSeconds: 900 }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = parseBody(req, createTicketSchema);
    const profile = await usersService.ensureProfile(user);
    const timestamp = now();

    const ref = await tickets().add({
      uid: user.uid,
      userEmail: profile.email,
      userName: profile.displayName,
      subject: body.subject,
      orderId: body.orderId ?? null,
      status: 'open',
      lastMessagePreview: body.message.slice(0, 120),
      unreadForStaff: true,
      unreadForUser: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await ref.collection('messages').add({
      body: body.message,
      authorUid: user.uid,
      authorName: profile.displayName,
      fromStaff: false,
      createdAt: timestamp,
    });

    await adminAlerts.alert({
      kind: 'new_ticket',
      severity: 'warning',
      title: 'Nueva consulta de soporte',
      body: [
        `${profile.displayName ?? profile.email ?? 'Un cliente'}: ${body.subject}`,
        '',
        body.message.slice(0, 300),
      ].join('\n'),
      // Directo a la conversación, no a la lista.
      link: `/admin/soporte/${ref.id}`,
      data: { ticketId: ref.id, uid: user.uid, orderId: body.orderId ?? null },
    });

    ok(res, { id: ref.id }, 201);
  })
);

meRouter.get(
  '/tickets/:ticketId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { ticketId } = parseParams(req, z.object({ ticketId: z.string().min(1) }));

    const snap = await tickets().doc(ticketId).get();
    if (!snap.exists) throw notFound('Ticket no encontrado.');

    const ticket = { id: snap.id, ...snap.data() } as Ticket;
    if (ticket.uid !== user.uid && !user.isStaff) throw forbidden('Ese ticket no es tuyo.');

    const messages = await snap.ref.collection('messages').orderBy('createdAt', 'asc').get();

    if (ticket.unreadForUser && ticket.uid === user.uid) {
      await snap.ref.set({ unreadForUser: false }, { merge: true });
    }

    ok(res, {
      ticket,
      messages: messages.docs.map((doc) => ({ id: doc.id, ...doc.data() }) as TicketMessage),
    });
  })
);

meRouter.post(
  '/tickets/:ticketId/messages',
  rateLimit({ name: 'ticket_message', max: 30, windowSeconds: 600 }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const { ticketId } = parseParams(req, z.object({ ticketId: z.string().min(1) }));
    const { body } = parseBody(req, z.object({ body: z.string().trim().min(1).max(2000) }));

    const ref = tickets().doc(ticketId);
    const snap = await ref.get();
    if (!snap.exists) throw notFound('Ticket no encontrado.');

    const ticket = { id: snap.id, ...snap.data() } as Ticket;
    if (ticket.uid !== user.uid && !user.isStaff) throw forbidden('Ese ticket no es tuyo.');

    const profile = await usersService.ensureProfile(user);
    const fromStaff = user.isStaff && ticket.uid !== user.uid;

    await ref.collection('messages').add({
      body,
      authorUid: user.uid,
      authorName: profile.displayName,
      fromStaff,
      createdAt: now(),
    });

    await ref.set(
      {
        lastMessagePreview: body.slice(0, 120),
        status: 'open',
        unreadForStaff: !fromStaff,
        unreadForUser: fromStaff,
        updatedAt: now(),
      },
      { merge: true }
    );

    if (fromStaff) {
      await notificationsService.notify({
        uid: ticket.uid,
        title: 'Respondimos tu consulta',
        body: body.slice(0, 100),
        type: 'system',
        link: `/soporte/${ticketId}`,
      });
    } else {
      await adminAlerts.alert({
        kind: 'ticket_reply',
        severity: 'info',
        title: `Respuesta del cliente · ${ticket.subject}`,
        body: `${profile.displayName ?? profile.email ?? 'Un cliente'}: ${body.slice(0, 300)}`,
        link: `/admin/soporte/${ticketId}`,
        data: { ticketId, uid: user.uid },
      });
    }

    ok(res, { sent: true }, 201);
  })
);

/** Enlace de WhatsApp de soporte, opcionalmente con contexto de una orden. */
meRouter.get(
  '/support-link',
  asyncHandler(async (req, res) => {
    const config = await getConfig();
    const orderCode = typeof req.query.orderCode === 'string' ? req.query.orderCode : undefined;
    ok(res, { url: buildSupportUrl(config.whatsapp.supportNumber, { orderCode }) });
  })
);

/** Borrado de cuenta a petición del usuario (anonimiza, no destruye órdenes). */
meRouter.post(
  '/close-account',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await users().doc(user.uid).set(
      {
        displayName: 'Cuenta cerrada',
        phone: null,
        photoURL: null,
        banned: true,
        bannedReason: 'Cierre solicitado por el usuario',
        closedAt: now(),
        preferences: { notifyEmail: false, notifyOrderUpdates: false },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    ok(res, { closed: true });
  })
);
