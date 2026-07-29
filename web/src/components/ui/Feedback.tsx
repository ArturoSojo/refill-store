/** Estados de carga, vacío y error, más la píldora de estado de una orden. */
import type { ReactNode } from 'react';
import { Loader2, PackageOpen, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { statusMeta } from '@/lib/format';
import type { OrderStatus } from '@/types/models';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-neon-red', className)} aria-hidden />;
}

export function FullPageLoader({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <div className="relative">
        <div className="h-12 w-12 animate-spin-slow rounded-full border-2 border-base-600 border-t-neon-red" />
        <div className="absolute inset-0 animate-pulse-glow rounded-full bg-neon-red/20 blur-xl" />
      </div>
      <p className="text-sm text-slate-400">{label}</p>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-base-700 text-slate-500">
        {icon ?? <PackageOpen className="h-7 w-7" aria-hidden />}
      </div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-slate-400">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  message?: string;
  action?: ReactNode;
}

export function ErrorState({
  title = 'Algo salió mal',
  message = 'No pudimos cargar esta información. Intenta de nuevo.',
  action,
}: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400">
        <AlertTriangle className="h-7 w-7" aria-hidden />
      </div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-slate-400">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Badge({
  children,
  className,
  variant = 'default',
}: {
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'brand';
}) {
  const variants = {
    default: 'bg-base-700 text-slate-300 border-base-500',
    success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    warning: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    danger: 'bg-red-500/15 text-red-300 border-red-500/30',
    info: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    brand: 'bg-neon-red/15 text-neon-crimson border-neon-red/30',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}

export function OrderStatusBadge({
  status,
  className,
  showPulse = true,
}: {
  status: OrderStatus;
  className?: string;
  showPulse?: boolean;
}) {
  const meta = statusMeta(status);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
        meta.className,
        className
      )}
    >
      {showPulse && meta.isLive && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {meta.label}
    </span>
  );
}
