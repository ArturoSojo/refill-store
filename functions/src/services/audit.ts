/** Bitácora de acciones sensibles: quién hizo qué, cuándo y sobre qué. */
import type { Query } from 'firebase-admin/firestore';
import { auditLogs, now } from '../config/firebase';
import { paginate, type Page } from '../lib/pagination';
import { log } from '../lib/logger';
import type { AuditLog } from '../types/models';

export interface AuditInput {
  action: string;
  actorUid?: string | null;
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  data?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * Registra una acción. Nunca lanza: fallar al escribir la bitácora no debe
 * tumbar la operación que se estaba auditando.
 */
export async function record(input: AuditInput): Promise<void> {
  try {
    await auditLogs().add({
      action: input.action,
      actorUid: input.actorUid ?? null,
      actorEmail: input.actorEmail ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      summary: input.summary,
      data: input.data ?? null,
      ip: input.ip ?? null,
      createdAt: now(),
    });
  } catch (error) {
    log.warn('No se pudo escribir en la bitácora', {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function list(options: {
  limit: number;
  cursor?: string;
  action?: string;
  actorUid?: string;
}): Promise<Page<AuditLog>> {
  let query: Query = auditLogs();

  if (options.action) query = query.where('action', '==', options.action);
  if (options.actorUid) query = query.where('actorUid', '==', options.actorUid);

  return paginate(
    query,
    { orderBy: 'createdAt', limit: options.limit, cursor: options.cursor, withTotal: true },
    (id, data) => ({ id, ...data }) as AuditLog
  );
}

/** Nombres estables de acciones, para poder filtrar la bitácora. */
export const ACTIONS = {
  ORDER_CREATED: 'order.created',
  ORDER_PAYMENT_VERIFIED: 'order.payment.verified',
  ORDER_PAYMENT_REJECTED: 'order.payment.rejected',
  ORDER_DISPATCHED: 'order.dispatched',
  ORDER_DISPATCH_FAILED: 'order.dispatch.failed',
  ORDER_RETRIED: 'order.retried',
  ORDER_COMPLETED_MANUALLY: 'order.completed.manual',
  ORDER_REFUNDED: 'order.refunded',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_NOTE_UPDATED: 'order.note.updated',
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_DELETED: 'product.deleted',
  PRODUCTS_REPRICED: 'product.repriced',
  GAME_CREATED: 'game.created',
  GAME_UPDATED: 'game.updated',
  GAME_DELETED: 'game.deleted',
  CONFIG_UPDATED: 'config.updated',
  RATE_UPDATED: 'rate.updated',
  USER_ROLE_CHANGED: 'user.role.changed',
  USER_BANNED: 'user.banned',
  USER_UNBANNED: 'user.unbanned',
  USER_WALLET_ADJUSTED: 'user.wallet.adjusted',
  COUPON_CREATED: 'coupon.created',
  COUPON_UPDATED: 'coupon.updated',
  COUPON_DELETED: 'coupon.deleted',
  CATALOG_SEEDED: 'catalog.seeded',
  SETUP_ADMIN_GRANTED: 'setup.admin.granted',
} as const;
