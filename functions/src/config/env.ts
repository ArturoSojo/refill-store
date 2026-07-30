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

/** Todos los secretos que necesita la función `api`. */
export const API_SECRETS = [
  PABILO_API_KEY,
  PABILO_USER_BANK_ID,
  INEFABLE_API_KEY,
  SETUP_TOKEN,
];

// --- Configuración no secreta ----------------------------------------------

const fromEnv = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
};

export const pabiloBaseUrl = () => fromEnv('PABILO_BASE_URL', 'https://api.pabilo.app');

export const inefableBaseUrl = () =>
  fromEnv('INEFABLE_BASE_URL', 'https://inefablerevendedores.co');

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
