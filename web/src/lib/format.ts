/** Formateo de fechas, montos y estados para la interfaz (es-VE). */
import type { OrderStatus, TimestampLike, UserTier } from '@/types/models';

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

/**
 * Normaliza cualquiera de las formas en que llega una fecha (JSON del Admin SDK,
 * Timestamp del SDK web, milisegundos o ISO) a milisegundos.
 */
export function toMillis(value: TimestampLike): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object') {
    if ('toMillis' in value && typeof value.toMillis === 'function') return value.toMillis();
    if ('_seconds' in value) return value._seconds * 1000 + Math.floor(value._nanoseconds / 1e6);
    if ('seconds' in value) return value.seconds * 1000 + Math.floor(value.nanoseconds / 1e6);
  }
  return null;
}

export function toDate(value: TimestampLike): Date | null {
  const millis = toMillis(value);
  return millis === null ? null : new Date(millis);
}

const dateTimeFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Caracas',
});

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

const timeFormatter = new Intl.DateTimeFormat('es-VE', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Caracas',
});

export function formatDateTime(value: TimestampLike): string {
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '—';
}

export function formatDate(value: TimestampLike): string {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : '—';
}

export function formatTime(value: TimestampLike): string {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : '—';
}

/** "hace 5 min", "hace 2 h", "ayer"… */
export function formatRelative(value: TimestampLike): string {
  const millis = toMillis(value);
  if (millis === null) return '—';

  const diffSeconds = Math.round((millis - Date.now()) / 1000);
  const absolute = Math.abs(diffSeconds);

  const formatter = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

  if (absolute < 60) return formatter.format(Math.round(diffSeconds), 'second');
  if (absolute < 3600) return formatter.format(Math.round(diffSeconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(diffSeconds / 3600), 'hour');
  if (absolute < 2_592_000) return formatter.format(Math.round(diffSeconds / 86_400), 'day');
  return formatDate(value);
}

/** mm:ss restantes hasta `value`. Devuelve `null` si ya pasó. */
export function countdown(value: TimestampLike): string | null {
  const millis = toMillis(value);
  if (millis === null) return null;

  const remaining = millis - Date.now();
  if (remaining <= 0) return null;

  const totalSeconds = Math.floor(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Montos
// ---------------------------------------------------------------------------

const bsFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat('es-VE', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatUsd(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '$0,00';
  return `$${bsFormatter.format(value)}`;
}

export function formatBs(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '0,00 Bs';
  return `${bsFormatter.format(value)} Bs`;
}

export function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '0';
  return new Intl.NumberFormat('es-VE').format(value);
}

export function formatCompact(value: number): string {
  return compactFormatter.format(value);
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value >= 0 ? '' : ''}${value.toFixed(decimals)}%`;
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

export interface StatusMeta {
  label: string;
  /** Clases de Tailwind para la píldora de estado. */
  className: string;
  /** Texto que explica al cliente qué está pasando. */
  description: string;
  /** El estado sigue cambiando solo: conviene escuchar en tiempo real. */
  isLive: boolean;
}

export const ORDER_STATUS_META: Record<OrderStatus, StatusMeta> = {
  awaiting_payment: {
    label: 'Esperando pago',
    className: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    description: 'Realiza el Pago Móvil y envía el número de referencia.',
    isLive: false,
  },
  verifying: {
    label: 'Verificando',
    className: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    description: 'Estamos confirmando tu pago con el banco. Toma unos segundos.',
    isLive: true,
  },
  payment_rejected: {
    label: 'Pago rechazado',
    className: 'bg-red-500/15 text-red-300 border-red-500/30',
    description: 'No pudimos validar ese pago. Revisa la referencia e intenta otra vez.',
    isLive: false,
  },
  paid: {
    label: 'Pagado',
    className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    description: 'Pago confirmado. Preparando la entrega.',
    isLive: true,
  },
  dispatching: {
    // Índigo y no el rojo de la marca: en la escala de estados el rojo lo tiene
    // «pago rechazado», y un «enviando recarga» en rojo se lee como un fallo.
    label: 'Enviando recarga',
    className: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    description: 'Enviando la recarga a tu cuenta del juego.',
    isLive: true,
  },
  awaiting_manual: {
    label: 'Continúa por WhatsApp',
    className: 'bg-green-500/15 text-green-300 border-green-500/30',
    description: 'Pago verificado. Abre WhatsApp para que un asesor complete tu producto.',
    isLive: false,
  },
  completed: {
    label: 'Completado',
    className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    description: '¡Listo! La recarga ya está en tu cuenta.',
    isLive: false,
  },
  failed: {
    label: 'En revisión',
    className: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
    description: 'Tu pago está confirmado. Hubo un problema al entregar y ya lo estamos resolviendo.',
    isLive: true,
  },
  refunded: {
    label: 'Reembolsado',
    className: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    description: 'Esta orden fue reembolsada.',
    isLive: false,
  },
  cancelled: {
    label: 'Cancelada',
    className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    description: 'Cancelaste esta orden.',
    isLive: false,
  },
  expired: {
    label: 'Expirada',
    className: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
    description: 'Pasó el tiempo para pagar. Crea una nueva orden.',
    isLive: false,
  },
};

export function statusMeta(status: OrderStatus): StatusMeta {
  return ORDER_STATUS_META[status] ?? ORDER_STATUS_META.awaiting_payment;
}

export const TIER_META: Record<UserTier, { label: string; className: string; icon: string }> = {
  // Los niveles son medallas: llevan color de metal o gema, no el de la marca.
  hierro: {
    label: 'Hierro',
    className: 'from-slate-600 to-slate-400',
    icon: '⚙️',
  },
  bronce: {
    label: 'Bronce',
    className: 'from-amber-700 to-amber-500',
    icon: '🥉',
  },
  plata: {
    label: 'Plata',
    className: 'from-slate-400 to-slate-200',
    icon: '🥈',
  },
  oro: {
    label: 'Oro',
    className: 'from-yellow-500 to-amber-300',
    icon: '🥇',
  },
  platino: {
    label: 'Platino',
    className: 'from-cyan-200 to-slate-100',
    icon: '🏅',
  },
  esmeralda: {
    label: 'Esmeralda',
    className: 'from-emerald-500 to-green-300',
    icon: '🟩',
  },
  rubi: {
    label: 'Rubí',
    className: 'from-rose-600 to-red-400',
    icon: '🟥',
  },
  diamante: {
    label: 'Diamante',
    className: 'from-sky-300 to-indigo-400',
    icon: '💎',
  },
};

/** Etiqueta legible para las acciones de la bitácora. */
export function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'order.created': 'Orden creada',
    'order.payment.verified': 'Pago verificado',
    'order.payment.rejected': 'Pago rechazado',
    'order.dispatched': 'Recarga despachada',
    'order.dispatch.failed': 'Fallo de despacho',
    'order.retried': 'Reintento de despacho',
    'order.completed.manual': 'Completada manualmente',
    'order.refunded': 'Reembolso',
    'order.cancelled': 'Cancelación',
    'order.note.updated': 'Nota interna',
    'product.created': 'Producto creado',
    'product.updated': 'Producto actualizado',
    'product.deleted': 'Producto eliminado',
    'product.repriced': 'Precios recalculados',
    'game.created': 'Juego creado',
    'game.updated': 'Juego actualizado',
    'game.deleted': 'Juego eliminado',
    'tiers.updated': 'Niveles actualizados',
    'creator.updated': 'Creador actualizado',
    'creator.disabled': 'Creador desactivado',
    'creator.paid': 'Comisiones pagadas',
    'config.updated': 'Configuración',
    'rate.updated': 'Tasa actualizada',
    'user.role.changed': 'Cambio de rol',
    'user.banned': 'Usuario bloqueado',
    'user.unbanned': 'Usuario desbloqueado',
    'user.wallet.adjusted': 'Ajuste de saldo',
    'coupon.created': 'Cupón creado',
    'coupon.updated': 'Cupón actualizado',
    'coupon.deleted': 'Cupón eliminado',
    'catalog.seeded': 'Catálogo sembrado',
    'setup.admin.granted': 'Admin asignado',
  };
  return labels[action] ?? action;
}
