/** Inicialización única del Admin SDK y atajos a las colecciones. */
import { initializeApp, getApps, App } from 'firebase-admin/app';
import { getFirestore, Firestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';

let app: App;

if (getApps().length === 0) {
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true';
  app = initializeApp(isEmulator ? { projectId: 'refill-e254f' } : undefined);
} else {
  app = getApps()[0];
}

export const db: Firestore = getFirestore(app);
export const auth: Auth = getAuth(app);

// `ignoreUndefinedProperties` evita que un campo opcional sin valor tumbe una
// escritura completa (pasa a menudo con respuestas de proveedores externos).
try {
  db.settings({ ignoreUndefinedProperties: true });
} catch {
  // Ya estaba configurado (recarga en caliente del emulador). No es un error.
}

export const COLLECTIONS = {
  games: 'games',
  products: 'products',
  orders: 'orders',
  users: 'users',
  coupons: 'coupons',
  config: 'config',
  auditLogs: 'auditLogs',
  tickets: 'tickets',
  paymentRefs: 'paymentRefs',
  rateHistory: 'rateHistory',
  rateLimits: 'rateLimits',
  stats: 'stats',
  adminAlerts: 'adminAlerts',
  creators: 'creators',
  /** Candado de unicidad del código: doc id = el código en mayúsculas. */
  creatorCodes: 'creatorCodes',
  modals: 'modals',
  /** Índice de IDs externos para resolver webhooks sin recorrer órdenes. */
  providerOrders: 'providerOrders',
  /** Sesiones activas y pausas de 30 min sincronizadas desde RefillBot (WhatsApp). */
  sessions: 'sessions',
  playerIdCache: 'playerIdCache',
  /**
   * Avisos de webhook ya procesados (doc id = `event_id`). Central One reintenta
   * el mismo aviso hasta recibir un 2xx: sin este candado un `order.completed`
   * repetido volvería a cerrar la orden. Caducan solos por TTL (`expireAt`).
   */
  providerWebhookEvents: 'providerWebhookEvents',
  /**
   * Cola e historial de sincronizaciones del catálogo de Central One. Crear un
   * doc `queued` dispara `runCentralOneSync` (trigger de Firestore, 9 min).
   */
  providerSync: 'providerSync',
} as const;

export const CONFIG_DOC_ID = 'app';

export const games = () => db.collection(COLLECTIONS.games);
export const products = () => db.collection(COLLECTIONS.products);
export const orders = () => db.collection(COLLECTIONS.orders);
export const users = () => db.collection(COLLECTIONS.users);
export const coupons = () => db.collection(COLLECTIONS.coupons);
export const auditLogs = () => db.collection(COLLECTIONS.auditLogs);
export const tickets = () => db.collection(COLLECTIONS.tickets);
export const paymentRefs = () => db.collection(COLLECTIONS.paymentRefs);
export const rateHistory = () => db.collection(COLLECTIONS.rateHistory);
export const rateLimits = () => db.collection(COLLECTIONS.rateLimits);
export const adminAlerts = () => db.collection(COLLECTIONS.adminAlerts);
export const creators = () => db.collection(COLLECTIONS.creators);
export const creatorCodes = () => db.collection(COLLECTIONS.creatorCodes);
export const modals = () => db.collection(COLLECTIONS.modals);
export const providerOrders = () => db.collection(COLLECTIONS.providerOrders);
export const sessions = () => db.collection(COLLECTIONS.sessions);
export const playerIdCache = () => db.collection(COLLECTIONS.playerIdCache);
export const providerWebhookEvents = () => db.collection(COLLECTIONS.providerWebhookEvents);
export const providerSync = () => db.collection(COLLECTIONS.providerSync);
export const configDoc = () => db.collection(COLLECTIONS.config).doc(CONFIG_DOC_ID);
/** Configuración privada que no se expone por las reglas públicas de Firestore. */
export const privateChatbotConfigDoc = () => db.collection('privateConfig').doc('chatbot');
export const privateWhatsappSyncConfigDoc = () => db.collection('privateConfig').doc('whatsappSync');
/**
 * Estado privado de Central One: última sync, marcador del retiro de
 * FazerCards, extras de Free Fire ya creados y último aviso del webhook.
 * Vive en `privateConfig` porque `config` sólo expone `app` al público.
 */
export const privateCentralOneConfigDoc = () => db.collection('privateConfig').doc('centralOne');
/**
 * Candado para encolar la sync de Central One: el cron y el panel lo toman en
 * una transacción, así que dos peticiones a la vez no encolan dos syncs.
 */
export const privateCentralOneSyncLockDoc = () => db.collection('privateConfig').doc('centralOneSyncLock');
export const dailyStats = () =>
  db.collection(COLLECTIONS.stats).doc('daily').collection('days');

export const now = () => Timestamp.now();

export function timestampFromDate(date: Date) {
  return Timestamp.fromDate(date);
}

export function minutesFromNow(minutes: number) {
  return Timestamp.fromMillis(Date.now() + minutes * 60_000);
}

export { Timestamp };
