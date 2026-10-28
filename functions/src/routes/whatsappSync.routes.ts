/**
 * Endpoint interno para recibir órdenes sincronizadas en tiempo real desde
 * RefillBot (WhatsApp): `POST /api/orders/sync-whatsapp`.
 *
 * Se monta ANTES de `ordersRouter` en `app.ts` porque `ordersRouter` exige
 * sesión Firebase Auth de cliente (`requireAuth`), mientras que esta ruta se
 * autentica de servidor a servidor mediante el header `x-api-secret`.
 */
import { Router } from 'express';
import { asyncHandler } from '../lib/http';
import { syncWhatsappOrder, verifySyncSecret } from '../services/whatsappSync';

export const whatsappSyncRouter = Router();

whatsappSyncRouter.post(
  '/sync-whatsapp',
  asyncHandler(async (req, res) => {
    await verifySyncSecret(req.header('x-api-secret'));
    const result = await syncWhatsappOrder(req.body);
    res.status(200).json({ ok: true, ...result });
  })
);

