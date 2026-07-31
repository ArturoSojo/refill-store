/** Inicialización única del Admin SDK y atajos a las colecciones. */
import { initializeApp, getApps, App } from 'firebase-admin/app';
import { getFirestore, Firestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth, Auth } from 'firebase-admin/auth';

let app: App;

if (getApps().length === 0) {
  app = initializeApp();
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
export const configDoc = () => db.collection(COLLECTIONS.config).doc(CONFIG_DOC_ID);
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
