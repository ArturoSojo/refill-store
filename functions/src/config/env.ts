/**
 * Parámetros y secretos de la API.
 *
 * Los API keys de Pabilo e Inefable se guardan en Google Secret Manager mediante
 * `defineSecret`. Nunca llegan al bundle del frontend ni al repositorio.
 *
 *   firebase functions:secrets:set PABILO_API_KEY
 *   firebase functions:secrets:set PABILO_USER_BANK_ID
 *   firebase functions:secrets:set INEFABLE_API_KEY
 *
 * Para los emuladores basta con `functions/.secret.local` (ignorado por git).
 *
 * Lo que NO es secreto (URLs base, orígenes permitidos) se resuelve con
 * `process.env` y un valor por defecto, en lugar de `defineString`: los
 * parámetros declarados hacen que el emulador pida confirmación por consola en
 * cada arranque, lo que rompe cualquier flujo no interactivo.
 */
import { defineSecret } from 'firebase-functions/params';

// --- Secretos ---------------------------------------------------------------

export const PABILO_API_KEY = defineSecret('PABILO_API_KEY');
export const PABILO_USER_BANK_ID = defineSecret('PABILO_USER_BANK_ID');
/** Cuenta de Pabilo asociada a Binance Pay; se usa sólo al verificar ese método. */
export const PABILO_BINANCE_USER_BANK_ID = defineSecret('PABILO_BINANCE_USER_BANK_ID');
export const INEFABLE_API_KEY = defineSecret('INEFABLE_API_KEY');
/** Credencial de Gemini; se usa únicamente desde Cloud Functions. */
export const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

/** API key del revendedor FazerCards (`fc_…`). Nunca llega al navegador. */
export const FAZERCARDS_API_KEY = defineSecret('FAZERCARDS_API_KEY');
/** Secreto HMAC que FazerCards devuelve al registrar el webhook. */
export const FAZERCARDS_WEBHOOK_SECRET = defineSecret('FAZERCARDS_WEBHOOK_SECRET');
/** Fragmento aleatorio de la URL pública del webhook de FazerCards. */
export const FAZERCARDS_WEBHOOK_TOKEN = defineSecret('FAZERCARDS_WEBHOOK_TOKEN');

/** API key de Central One (`co_live_…`). Nunca llega al navegador. */
export const CENTRAL_ONE_API_KEY = defineSecret('CENTRAL_ONE_API_KEY');

/**
 * Secreto HMAC de los avisos de Central One (`X-CentralOne-Signature`).
 *
 * El portal lo muestra una sola vez, al registrar la URL del webhook. Como
 * `firebase deploy` falla si un secreto declarado no existe, hasta tenerlo se
 * guarda `PENDIENTE`; `centralOneWebhookSecret()` lo trata como «sin
 * configurar» y la ruta responde 503 en vez de aceptar avisos sin firmar.
 *
 *   firebase functions:secrets:set CENTRAL_ONE_WEBHOOK_SECRET
 */
export const CENTRAL_ONE_WEBHOOK_SECRET = defineSecret('CENTRAL_ONE_WEBHOOK_SECRET');

/**
 * Token de un solo uso para los endpoints de arranque (`/api/setup/*`), que
 * crean el primer administrador y siembran el catálogo. Sin él, esas rutas
 * quedan cerradas.
 */
export const SETUP_TOKEN = defineSecret('SETUP_TOKEN');

/**
 * Token del bot de Telegram que avisa al equipo (despachos fallidos, tickets,
 * saldo bajo). Opcional: sin él los avisos siguen quedando en el panel.
 *
 *   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
 */
export const TELEGRAM_BOT_TOKEN = defineSecret('TELEGRAM_BOT_TOKEN');

/**
 * Token del bot de Telegram para atención al cliente y administración rápida.
 *
 *   firebase functions:secrets:set TELEGRAM_SUPPORT_BOT_TOKEN
 */
export const TELEGRAM_SUPPORT_BOT_TOKEN = defineSecret('TELEGRAM_SUPPORT_BOT_TOKEN');

/**
 * API Key de Resend para enviar correos transaccionales vía SMTP (`smtp.resend.com`).
 *
 *   firebase functions:secrets:set RESEND_API_KEY
 */
export const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

/**
 * Contraseña de aplicación de Gmail (legado).
 *
 *   firebase functions:secrets:set GMAIL_APP_PASSWORD
 */
export const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

/**
 * Secreto de firma del webhook de Inefable.
 *
 * Lo genera su panel y sólo se muestra una vez. Sirve para validar la cabecera
 * `X-Webhook-Signature` de cada aviso.
 *
 *   firebase functions:secrets:set INEFABLE_WEBHOOK_SECRET
 */
export const INEFABLE_WEBHOOK_SECRET = defineSecret('INEFABLE_WEBHOOK_SECRET');

/**
 * Fragmento aleatorio de la URL del webhook.
 *
 * No sustituye a la firma: sólo evita que cualquier escáner que encuentre el
 * dominio nos haga trabajar. La ruta se comparte con el proveedor y nada más.
 */
export const INEFABLE_WEBHOOK_TOKEN = defineSecret('INEFABLE_WEBHOOK_TOKEN');

/**
 * Clave compartida para `POST /api/orders/sync-whatsapp` desde RefillBot.
 * Vive en Secret Manager; el mismo valor va en `SYNC_SECRET_KEY` del .env del bot.
 */
export const SYNC_SECRET_KEY = defineSecret('SYNC_SECRET_KEY');

/** Todos los secretos que necesita la función `api`. */
export const API_SECRETS = [
  PABILO_API_KEY,
  PABILO_USER_BANK_ID,
  PABILO_BINANCE_USER_BANK_ID,
  INEFABLE_API_KEY,
  GEMINI_API_KEY,
  FAZERCARDS_API_KEY,
  FAZERCARDS_WEBHOOK_SECRET,
  FAZERCARDS_WEBHOOK_TOKEN,
  CENTRAL_ONE_API_KEY,
  CENTRAL_ONE_WEBHOOK_SECRET,
  SETUP_TOKEN,
  TELEGRAM_BOT_TOKEN,
  RESEND_API_KEY,
  GMAIL_APP_PASSWORD,
  INEFABLE_WEBHOOK_SECRET,
  INEFABLE_WEBHOOK_TOKEN,
  SYNC_SECRET_KEY,
  TELEGRAM_SUPPORT_BOT_TOKEN,
];

// --- Configuración no secreta ----------------------------------------------

const fromEnv = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
};

export const pabiloBaseUrl = () => fromEnv('PABILO_BASE_URL', 'https://api.pabilo.app');

export const inefableBaseUrl = () =>
  fromEnv('INEFABLE_BASE_URL', 'https://inefablerevendedores.co');

/**
 * Ruta de despacho. El documento técnico decía `/api/v1/order`, pero esa ruta
 * responde 404: la real es `/api/v1/recharge`. Queda configurable para poder
 * corregirla sin desplegar código si el proveedor la vuelve a mover.
 */
export const inefableRechargePath = () =>
  fromEnv('INEFABLE_RECHARGE_PATH', '/api/v1/recharge');

/** Timeout explícito por petición al despacho de Inefable (45 s por defecto). */
export const inefableTimeoutMs = (): number => {
  const parsed = Number(fromEnv('INEFABLE_TIMEOUT_MS', '45000'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 45_000;
};

/** Token para el segundo bot de Telegram (Soporte al cliente y administración rápida). */
export const telegramSupportBotToken = (): string => {
  try {
    const fromSecret = TELEGRAM_SUPPORT_BOT_TOKEN.value().trim();
    if (fromSecret) return fromSecret;
  } catch {
    // Fuera de Cloud Functions el secreto no está enlazado.
  }
  return fromEnv('TELEGRAM_SUPPORT_BOT_TOKEN', '');
};

/** Clave compartida para el endpoint `POST /api/orders/sync-whatsapp` desde RefillBot. */
export const syncSecretKey = (): string => {
  try {
    const fromSecret = SYNC_SECRET_KEY.value().trim();
    if (fromSecret) return fromSecret;
  } catch {
    // Fuera de Cloud Functions el secreto no esta enlazado.
  }
  return fromEnv('SYNC_SECRET_KEY', '');
};

/** Base v2 de FazerCards. */
export const fazerBaseUrl = () => fromEnv('FAZERCARDS_BASE_URL', 'https://api.fzr.cards/api/v2');

/** Base v1 de Central One. */
export const centralOneBaseUrl = () =>
  fromEnv('CENTRAL_ONE_BASE_URL', 'https://portal.centraloneglobal.com/api/v1');

/**
 * Valores que se guardan como marcador cuando el secreto real aún no existe.
 * Confundirlos con una clave haría llamadas condenadas a fallar (o, en el
 * webhook, firmar con un secreto que cualquiera puede adivinar).
 */
const SECRET_PLACEHOLDERS = new Set(['', 'PENDIENTE', 'CAMBIAME', 'TODO']);

const isPlaceholder = (value: string): boolean =>
  SECRET_PLACEHOLDERS.has(value.trim().toUpperCase());

/** Clave de autenticación para Central One API v1. `''` si falta o es un marcador. */
export const centralOneApiKey = (): string => {
  try {
    const fromSecret = CENTRAL_ONE_API_KEY.value().trim();
    if (fromSecret && !isPlaceholder(fromSecret)) return fromSecret;
  } catch {
    // Fuera de Cloud Functions el secreto no está enlazado.
  }
  const fromProcess = fromEnv('CENTRAL_ONE_API_KEY', '');
  return isPlaceholder(fromProcess) ? '' : fromProcess;
};

/**
 * Secreto de firma del webhook de Central One, o `null` si no está configurado
 * (vacío o `PENDIENTE`). La ruta del webhook responde 503 con `null`.
 */
export const centralOneWebhookSecret = (): string | null => {
  try {
    const fromSecret = CENTRAL_ONE_WEBHOOK_SECRET.value().trim();
    if (fromSecret && !isPlaceholder(fromSecret)) return fromSecret;
  } catch {
    // Fuera de Cloud Functions el secreto no está enlazado.
  }
  const fromProcess = fromEnv('CENTRAL_ONE_WEBHOOK_SECRET', '');
  return isPlaceholder(fromProcess) ? null : fromProcess;
};

/** Fuente pública para refrescar la tasa BCV cuando `rate.source = auto`. */
export const rateSourceUrl = () =>
  fromEnv('RATE_SOURCE_URL', 'https://pydolarve.org/api/v2/tipo-cambio?currency=usd');

/** Modelo de respuestas cortas del asistente de soporte. */
export const geminiModel = () => fromEnv('GEMINI_MODEL', 'gemini-3.8-flash');

const DEFAULT_ORIGINS = [
  // Dominio personalizado de producción.
  'https://recargasrefillstore.com',
  // Hosting de Firebase, por si se despliega también ahí.
  'https://refill-e254f.web.app',
  'https://refill-e254f.firebaseapp.com',
  // Desarrollo local.
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://localhost:5080',
  'http://localhost:5174',
  'http://localhost:5175',
].join(',');

/** Orígenes permitidos para CORS, separados por coma. */
export function parseAllowedOrigins(): string[] {
  return fromEnv('ALLOWED_ORIGINS', DEFAULT_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const REGION = 'us-central1';

/** `true` cuando corremos dentro del emulador de Functions. */
export function isEmulator(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true';
}
