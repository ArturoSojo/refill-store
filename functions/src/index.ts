/**
 * Punto de entrada de Cloud Functions v2.
 *
 * Exporta:
 *   - `api`            → la API HTTP completa (Express).
 *   - `expireOrders`   → caduca órdenes impagas y limpia candados.
 *   - `refreshRate`    → refresca la tasa Bs/USD si el auto-refresco está activo.
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  API_SECRETS,
  GMAIL_APP_PASSWORD,
  INEFABLE_API_KEY,
  PABILO_API_KEY,
  REGION,
  TELEGRAM_BOT_TOKEN,
} from './config/env';
import { createApp } from './app';
import { log } from './lib/logger';
import { expireStaleOrders } from './services/orders';
import { refreshAutoRate, alertStaleRate } from './services/rate';
import { resolveProcessingOrders } from './services/dispatch';
import { STORE_TIMEZONE } from './services/stats';
import { cleanupRateLimits } from './triggers/maintenance';

setGlobalOptions({
  region: REGION,
  maxInstances: 10,
  memory: '512MiB',
  timeoutSeconds: 120,
});

/** API HTTP. Hosting la publica en `/api/**`. */
export const api = onRequest(
  {
    secrets: API_SECRETS,
    // El despacho de un combo encadena varias llamadas al proveedor: hay que
    // darle margen para no cortar una entrega a medias.
    timeoutSeconds: 180,
    // Mantener una instancia caliente evita el arranque en frío justo cuando
    // el cliente está esperando la confirmación de su pago.
    minInstances: 0,
    concurrency: 40,
  },
  createApp()
);

/** Caduca órdenes sin pagar y limpia contadores de rate limit. */
export const expireOrders = onSchedule(
  {
    // Cada 5 minutos: con 15, una orden de 30 minutos podía seguir viva casi 45
    // y ocupar cupo del tope de órdenes abiertas del cliente.
    schedule: 'every 5 minutes',
    timeZone: STORE_TIMEZONE,
    timeoutSeconds: 120,
  },
  async () => {
    const expired = await expireStaleOrders();
    const cleaned = await cleanupRateLimits();
    log.info('Mantenimiento periódico completado', { expired, cleaned });
  }
);

/**
 * Red de seguridad de las recargas que el proveedor dejó en curso.
 *
 * El camino normal es su webhook, que avisa en cuanto cierra la recarga. Esto
 * sólo cubre el aviso que se pierda (un despliegue a medias, un corte de red)
 * y el caso de que se atasque demasiado.
 */
export const resolveDispatches = onSchedule(
  {
    schedule: 'every 2 minutes',
    timeZone: STORE_TIMEZONE,
    timeoutSeconds: 300,
    // Los secretos se montan por función: sin declararlos aquí, la consulta al
    // proveedor saldría sin clave y el correo de entrega no se enviaría.
    secrets: [INEFABLE_API_KEY, TELEGRAM_BOT_TOKEN, GMAIL_APP_PASSWORD],
  },
  async () => {
    const resultado = await resolveProcessingOrders();
    if (resultado.revisadas > 0) log.info('Recargas en curso revisadas', { ...resultado });
  }
);

/** Refresca la tasa Bs/USD cada hora si el panel lo tiene activado. */
export const refreshRate = onSchedule(
  {
    schedule: '0 * * * *',
    timeZone: STORE_TIMEZONE,
    timeoutSeconds: 60,
    // Sin declararlos aquí, `PABILO_API_KEY.value()` llega vacío en esta
    // función —los secretos se montan por función, no por proyecto— y la
    // consulta de tasa caería siempre a la fuente de respaldo sin decir nada.
    secrets: [PABILO_API_KEY, TELEGRAM_BOT_TOKEN],
  },
  async () => {
    const result = await refreshAutoRate();
    log.info('Refresco de tasa', { ...result });

    // Un fallo suelto no merece aviso (la fuente puede tardar un minuto), pero
    // llevar horas sin poder actualizar sí: es lo que pasó con la fuente
    // anterior, que murió y nadie se enteró porque sólo quedaba en los
    // registros mientras el panel mostraba el auto-refresco activo.
    if (!result.updated && result.reason.includes('Ninguna fuente')) {
      await alertStaleRate(result.reason);
    }
  }
);
