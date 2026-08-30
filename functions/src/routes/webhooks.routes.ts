/**
 * Avisos que nos manda el proveedor cuando cambia el estado de una orden.
 *
 * Sustituye a esperar: antes se consultaba cada dos minutos si una recarga
 * aceptada (HTTP 202) ya había terminado. Con esto el proveedor avisa en
 * cuanto la cierra.
 *
 * Dos decisiones de seguridad, porque esta ruta es pública y mueve dinero:
 *
 *  1. **El aviso es sólo un disparador.** Nunca se cree lo que dice el cuerpo:
 *     se le vuelve a preguntar al proveedor por su API autenticada cuál es el
 *     estado real. Así, aunque alguien falsificara un aviso, lo único que
 *     conseguiría es que consultemos. No puede marcar una recarga como
 *     entregada.
 *  2. **Se valida la firma igualmente.** `X-Webhook-Signature` es un
 *     HMAC-SHA256 en hexadecimal del cuerpo crudo. Si el secreto está
 *     configurado y la firma no cuadra, se descarta sin mirar nada más.
 *
 * La ruta lleva además un fragmento aleatorio para que un escáner que dé con
 * el dominio no nos haga trabajar.
 */
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { INEFABLE_WEBHOOK_SECRET, INEFABLE_WEBHOOK_TOKEN } from '../config/env';
import { asyncHandler } from '../lib/http';
import { log } from '../lib/logger';
import { resolveProcessingOrder } from '../services/dispatch';

export const webhooksRouter = Router();

/** Compara sin filtrar el tiempo de respuesta, que delataría la firma correcta. */
function equals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** El secreto del proveedor sólo se ve una vez; hasta entonces hay un marcador. */
const PLACEHOLDERS = ['', 'PENDIENTE', 'CAMBIAME', 'TODO'];

function signatureIsValid(rawBody: Buffer | undefined, header: string | undefined): boolean {
  const secret = INEFABLE_WEBHOOK_SECRET.value().trim();

  // Sin secreto configurado no se puede validar. No se rechaza: el aviso sólo
  // dispara una consulta autenticada, así que sigue siendo seguro. Queda el
  // registro para no olvidar que falta configurarlo.
  if (PLACEHOLDERS.includes(secret.toUpperCase())) {
    log.warn('Webhook de Inefable sin secreto de firma configurado');
    return true;
  }
  if (!rawBody || !header) return false;

  const esperada = createHmac('sha256', secret).update(rawBody).digest('hex');
  // Algunos proveedores prefijan el algoritmo; se admite por si lo cambian.
  const recibida = header.trim().replace(/^sha256=/i, '').toLowerCase();

  return equals(esperada, recibida);
}

interface InefableWebhookBody {
  event?: string;
  event_type?: string;
  order?: {
    id?: number | string;
    status?: string;
    external_order_id?: string;
    error?: string;
  };
}

webhooksRouter.post(
  '/inefable/:token',
  asyncHandler(async (req, res) => {
    // Siempre 200, y cuanto antes: si el proveedor recibe un error o tarda,
    // reintenta, y un aviso repetido no aporta nada. Lo que haya que arreglar
    // se ve en los registros, no devolviéndole un fallo a él.
    const responder = (resultado: string) => res.status(200).json({ ok: true, resultado });

    const token = INEFABLE_WEBHOOK_TOKEN.value();
    if (token && req.params.token !== token) {
      log.warn('Webhook de Inefable con token inválido');
      return responder('token inválido');
    }

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const firma = req.header('X-Webhook-Signature') ?? undefined;
    if (!signatureIsValid(rawBody, firma)) {
      log.warn('Webhook de Inefable con firma inválida');
      return responder('firma inválida');
    }

    const body = (req.body ?? {}) as InefableWebhookBody;
    const externalOrderId = body.order?.external_order_id?.trim();

    log.info('Webhook de Inefable recibido', {
      event: body.event_type ?? body.event ?? null,
      externalOrderId: externalOrderId ?? null,
      providerStatus: body.order?.status ?? null,
      providerOrderId: body.order?.id ?? null,
    });

    if (!externalOrderId) return responder('sin external_order_id');

    // Aquí NO se usa el estado del cuerpo: se resuelve preguntándole al
    // proveedor, que es lo que hace que un aviso falsificado sea inofensivo.
    const resultado = await resolveProcessingOrder(externalOrderId);
    return responder(resultado);
  })
);
