import type { ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCopy } from '@/hooks/useMisc';

interface CopyFieldProps {
  label: string;
  value: string;
  /** Texto mostrado si difiere del valor que se copia (p. ej. monto formateado). */
  display?: ReactNode;
  copyKey?: string;
  className?: string;
  emphasis?: boolean;
}

/**
 * Fila "etiqueta + valor + copiar".
 *
 * En la pantalla de pago es la pieza más usada: el cliente debe copiar cédula,
 * teléfono y monto exacto para pegarlos en la app del banco. Por eso el área
 * táctil es toda la fila, no sólo el ícono.
 */
export function CopyField({
  label,
  value,
  display,
  copyKey,
  className,
  emphasis = false,
}: CopyFieldProps) {
  const { copy, isCopied } = useCopy();
  const key = copyKey ?? label;

  return (
    <button
      type="button"
      onClick={() => void copy(value, key)}
      className={cn(
        'group flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition',
        emphasis
          ? 'border-neon-red/40 bg-neon-red/10 hover:border-neon-red/70'
          : 'border-base-600 bg-base-900/60 hover:border-base-500 hover:bg-base-700/60',
        className
      )}
      aria-label={`Copiar ${label}`}
    >
      <span className="min-w-0">
        <span className="block text-xs font-medium uppercase tracking-wide text-slate-400">
          {label}
        </span>
        <span
          className={cn(
            'mt-0.5 block truncate font-semibold tabular',
            emphasis ? 'text-lg text-white' : 'text-base text-slate-100'
          )}
        >
          {display ?? value}
        </span>
      </span>

      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition',
          isCopied(key)
            ? 'bg-emerald-500/20 text-emerald-400'
            : 'bg-base-700 text-slate-400 group-hover:bg-base-600 group-hover:text-white'
        )}
      >
        {isCopied(key) ? (
          <Check className="h-4 w-4" aria-hidden />
        ) : (
          <Copy className="h-4 w-4" aria-hidden />
        )}
      </span>
    </button>
  );
}
