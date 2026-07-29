/**
 * Aplicación Express que expone toda la API de Refill Store.
 *
 * Se monta en Cloud Functions como una única función `api`, y Firebase Hosting
 * reescribe `/api/**` hacia ella (ver `firebase.json`). Así el frontend habla
 * con el mismo origen y no hay problemas de CORS en producción.
 */
import express from 'express';
import cors from 'cors';
import { parseAllowedOrigins } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { optionalAuth } from './middleware/auth';
import { publicRouter } from './routes/public.routes';
import { ordersRouter } from './routes/orders.routes';
import { meRouter } from './routes/me.routes';
import { adminRouter } from './routes/admin.routes';
import { setupRouter } from './routes/setup.routes';

export function createApp() {
  const app = express();

  // Cloud Functions y Hosting van delante: hace falta para leer la IP real.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(
    cors({
      origin(origin, callback) {
        // Sin origen = petición del propio servidor o de una herramienta CLI.
        if (!origin) return callback(null, true);

        const allowed = parseAllowedOrigins();
        // En despliegues de vista previa de Hosting el subdominio cambia en
        // cada release, así que se admite el patrón del proyecto.
        const isFirebasePreview = /^https:\/\/[\w-]+--[\w-]+\.web\.app$/.test(origin);

        if (allowed.includes(origin) || isFirebasePreview) return callback(null, true);
        return callback(new Error(`Origen no permitido: ${origin}`));
      },
      credentials: false,
      maxAge: 3600,
    })
  );

  app.use(express.json({ limit: '256kb' }));

  // Adjunta el usuario si viene token; las rutas privadas lo exigen aparte.
  app.use(optionalAuth);

  // Hosting reescribe `/api/**`, pero al invocar la función directamente la ruta
  // llega sin ese prefijo. Se montan ambas variantes para que ambos casos
  // funcionen igual (y para que los emuladores sean cómodos).
  const mount = (path: string, router: express.Router) => {
    app.use(path, router);
    app.use(`/api${path}`, router);
  };

  mount('/', publicRouter);
  mount('/orders', ordersRouter);
  mount('/me', meRouter);
  mount('/admin', adminRouter);
  mount('/setup', setupRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
