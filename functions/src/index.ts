/**
 * Punto de entrada de Cloud Functions v2.
 *
 * Exporta:
 *   - `api`            → la API HTTP completa (Express).
 *   - `expireOrders`   → caduca órdenes impagas y limpia candados.
 *   - `sendWinbackEmails` → invita por correo a quien lleva 5+ días sin recargar.
 *   - `refreshRate`    → refresca la tasa Bs/USD si el auto-refresco está activo.
 *   - `syncCentralOneCatalog` → encola cada hora una sync del catálogo de Central One.
 *   - `runCentralOneSync`     → ejecuta cada sync encolada en `providerSync/{id}`.
 */
import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import {
  API_SECRETS,
  CENTRAL_ONE_API_KEY,
  FAZERCARDS_API_KEY,
  GMAIL_APP_PASSWORD,
  INEFABLE_API_KEY,
  PABILO_API_KEY,
  REGION,
  TELEGRAM_BOT_TOKEN,
} from './config/env';
import { createApp } from './app';
import { db, now, providerSync, Timestamp } from './config/firebase';
import { log } from './lib/logger';
import {
  CENTRAL_ONE_SYNC_STALE_MS,
  enqueueCentralOneSync,
  runCentralOneSync as executeCentralOneSync,
} from './services/centralOneCatalogSync';
import { expireStaleOrders, refundStaleReviewOrders } from './services/orders';
import { refreshAutoRate, alertStaleRate } from './services/rate';
import { resolveProcessingOrders } from './services/dispatch';
import { runWinbackEmails } from './services/winbackEmail';
import { STORE_TIMEZONE } from './services/stats';
import { cleanupRateLimits } from './triggers/maintenance';
import type { ProviderSync, ProviderSyncTrigger } from './types/models';

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
 * Cancela y reembolsa automáticamente las órdenes `in_review` cuyo plazo de
 * revisión manual (1 hora) ya venció.
 */
export const refundReviewOrders = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: STORE_TIMEZONE,
    timeoutSeconds: 120,
    // Antes del reembolso se consulta al proveedor (`checkOrderProviderStatus`).
    // Sin sus llaves esa consulta respondía «no encontrada» y la orden se
    // reembolsaba aunque la recarga sí se hubiera entregado.
    secrets: [
      INEFABLE_API_KEY,
      FAZERCARDS_API_KEY,
      CENTRAL_ONE_API_KEY,
      TELEGRAM_BOT_TOKEN,
      GMAIL_APP_PASSWORD,
    ],
  },
  async () => {
    const refunded = await refundStaleReviewOrders(50);
    if (refunded > 0) {
      log.info('Barrido de órdenes en revisión vencidas completado', { refunded });
    }
  }
);

/**
 * Correo amable de «te extrañamos» para quien lleva 5 días o más sin recargar.
 * Corre una vez al día, a media mañana (hora de la tienda); cada cliente recibe
 * uno solo por periodo de inactividad.
 */
export const sendWinbackEmails = onSchedule(
  {
    schedule: 'every day 11:00',
    timeZone: STORE_TIMEZONE,
    timeoutSeconds: 300,
    secrets: [GMAIL_APP_PASSWORD],
  },
  async () => {
    await runWinbackEmails();
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
    secrets: [
      INEFABLE_API_KEY,
      FAZERCARDS_API_KEY,
      CENTRAL_ONE_API_KEY,
      TELEGRAM_BOT_TOKEN,
      GMAIL_APP_PASSWORD,
    ],
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


/**
 * Encola cada hora una sincronización completa del catálogo de Central One:
 * sus precios y su inventario cambian varias veces al día.
 *
 * No sincroniza aquí: crea `providerSync/{id}` con `status: 'queued'` y
 * `runCentralOneSync` lo ejecuta. Es el mismo camino que usa el panel, así que
 * el historial es igual para los dos orígenes. Si ya hay una en cola o
 * corriendo (y no está muerta), no se apila otra.
 */
export const syncCentralOneCatalog = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: STORE_TIMEZONE,
    timeoutSeconds: 60,
  },
  async () => {
    const activas = await providerSync()
      .where('status', 'in', ['queued', 'running'])
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    const limite = Date.now() - CENTRAL_ONE_SYNC_STALE_MS;
    let enCurso: string | null = null;
    for (const doc of activas.docs) {
      const createdAt = doc.get('createdAt') as Timestamp | undefined;
      const createdMs = createdAt && typeof createdAt.toMillis === 'function' ? createdAt.toMillis() : 0;
      if (createdMs >= limite) {
        enCurso = doc.id;
        continue;
      }
      // Muerta (la función se cayó a mitad): se cierra para que el historial
      // del panel no la muestre «corriendo» para siempre.
      await doc.ref.set(
        {
          status: 'error',
          finishedAt: now(),
          error: 'La sincronización no terminó (más de 15 minutos sin cerrar).',
        },
        { merge: true }
      );
    }
    if (enCurso) {
      log.info('Ya hay una sync de Central One en curso; no se encola otra', { id: enCurso });
      return;
    }

    // La comprobación de arriba sólo limpia y ahorra la transacción: quien
    // decide de verdad es el candado de `enqueueCentralOneSync`, que comparte
    // con el botón del panel.
    const queued = await enqueueCentralOneSync({ trigger: 'schedule', actorUid: null });
    if (!queued.ok) {
      log.info('Ya hay una sync de Central One en curso; no se encola otra', { id: queued.activeId });
      return;
    }
    log.info('Sync de Central One encolada por el cron', { id: queued.id });
  }
);

/**
 * Ejecuta una sync del catálogo de Central One cuando aparece
 * `providerSync/{id}` en estado `queued`.
 *
 * Trigger de Firestore y no petición HTTP porque el catálogo es una sola
 * respuesta de unos 5 MB con miles de ítems: no cabe en los 60 s que Hosting
 * deja vivir una petición. Aquí hay 9 minutos y 1 GiB.
 */
export const runCentralOneSync = onDocumentCreated(
  {
    document: 'providerSync/{id}',
    timeoutSeconds: 540,
    memory: '1GiB',
    // Una sola a la vez: dos syncs simultáneas escribirían los mismos docs.
    // `maxInstances` sólo limita instancias; sin `concurrency: 1` una misma
    // instancia (1 GiB ⇒ 1 CPU ⇒ 80 por defecto) atendería varias a la vez.
    // El candado de `enqueueCentralOneSync` evita encolar dos; esto, que dos
    // encoladas igual corran juntas.
    maxInstances: 1,
    concurrency: 1,
    // TELEGRAM_BOT_TOKEN: la sync avisa al admin si Central One se cae o el
    // catálogo llega sospechoso; sin el secreto montado el aviso se omite.
    secrets: [CENTRAL_ONE_API_KEY, TELEGRAM_BOT_TOKEN],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    // Los triggers se entregan «al menos una vez»: se reclama el doc en una
    // transacción para que una entrega repetida no lance otra sync encima.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(snap.ref);
      const data = fresh.data() as Partial<ProviderSync> | undefined;
      // Sólo se ejecutan los encolados: un doc creado ya `done` (importado a
      // mano, por ejemplo) no dispara nada.
      if (!data || data.status !== 'queued') return null;
      tx.set(snap.ref, { status: 'running', startedAt: now() }, { merge: true });
      return data;
    });
    if (!claimed) return;

    const trigger: ProviderSyncTrigger = claimed.trigger ?? 'schedule';
    log.info('Sync de Central One iniciada', { id: snap.id, trigger });

    try {
      const summary = await executeCentralOneSync({
        trigger,
        actorUid: claimed.actorUid ?? null,
        syncId: snap.id,
      });
      await snap.ref.set(
        {
          // Un freno de seguridad no escribió nada: se marca como error para
          // que el panel lo muestre en rojo con el motivo.
          status: summary.aborted ? 'error' : 'done',
          finishedAt: now(),
          summary,
          error: summary.aborted,
        },
        { merge: true }
      );
      log.info('Sync de Central One terminada', {
        id: snap.id,
        completed: summary.completed,
        aborted: summary.aborted,
        itemsMapped: summary.itemsMapped,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Sync de Central One reventó', { id: snap.id, error: message });
      await snap.ref
        .set({ status: 'error', finishedAt: now(), error: message }, { merge: true })
        .catch(() => undefined);
    }
  }
);
