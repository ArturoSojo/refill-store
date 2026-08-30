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
export const INEFABLE_API_KEY = defineSecret('INEFABLE_API_KEY');

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
 * Contraseña de aplicación de Gmail para enviar los correos al cliente.
 *
 * No es la contraseña de la cuenta: se genera aparte en la seguridad de Google
 * y exige verificación en dos pasos. La cuenta remitente se configura en el
 * panel (`email.fromAddress`).
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

/** Todos los secretos que necesita la función `api`. */
export const API_SECRETS = [
  PABILO_API_KEY,
  PABILO_USER_BANK_ID,
  INEFABLE_API_KEY,
  SETUP_TOKEN,
  TELEGRAM_BOT_TOKEN,
  GMAIL_APP_PASSWORD,
  INEFABLE_WEBHOOK_SECRET,
  INEFABLE_WEBHOOK_TOKEN,
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

/** Fuente pública para refrescar la tasa BCV cuando `rate.source = auto`. */
export const rateSourceUrl = () =>
  fromEnv('RATE_SOURCE_URL', 'https://pydolarve.org/api/v2/tipo-cambio?currency=usd');

const DEFAULT_ORIGINS = [
  // Netlify sirve el frontend en producción. Aunque las peticiones llegan por
  // el proxy `/api/*` —y por tanto son del mismo origen para el navegador—, el
  // navegador sí manda cabecera `Origin` en los POST y Netlify la reenvía tal
  // cual, así que el dominio tiene que estar permitido aquí.
  'https://refill-store-ve.netlify.app',
  // Hosting de Firebase, por si se despliega también ahí.
  'https://refill-e254f.web.app',
  'https://refill-e254f.firebaseapp.com',
  // Desarrollo local.
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5080',
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
