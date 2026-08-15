/**
 * Configuración de la tienda (`config/app`).
 *
 * Es un único documento que el panel de administración edita en caliente: tasa,
 * datos del Pago Móvil, mensajes, banderas de funcionalidades. Se cachea unos
 * segundos en memoria porque casi todos los endpoints lo consultan.
 */
import { configDoc, now } from '../config/firebase';
import { DEFAULT_TIERS } from '../lib/tiers';
import type { AppConfig, PublicConfig } from '../types/models';

/** Valores iniciales tomados del documento de especificaciones. */
export const DEFAULT_CONFIG: AppConfig = {
  storeName: 'Refill Store',
  tagline: 'Recargas al instante para tus juegos favoritos',
  rate: {
    value: 760.5,
    source: 'manual',
    markupPercent: 0,
    autoRefresh: false,
    updatedAt: null,
    updatedBy: null,
  },
  bank: {
    code: '0102',
    name: 'Banco de Venezuela',
    idNumber: 'V-31.955.598',
    phone: '0412-2686326',
    holder: 'Refill Store',
  },
  whatsapp: {
    adminNumber: '584122686326',
    supportNumber: '584122686326',
  },
  checkout: {
    referenceMinLength: 4,
    referenceMaxLength: 20,
    orderExpiryMinutes: 30,
    amountTolerancePercent: 0.5,
    maxVerifyAttempts: 5,
    maxOpenOrdersPerUser: 3,
    walletEnabled: true,
  },
  email: {
    enabled: true,
    fromAddress: 'Soporterefillstore@gmail.com',
    fromName: 'Refill Store',
    replyTo: 'Soporterefillstore@gmail.com',
    onPaymentVerified: true,
    onDelivered: true,
    // El cliente ya pagó y no recibió nada: sin un correo, se va directo a
    // reclamar por WhatsApp sin saber que ya lo están atendiendo.
    onDispatchFailed: true,
  },
  alerts: {
    enabled: true,
    telegramChatId: '',
    webhookUrl: '',
    notifyOnDispatchFailed: true,
    notifyOnManualOrder: true,
    notifyOnNewTicket: true,
    // Un pago rechazado casi siempre es el cliente escribiendo mal la
    // referencia: avisar por cada uno sería ruido. Apagado por defecto.
    notifyOnPaymentRejected: false,
    lowBalanceThresholdUsd: 10,
  },
  features: {
    maintenanceMode: false,
    maintenanceMessage: 'Estamos haciendo mantenimiento. Volvemos en unos minutos.',
    autoDispatchEnabled: true,
    manualProductsEnabled: true,
    couponsEnabled: true,
    referralsEnabled: true,
  },
  announcement: {
    enabled: false,
    text: '',
    type: 'info',
  },
  pricing: {
    defaultMarginPercent: 25,
    roundToUsd: 0.05,
    roundToBs: 0.01,
  },
  contact: {
    email: '',
    instagram: '',
    telegram: '',
  },
  tiers: [...DEFAULT_TIERS],
  updatedAt: null,
  updatedBy: null,
};

const CACHE_TTL_MS = 15_000;

let cached: { value: AppConfig; expiresAt: number } | null = null;

/** Mezcla profunda de los valores guardados sobre los valores por defecto. */
function mergeConfig(stored: Record<string, unknown> | undefined): AppConfig {
  if (!stored) return { ...DEFAULT_CONFIG };

  const merged = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;
  for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG)) {
    const storedValue = stored[key];
    if (storedValue === undefined || storedValue === null) continue;

    if (
      typeof defaultValue === 'object' &&
      defaultValue !== null &&
      !Array.isArray(defaultValue) &&
      typeof storedValue === 'object' &&
      !Array.isArray(storedValue)
    ) {
      merged[key] = { ...(defaultValue as object), ...(storedValue as object) };
    } else {
      merged[key] = storedValue;
    }
  }
  return merged as unknown as AppConfig;
}

export function invalidateConfigCache(): void {
  cached = null;
}

export async function getConfig(options: { fresh?: boolean } = {}): Promise<AppConfig> {
  if (!options.fresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const snap = await configDoc().get();
  const value = mergeConfig(snap.data());
  cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Crea el documento de configuración si aún no existe. */
export async function ensureConfig(): Promise<AppConfig> {
  const snap = await configDoc().get();
  if (!snap.exists) {
    await configDoc().set({ ...DEFAULT_CONFIG, updatedAt: now() });
    invalidateConfigCache();
    return { ...DEFAULT_CONFIG };
  }
  return getConfig({ fresh: true });
}

/** Actualiza parcialmente la configuración desde el panel. */
export async function updateConfig(
  patch: Record<string, unknown>,
  updatedBy: string | null
): Promise<AppConfig> {
  await configDoc().set(
    { ...patch, updatedAt: now(), updatedBy },
    { merge: true }
  );
  invalidateConfigCache();
  return getConfig({ fresh: true });
}

/** Proyección segura para clientes anónimos: nada de números de admin ni márgenes. */
export function toPublicConfig(config: AppConfig): PublicConfig {
  return {
    storeName: config.storeName,
    tagline: config.tagline,
    rate: config.rate.value,
    bank: config.bank,
    whatsapp: { supportNumber: config.whatsapp.supportNumber },
    // `alerts` NO va aquí: contiene el chat de Telegram y la URL del webhook
    // del equipo, que no tienen por qué ser públicos.
    checkout: config.checkout,
    features: {
      maintenanceMode: config.features.maintenanceMode,
      maintenanceMessage: config.features.maintenanceMessage,
      couponsEnabled: config.features.couponsEnabled,
      referralsEnabled: config.features.referralsEnabled,
    },
    announcement: config.announcement,
    contact: config.contact,
  };
}
