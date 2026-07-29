import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
  /** Borde degradado para destacar la tarjeta principal de una pantalla. */
  gradient?: boolean;
}

export function Card({ hover = false, gradient = false, className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'card p-4 sm:p-5',
        hover && 'card-hover',
        gradient && 'ring-gradient',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, action, icon, className }: CardHeaderProps) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-white">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-slate-400">{description}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  /** Variación porcentual respecto al periodo anterior. */
  trend?: number | null;
  accent?: 'brand' | 'blue' | 'emerald' | 'amber' | 'danger';
  className?: string;
}

const ACCENTS = {
  brand: 'from-neon-red/20 to-transparent text-neon-crimson',
  blue: 'from-neon-blue/25 to-transparent text-neon-ice',
  emerald: 'from-emerald-500/20 to-transparent text-emerald-300',
  amber: 'from-amber-500/20 to-transparent text-amber-300',
  danger: 'from-rose-600/25 to-transparent text-rose-300',
};

export function StatCard({
  label,
  value,
  hint,
  icon,
  trend,
  accent = 'brand',
  className,
}: StatCardProps) {
  return (
    <div className={cn('card relative overflow-hidden p-4', className)}>
      <div
        className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br', ACCENTS[accent])}
        aria-hidden
      />
      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
          {icon && <span className={cn('opacity-80', ACCENTS[accent].split(' ').pop())}>{icon}</span>}
        </div>
        <p className="mt-2 text-2xl font-bold tabular text-white">{value}</p>
        <div className="mt-1 flex items-center gap-2">
          {typeof trend === 'number' && (
            <span
              className={cn(
                'text-xs font-semibold tabular',
                trend > 0 ? 'text-emerald-400' : trend < 0 ? 'text-red-400' : 'text-slate-400'
              )}
            >
              {trend > 0 ? '▲' : trend < 0 ? '▼' : '•'} {Math.abs(trend).toFixed(1)}%
            </span>
          )}
          {hint && <span className="text-xs text-slate-500">{hint}</span>}
        </div>
      </div>
    </div>
  );
}
