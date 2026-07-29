import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CheckoutStep = 'player' | 'payment' | 'result';

const STEPS: Array<{ id: CheckoutStep; label: string }> = [
  { id: 'player', label: 'Tu ID' },
  { id: 'payment', label: 'Pago' },
  { id: 'result', label: 'Listo' },
];

export function CheckoutStepper({ current }: { current: CheckoutStep }) {
  const currentIndex = STEPS.findIndex((step) => step.id === current);

  return (
    <ol className="flex items-center gap-2" aria-label="Progreso de la compra">
      {STEPS.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;

        return (
          <li key={step.id} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition',
                  done
                    ? 'bg-emerald-500 text-white'
                    : active
                      ? 'bg-brand-gradient text-white shadow-glow'
                      : 'border border-base-500 bg-base-800 text-slate-500'
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : index + 1}
              </span>
              <span
                className={cn(
                  'hidden text-xs font-semibold xs:block',
                  active ? 'text-white' : done ? 'text-emerald-400' : 'text-slate-500'
                )}
              >
                {step.label}
              </span>
            </div>

            {index < STEPS.length - 1 && (
              <span
                className={cn(
                  'h-px flex-1 transition',
                  index < currentIndex ? 'bg-emerald-500/60' : 'bg-base-600'
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
