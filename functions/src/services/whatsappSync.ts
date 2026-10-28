/**
 * Sincronización de órdenes desde RefillBot (WhatsApp) hacia la plataforma Web.
 *
 * Responsabilidades (Tarea D):
 *  - Autenticar el webhook `POST /api/orders/sync-whatsapp` mediante comparación
 *    en tiempo constante de `x-api-secret` contra `SYNC_SECRET_KEY`.
 *  - Normalizar teléfonos venezolanos (`@s.whatsapp.net` -> `+584...` / `04...`)
 *    y vincular con usuarios registrados en la Web por teléfono o `playerId`.
 *  - Guardar/actualizar el documento en `orders/wa_${referencia}` unificando el
 *    esquema de negocio (Tarea B) con el esquema nativo `Order` del panel Web.
 *  - Incrementar atómicamente (`FieldValue.increment(montoUsd)`) el gasto
 *    acumulado del cliente, recalcular su nivel de membresía (`hierro` -> `diamante`)
 *    y registrar las métricas diarias de forma estrictamente idempotente
 *    (`metricsAccounted: true`).
 */
import { timingSafeEqual } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  db,
  now,
  orders,
  paymentRefs,
  privateWhatsappSyncConfigDoc,
  users,
} from '../config/firebase';
import { syncSecretKey } from '../config/env';
import { failedPrecondition, invalidArgument, unauthenticated } from '../lib/errors';
import { normalizeReference, slugify } from '../lib/ids';
import { log } from '../lib/logger';
import { round } from '../lib/money';
import * as tiers from '../lib/tiers';
import * as stats from './stats';
import { activeLadder } from './users';
import type {
  DispatchCallResult,
  Order,
  OrderBusinessEstado,
  OrderStatus,
  OrderSubOrden,
  UserProfile,
} from '../types/models';

const subOrdenSchema = z.object({
  product_id: z.number(),
  package_id: z.number().optional(),
  exito: z.boolean(),
  order_id: z.union([z.number(), z.string()]).nullable().optional(),
  status: z.string(),
  error: z.string().nullable().optional(),
  httpStatus: z.number().nullable().optional(),
  timestamp: z.string(),
});

export const whatsappSyncPayloadSchema = z.object({
  orderId: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  referencia: z.string().min(4),
  canal: z.enum(['WHATSAPP', 'WEB']).default('WHATSAPP'),
  origen: z.enum(['WHATSAPP', 'WEB']).default('WHATSAPP'),
  clienteContacto: z.string().optional().default(''),
  juego: z.string().min(1),
  gameId: z.string().optional(),
  paqueteNombre: z.string().min(1),
  productId: z.string().optional(),
  productIds: z.array(z.number()).optional().default([]),
  playerId: z.string().optional().default(''),
  montoBs: z.number().nonnegative(),
  tasaBcv: z.number().positive(),
  montoUsd: z.number().nonnegative().optional(),
  costoProveedorUsd: z.number().nonnegative().optional().default(0),
  gananciaNetaUsd: z.number().optional(),
  tipoDespacho: z.enum(['AUTOMATICO', 'MANUAL']).default('AUTOMATICO'),
  estado: z
    .enum([
      'PAGO_VALIDADO',
      'DESPACHANDO_INEFABLE',
      'COMPLETADO',
      'ENTREGA_PARCIAL_COMBO',
      'REVISION_MANUAL',
    ])
    .default('COMPLETADO'),
  status: z
    .enum([
      'awaiting_payment',
      'payment_rejected',
      'paid',
      'dispatching',
      'completed',
      'awaiting_manual',
      'in_review',
      'failed',
      'cancelled',
      'refunded',
      'expired',
    ])
    .optional(),
  subOrdenes: z.array(subOrdenSchema).optional().default([]),
  errorMessage: z.string().nullable().optional(),
  providerError: z.string().nullable().optional(),
  userId: z.string().nullable().optional(),
});

export type WhatsappSyncPayload = z.infer<typeof whatsappSyncPayloadSchema>;

let cachedFirestoreSecret: { value: string; expiresAt: number } | null = null;

function safeSecretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

async function resolveExpectedSyncSecret(): Promise<string> {
  const fromEnv = syncSecretKey();
  if (fromEnv) return fromEnv;

  if (cachedFirestoreSecret && cachedFirestoreSecret.expiresAt > Date.now()) {
    return cachedFirestoreSecret.value;
  }

  try {
    const snap = await privateWhatsappSyncConfigDoc().get();
    const secret = String(snap.data()?.secretKey ?? '').trim();
    cachedFirestoreSecret = { value: secret, expiresAt: Date.now() + 30_000 };
    return secret;
  } catch (err) {
    log.warn('No se pudo leer privateConfig/whatsappSync', {
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

/** Verifica `x-api-secret` contra `SYNC_SECRET_KEY` (o `privateConfig/whatsappSync`). */
export async function verifySyncSecret(headerSecret: string | undefined): Promise<void> {
  const expected = await resolveExpectedSyncSecret();
  if (!expected) {
    throw failedPrecondition('SYNC_SECRET_KEY no está configurada en el servidor.');
  }
  const received = (headerSecret ?? '').trim();
  if (!received || !safeSecretEquals(received, expected)) {
    throw unauthenticated('Credencial de sincronización inválida (x-api-secret).');
  }
}

export interface NormalizedWhatsappPhone {
  e164: string;
  local: string | null;
  digits: string;
  candidates: string[];
}

/**
 * Normaliza un JID o teléfono de WhatsApp (`584141234567@s.whatsapp.net`,
 * `0414-1234567`, `+58 414 1234567`) al formato venezolano E.164 (`+584...`)
 * y nacional (`04...`).
 */
export function normalizeWhatsappPhone(raw: string | null | undefined): NormalizedWhatsappPhone {
  if (!raw) {
    return { e164: '', local: null, digits: '', candidates: [] };
  }

  const withoutDomain = String(raw).trim().split('@')[0] ?? '';
  const digits = withoutDomain.replace(/\D/g, '');
  if (!digits) {
    return { e164: '', local: null, digits: '', candidates: [] };
  }

  let e164 = `+${digits}`;
  let local: string | null = null;

  if (digits.startsWith('58') && digits.length === 12) {
    e164 = `+${digits}`;
    local = `0${digits.slice(2)}`;
  } else if (digits.startsWith('04') && digits.length === 11) {
    e164 = `+58${digits.slice(1)}`;
    local = digits;
  } else if (/^4(12|14|16|22|24|26)\d{7}$/.test(digits)) {
    e164 = `+58${digits}`;
    local = `0${digits}`;
  }

  const candidates = Array.from(
    new Set([e164, local, digits, local ? `+58${local.slice(1)}` : null].filter(Boolean) as string[])
  );

  return { e164, local, digits, candidates };
}

function mapEstadoToWebStatus(
  estado: OrderBusinessEstado,
  tipoDespacho: 'AUTOMATICO' | 'MANUAL'
): OrderStatus {
  switch (estado) {
    case 'COMPLETADO':
      return 'completed';
    case 'DESPACHANDO_INEFABLE':
      return 'dispatching';
    case 'ENTREGA_PARCIAL_COMBO':
      return 'in_review';
    case 'REVISION_MANUAL':
      return tipoDespacho === 'MANUAL' ? 'awaiting_manual' : 'in_review';
    case 'PAGO_VALIDADO':
    default:
      return 'paid';
  }
}

function inferGameId(juego: string, explicitGameId?: string): string {
  if (explicitGameId && explicitGameId.trim()) return explicitGameId.trim();
  const low = juego.toLowerCase();
  if (low.includes('free fire')) return 'free-fire';
  if (low.includes('blood strike')) return 'blood-strike';
  if (low.includes('call of duty') || low.includes('cod')) return 'call-of-duty';
  if (low.includes('roblox')) return 'roblox';
  if (low.includes('mobile legends')) return 'mobile-legends';
  return slugify(juego) || 'otros';
}

/**
 * Busca si el comprador de WhatsApp tiene cuenta registrada en la Web App
 * coincidiendo por teléfono normalizado (`+58...` / `04...`) o por `playerId`.
 */
export async function resolveWebUserForWhatsappOrder(params: {
  explicitUserId?: string | null;
  phoneRaw?: string | null;
  playerId?: string | null;
}): Promise<UserProfile | null> {
  if (params.explicitUserId && !params.explicitUserId.startsWith('whatsapp:')) {
    const explicitSnap = await users().doc(params.explicitUserId).get();
    if (explicitSnap.exists) {
      return { uid: explicitSnap.id, ...(explicitSnap.data() as Omit<UserProfile, 'uid'>) };
    }
  }

  const phone = normalizeWhatsappPhone(params.phoneRaw);
  if (phone.candidates.length > 0) {
    const queryCandidates = phone.candidates.slice(0, 10);
    const byPhone = await users().where('phone', 'in', queryCandidates).limit(1).get();
    if (!byPhone.empty) {
      const doc = byPhone.docs[0];
      return { uid: doc.id, ...(doc.data() as Omit<UserProfile, 'uid'>) };
    }
  }

  const cleanPlayerId = (params.playerId ?? '').trim();
  if (cleanPlayerId) {
    // 1) Subcolección `users/{uid}/playerIds` si collectionGroup está disponible
    const dbWithGroup = db as FirebaseFirestore.Firestore & {
      collectionGroup?: (collectionId: string) => FirebaseFirestore.Query;
    };
    if (typeof dbWithGroup.collectionGroup === 'function') {
      try {
        const groupSnap = await dbWithGroup
          .collectionGroup('playerIds')
          .where('playerId', '==', cleanPlayerId)
          .limit(3)
          .get();
        for (const pDoc of groupSnap.docs) {
          const parentUserRef = pDoc.ref?.parent?.parent;
          if (parentUserRef) {
            const uSnap = await parentUserRef.get();
            if (uSnap.exists) {
              return { uid: uSnap.id, ...(uSnap.data() as Omit<UserProfile, 'uid'>) };
            }
          }
        }
      } catch (err) {
        log.warn('Búsqueda collectionGroup(playerIds) omitida en sync WhatsApp', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2) Historial de órdenes Web autenticadas con el mismo `playerId`
    try {
      const ordSnap = await orders().where('playerId', '==', cleanPlayerId).limit(5).get();
      for (const ordDoc of ordSnap.docs) {
        const ordData = ordDoc.data() as Partial<Order>;
        if (ordData.uid && !ordData.uid.startsWith('whatsapp:')) {
          const uSnap = await users().doc(ordData.uid).get();
          if (uSnap.exists) {
            return { uid: uSnap.id, ...(uSnap.data() as Omit<UserProfile, 'uid'>) };
          }
        }
      }
    } catch (err) {
      log.warn('Búsqueda de usuario por órdenes previas omitida en sync WhatsApp', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return null;
}

export interface SyncWhatsappResult {
  orderId: string;
  code: string;
  status: OrderStatus;
  estado: OrderBusinessEstado;
  matchedUserId: string | null;
  metricsAccountedNow: boolean;
  newTier: string | null;
}

/**
 * Registra o actualiza en Firestore una orden originada en RefillBot (WhatsApp)
 * y sincroniza gasto acumulado + membresía + estadísticas del panel Web.
 */
export async function syncWhatsappOrder(rawInput: unknown): Promise<SyncWhatsappResult> {
  const parsed = whatsappSyncPayloadSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw invalidArgument('Payload de sincronización de WhatsApp inválido.', {
      issues: parsed.error.issues,
    });
  }

  const input = parsed.data;
  const cleanRef = normalizeReference(input.referencia);
  if (cleanRef.length < 4) {
    throw invalidArgument('La referencia bancaria debe tener al menos 4 dígitos.');
  }

  const orderId = input.orderId?.trim() || `wa_${cleanRef}`;
  const phone = normalizeWhatsappPhone(input.clienteContacto);
  const clienteContacto = phone.e164 || input.clienteContacto.trim();

  const matchedUser = await resolveWebUserForWhatsappOrder({
    explicitUserId: input.userId,
    phoneRaw: input.clienteContacto,
    playerId: input.playerId,
  });

  const montoBs = round(input.montoBs, 2);
  const tasaBcv = round(input.tasaBcv, 4);
  const montoUsd = round(input.montoUsd ?? montoBs / tasaBcv, 2);
  const costoProveedorUsd = round(input.costoProveedorUsd ?? 0, 4);
  const gananciaNetaUsd = round(input.gananciaNetaUsd ?? montoUsd - costoProveedorUsd, 4);

  const nextStatus = input.status ?? mapEstadoToWebStatus(input.estado, input.tipoDespacho);
  const gameId = inferGameId(input.juego, input.gameId);
  const productId =
    input.productId?.trim() || `${gameId}-${slugify(input.paqueteNombre) || 'whatsapp-pack'}`;
  const isBloodStrike = gameId === 'blood-strike';
  const providerGameId = isBloodStrike ? 2 : 1;

  const subOrdenes: OrderSubOrden[] = input.subOrdenes.map((s) => ({
    product_id: s.product_id,
    package_id: s.package_id ?? s.product_id,
    exito: s.exito,
    order_id: s.order_id != null ? String(s.order_id) : null,
    status: s.status,
    error: s.error ?? null,
    httpStatus: s.httpStatus ?? null,
    timestamp: s.timestamp,
  }));

  const ladder = await activeLadder();
  const orderRef = orders().doc(orderId);
  const paymentRefDoc = paymentRefs().doc(cleanRef);

  const txOutcome = await db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(orderRef);
    const existing = existingSnap.exists ? (existingSnap.data() as Partial<Order>) : null;

    const effectiveUid =
      matchedUser?.uid ??
      (existing?.uid && !existing.uid.startsWith('whatsapp:')
        ? existing.uid
        : `whatsapp:${clienteContacto || cleanRef}`);
    const isRegisteredUser = !effectiveUid.startsWith('whatsapp:');
    const userRef = isRegisteredUser ? users().doc(effectiveUid) : null;
    const userSnap = userRef ? await tx.get(userRef) : null;

    const timestamp = now();
    const createdAt = existing?.createdAt ?? timestamp;
    const code = existing?.code ?? input.code ?? `WA-${cleanRef.slice(-6)}`;
    const alreadyAccounted = existing?.metricsAccounted === true;
    const shouldAccountNow = nextStatus === 'completed' && !alreadyAccounted;

    const dispatchCalls: DispatchCallResult[] =
      subOrdenes.length > 0
        ? subOrdenes.map((sub, idx) => ({
            packageId: Number(sub.package_id ?? sub.product_id),
            providerGameId,
            index: idx,
            provider: isBloodStrike ? 'fazercards' : 'inefable',
            status: sub.exito ? 'success' : 'error',
            providerOrderId: sub.order_id != null ? String(sub.order_id) : null,
            providerStatus: sub.status,
            playerName: null,
            providerReference: null,
            error: sub.error ?? null,
            httpStatus: sub.httpStatus ?? null,
            providerResponse: null,
            attempts: 1,
            completedAt: sub.exito ? timestamp : null,
          }))
        : input.productIds.map((pkgId, idx) => ({
            packageId: pkgId,
            providerGameId,
            index: idx,
            provider: isBloodStrike ? 'fazercards' : 'inefable',
            status: nextStatus === 'completed' ? 'success' : 'pending',
            providerOrderId: null,
            providerStatus: nextStatus === 'completed' ? 'completed' : null,
            playerName: null,
            providerReference: null,
            error: null,
            httpStatus: null,
            providerResponse: null,
            attempts: nextStatus === 'completed' ? 1 : 0,
            completedAt: nextStatus === 'completed' ? timestamp : null,
          }));

    const providerError =
      nextStatus === 'completed'
        ? null
        : (input.providerError ?? input.errorMessage ?? existing?.providerError ?? null);

    const userSnapshot = userSnap?.exists
      ? {
          email: (userSnap.data()?.email as string | null) ?? matchedUser?.email ?? null,
          displayName:
            (userSnap.data()?.displayName as string | null) ??
            matchedUser?.displayName ??
            (clienteContacto ? `WhatsApp ${clienteContacto}` : 'Cliente WhatsApp'),
          photoURL: (userSnap.data()?.photoURL as string | null) ?? matchedUser?.photoURL ?? null,
        }
      : {
          email: existing?.user?.email ?? null,
          displayName:
            existing?.user?.displayName ??
            (clienteContacto ? `WhatsApp ${clienteContacto}` : 'Cliente WhatsApp'),
          photoURL: existing?.user?.photoURL ?? null,
        };

    const orderDoc: Omit<Order, 'id'> = {
      code,
      uid: effectiveUid,
      userId: isRegisteredUser ? effectiveUid : null,
      referencia: cleanRef,
      canal: 'WHATSAPP',
      origen: 'WHATSAPP',
      clienteContacto,
      juego: input.juego,
      paqueteNombre: input.paqueteNombre,
      productIds: input.productIds,
      montoBs,
      tasaBcv,
      montoUsd,
      costoProveedorUsd,
      gananciaNetaUsd,
      tipoDespacho: input.tipoDespacho,
      estado: input.estado,
      subOrdenes,
      metricsAccounted: alreadyAccounted || shouldAccountNow,
      user: userSnapshot,
      gameId,
      gameName: input.juego,
      providerGameId,
      provider: isBloodStrike ? 'fazercards' : 'inefable',
      providerFamily: 'topup',
      productId,
      productName: input.paqueteNombre,
      productSku: productId,
      productAmount: 1,
      productBonus: 0,
      fulfillment: input.tipoDespacho === 'AUTOMATICO' ? 'auto' : 'manual',
      playerId: input.playerId,
      playerId2: null,
      playerFields: input.playerId ? { playerId: input.playerId } : {},
      pricing: {
        unitUsd: montoUsd,
        quantity: 1,
        subtotalUsd: montoUsd,
        discountUsd: 0,
        totalUsd: montoUsd,
        walletAppliedUsd: 0,
        amountDueUsd: 0,
        rate: tasaBcv,
        totalBs: montoBs,
        couponCode: null,
        creatorCode: null,
        costUsd: costoProveedorUsd,
        profitUsd: gananciaNetaUsd,
      },
      creator: existing?.creator ?? null,
      contactPhone: clienteContacto || null,
      emailsSent: existing?.emailsSent ?? [],
      payment: {
        method: 'pagomovil_bdv',
        reference: cleanRef,
        reportedAmountBs: montoBs,
        partials: [
          {
            reference: cleanRef,
            amountBs: montoBs,
            verifiedAt: createdAt,
          },
        ],
        paidBs: montoBs,
        verifiedAt: createdAt,
        attempts: 1,
        providerResponse: existing?.payment?.providerResponse ?? { source: 'whatsapp_pabilo' },
        bankSnapshot: existing?.payment?.bankSnapshot ?? {
          code: '0102',
          name: 'Banco de Venezuela',
          idNumber: '',
          phone: '',
        },
      },
      dispatch: {
        calls: dispatchCalls,
        startedAt: existing?.dispatch?.startedAt ?? createdAt,
        completedAt: nextStatus === 'completed' ? (existing?.dispatch?.completedAt ?? timestamp) : null,
        lastError: providerError,
      },
      whatsappUrl: null,
      status: nextStatus,
      reviewDeadline: null,
      providerError,
      customerNote: existing?.customerNote ?? 'Orden procesada vía RefillBot (WhatsApp)',
      adminNote: existing?.adminNote ?? null,
      meta: existing?.meta ?? { ip: 'whatsapp-bot', userAgent: 'RefillBot-Sync/1.0' },
      createdAt,
      updatedAt: timestamp,
      expiresAt: existing?.expiresAt ?? timestamp,
    };

    tx.set(orderRef, orderDoc, { merge: true });
    tx.set(
      paymentRefDoc,
      {
        orderId,
        uid: effectiveUid,
        amountBs: montoBs,
        canal: 'WHATSAPP',
        createdAt,
      },
      { merge: true }
    );

    let computedTier: string | null = null;
    if (shouldAccountNow && userRef && userSnap?.exists && montoUsd > 0) {
      const userData = userSnap.data() as Partial<UserProfile>;
      const prevSpent = Number(userData.stats?.totalSpentUsd ?? 0);
      const newSpent = round(prevSpent + montoUsd, 2);
      const nextTier = tiers.tierForSpend(newSpent, ladder);
      const earnedPoints = Math.max(0, Math.round(montoUsd * 10));
      computedTier = nextTier;

      tx.set(
        userRef,
        {
          stats: {
            totalOrders: FieldValue.increment(existing ? 0 : 1),
            completedOrders: FieldValue.increment(1),
            totalSpentUsd: FieldValue.increment(montoUsd),
            lastOrderAt: timestamp,
          },
          points: FieldValue.increment(earnedPoints),
          tier: nextTier,
          updatedAt: timestamp,
        },
        { merge: true }
      );
    }

    return {
      savedOrder: { id: orderId, ...orderDoc } as Order,
      matchedUserId: isRegisteredUser && userSnap?.exists ? effectiveUid : null,
      shouldAccountNow,
      computedTier,
    };
  });

  if (txOutcome.shouldAccountNow) {
    try {
      await stats.trackEvent({
        type: 'order_completed',
        order: txOutcome.savedOrder,
      });
    } catch (err) {
      log.warn('No se pudo actualizar dailyStats desde sync-whatsapp', {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    orderId,
    code: txOutcome.savedOrder.code,
    status: txOutcome.savedOrder.status,
    estado: input.estado,
    matchedUserId: txOutcome.matchedUserId,
    metricsAccountedNow: txOutcome.shouldAccountNow,
    newTier: txOutcome.computedTier,
  };
}
