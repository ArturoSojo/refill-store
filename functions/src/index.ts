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
import { API_SECRETS, REGION } from './config/env';
import { createApp } from './app';
import { log } from './lib/logger';
import { expireStaleOrders } from './services/orders';
import { refreshAutoRate } from './services/rate';
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

/** Refresca la tasa Bs/USD cada hora si el panel lo tiene activado. */
export const refreshRate = onSchedule(
  {
    schedule: '0 * * * *',
    timeZone: STORE_TIMEZONE,
    timeoutSeconds: 60,
  },
  async () => {
    const result = await refreshAutoRate();
    log.info('Refresco de tasa', { ...result });
  }
);
