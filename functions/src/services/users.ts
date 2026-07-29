/**
 * Perfiles de usuario.
 *
 * El documento se crea la primera vez que el usuario toca la API tras iniciar
 * sesión con Google (`ensureProfile`). No se usa un trigger de Auth porque el
 * flujo de compra necesita el perfil ya listo en ese mismo instante.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { auth, users, now } from '../config/firebase';
import { generateReferralCode } from '../lib/ids';
import { failedPrecondition, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { round } from '../lib/money';
import * as stats from './stats';
import type { AuthUser } from '../middleware/auth';
import type { UserProfile, UserRole, UserTier } from '../types/models';

const TIER_THRESHOLDS: Array<{ tier: UserTier; minSpentUsd: number }> = [
  { tier: 'diamante', minSpentUsd: 300 },
  { tier: 'oro', minSpentUsd: 120 },
  { tier: 'plata', minSpentUsd: 40 },
  { tier: 'bronce', minSpentUsd: 0 },
];

export function tierForSpend(totalSpentUsd: number): UserTier {
  return TIER_THRESHOLDS.find((t) => totalSpentUsd >= t.minSpentUsd)?.tier ?? 'bronce';
}

/** Descuento permanente por nivel de fidelidad, en porcentaje. */
export function tierDiscountPercent(tier: UserTier): number {
  switch (tier) {
    case 'diamante':
      return 4;
    case 'oro':
      return 3;
    case 'plata':
      return 1.5;
    default:
      return 0;
  }
}

/** Devuelve el perfil, creándolo si es la primera vez que entra el usuario. */
export async function ensureProfile(authUser: AuthUser): Promise<UserProfile> {
  const ref = users().doc(authUser.uid);
  const snap = await ref.get();
  const timestamp = now();

  if (snap.exists) {
    const profile = { uid: snap.id, ...snap.data() } as UserProfile;

    // Mantiene sincronizados los datos que Google puede haber cambiado.
    const patch: Record<string, unknown> = { lastLoginAt: timestamp };
    if (authUser.email && profile.email !== authUser.email) patch.email = authUser.email;
    if (authUser.photoURL && profile.photoURL !== authUser.photoURL) {
      patch.photoURL = authUser.photoURL;
    }
    if (!profile.displayName && authUser.displayName) patch.displayName = authUser.displayName;
    if (profile.role !== authUser.role) patch.role = authUser.role;

    await ref.set(patch, { merge: true });
    return { ...profile, ...(patch as Partial<UserProfile>) };
  }

  const profile: Omit<UserProfile, 'uid'> = {
    email: authUser.email,
    displayName: authUser.displayName,
    photoURL: authUser.photoURL,
    phone: null,
    role: authUser.role,
    banned: false,
    bannedReason: null,
    walletBalanceUsd: 0,
    points: 0,
    tier: 'bronce',
    referralCode: generateReferralCode(),
    referredBy: null,
    referralCount: 0,
    stats: {
      totalOrders: 0,
      completedOrders: 0,
      totalSpentUsd: 0,
      lastOrderAt: null,
    },
    preferences: {
      notifyEmail: true,
      notifyOrderUpdates: true,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoginAt: timestamp,
  };

  await ref.set(profile);
  await stats.trackEvent({ type: 'user_created' });
  log.info('Perfil de usuario creado', { uid: authUser.uid });

  return { uid: authUser.uid, ...profile };
}

export async function getProfile(uid: string): Promise<UserProfile> {
  const snap = await users().doc(uid).get();
  if (!snap.exists) throw notFound('Usuario no encontrado.');
  return { uid: snap.id, ...snap.data() } as UserProfile;
}

export async function getProfileOrNull(uid: string): Promise<UserProfile | null> {
  const snap = await users().doc(uid).get();
  return snap.exists ? ({ uid: snap.id, ...snap.data() } as UserProfile) : null;
}

/** Rechaza la operación si la cuenta está bloqueada. */
export function assertNotBanned(profile: UserProfile): void {
  if (profile.banned) {
    throw failedPrecondition(
      profile.bannedReason
        ? `Tu cuenta está suspendida: ${profile.bannedReason}`
        : 'Tu cuenta está suspendida. Contacta al soporte.'
    );
  }
}

/** Recompensa en saldo que recibe quien refirió, en la primera compra del referido. */
export const REFERRAL_REWARD_USD = 0.3;

/** Acumula la compra en las estadísticas del usuario y recalcula su nivel. */
export async function registerCompletedPurchase(
  uid: string,
  amountUsd: number
): Promise<void> {
  const ref = users().doc(uid);
  const snap = await ref.get();
  const data = snap.data() ?? {};
  const current = (data.stats?.totalSpentUsd as number | undefined) ?? 0;
  const completedBefore = (data.stats?.completedOrders as number | undefined) ?? 0;
  const referredBy = (data.referredBy as string | null | undefined) ?? null;
  const newTotal = round(current + amountUsd, 2);

  await ref.set(
    {
      stats: {
        completedOrders: FieldValue.increment(1),
        totalSpentUsd: newTotal,
        lastOrderAt: now(),
      },
      // 1 punto por cada 0,10 USD gastados.
      points: FieldValue.increment(Math.round(amountUsd * 10)),
      tier: tierForSpend(newTotal),
      updatedAt: now(),
    },
    { merge: true }
  );

  // La recompensa por referido se paga una sola vez: en la primera compra
  // completada de quien fue referido.
  if (referredBy && completedBefore === 0) {
    try {
      await users()
        .doc(referredBy)
        .set(
          {
            walletBalanceUsd: FieldValue.increment(REFERRAL_REWARD_USD),
            updatedAt: now(),
          },
          { merge: true }
        );
      log.info('Recompensa de referido acreditada', { referrer: referredBy, uid });
    } catch (error) {
      log.warn('No se pudo acreditar la recompensa de referido', {
        referrer: referredBy,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function registerCreatedOrder(uid: string): Promise<void> {
  await users()
    .doc(uid)
    .set(
      { stats: { totalOrders: FieldValue.increment(1) }, updatedAt: now() },
      { merge: true }
    );
}

/**
 * Cambia el rol. El claim del token es la fuente de verdad para las reglas de
 * seguridad; el campo en Firestore existe sólo para poder listar y filtrar.
 */
export async function setRole(uid: string, role: UserRole): Promise<void> {
  const claims =
    role === 'admin'
      ? { admin: true, staff: true }
      : role === 'staff'
        ? { admin: false, staff: true }
        : { admin: false, staff: false };

  await auth.setCustomUserClaims(uid, claims);
  await users().doc(uid).set({ role, updatedAt: now() }, { merge: true });
  // Fuerza a que el navegador pida un token nuevo con los claims actualizados.
  await auth.revokeRefreshTokens(uid);
}

export async function setBanned(
  uid: string,
  banned: boolean,
  reason: string | null
): Promise<void> {
  await users()
    .doc(uid)
    .set({ banned, bannedReason: banned ? reason : null, updatedAt: now() }, { merge: true });

  await auth.updateUser(uid, { disabled: banned });
  if (banned) await auth.revokeRefreshTokens(uid);
}

/** Ajuste manual de saldo desde el panel (reembolsos, cortesías). */
export async function adjustWallet(uid: string, deltaUsd: number): Promise<number> {
  const ref = users().doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw notFound('Usuario no encontrado.');

  const current = (snap.data()?.walletBalanceUsd as number | undefined) ?? 0;
  const next = round(current + deltaUsd, 2);
  if (next < 0) throw failedPrecondition('El saldo no puede quedar negativo.');

  await ref.set({ walletBalanceUsd: next, updatedAt: now() }, { merge: true });
  return next;
}

/** Aplica un código de referido si el usuario aún no tiene uno. */
export async function applyReferral(uid: string, code: string): Promise<void> {
  const normalized = code.trim().toUpperCase();
  const profile = await getProfile(uid);

  if (profile.referredBy) throw failedPrecondition('Ya usaste un código de referido.');
  if (profile.referralCode === normalized) {
    throw failedPrecondition('No puedes usar tu propio código.');
  }

  const match = await users().where('referralCode', '==', normalized).limit(1).get();
  if (match.empty) throw notFound('Ese código de referido no existe.');

  const referrer = match.docs[0];
  await users().doc(uid).set({ referredBy: referrer.id, updatedAt: now() }, { merge: true });
  await referrer.ref.set(
    { referralCount: FieldValue.increment(1), updatedAt: now() },
    { merge: true }
  );
}
