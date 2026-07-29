/**
 * Barra fija de resumen y compra.
 *
 * Vive pegada al borde inferior mientras el cliente elige. Se muestra sólo
 * cuando ya hay un paquete seleccionado, así no roba espacio en la primera
 * pantalla, que es la más importante en móvil.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Loader2, Minus, Plus } from 'lucide-react';
import { formatBs, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PublicProduct } from '@/types/models';

interface PurchaseBarProps {
  product: PublicProduct | null;
  quantity: number;
  onQuantityChange: (quantity: number) => void;
  /** Total ya calculado por el servidor (con cupón y nivel). */
  totalBs: number | null;
  totalUsd: number | null;
  discountUsd: number;
  onContinue: () => void;
  loading: boolean;
  disabled: boolean;
  disabledReason?: string;
}

const MAX_QUANTITY = 10;

export function PurchaseBar({
  product,
  quantity,
  onQuantityChange,
  totalBs,
  totalUsd,
  discountUsd,
  onContinue,
  loading,
  disabled,
  disabledReason,
}: PurchaseBarProps) {
  const fallbackBs = product ? product.priceBs * quantity : 0;
  const fallbackUsd = product ? product.priceUsd * quantity : 0;

  return (
    <AnimatePresence>
      {product && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-40 border-t border-base-600 bg-base-900/95 backdrop-blur-lg"
        >
          {/* pb extra en móvil para no quedar debajo de la navegación inferior */}
          <div className="safe-bottom mx-auto max-w-3xl px-4 pb-[76px] pt-3 md:pb-3">
            {/* En móvil el importe va en su propia fila: un total de cinco
                cifras en bolívares no cabe junto al selector y el botón. */}
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
              <div className="min-w-0">
                <p className="truncate text-xs text-slate-400">{product.name}</p>
                <div className="flex items-baseline gap-2">
                  <p className="whitespace-nowrap text-xl font-extrabold leading-tight tabular text-white">
                    {formatBs(totalBs ?? fallbackBs)}
                  </p>
                  <p className="flex items-center gap-1.5 whitespace-nowrap text-[11px] tabular text-slate-500">
                    {formatUsd(totalUsd ?? fallbackUsd)}
                    {discountUsd > 0 && (
                      <span className="font-semibold text-emerald-400">
                        −{formatUsd(discountUsd)}
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <div className="flex items-center gap-1 rounded-xl border border-base-600 bg-base-800 p-1">
                  <button
                    type="button"
                    onClick={() => onQuantityChange(Math.max(1, quantity - 1))}
                    disabled={quantity <= 1}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 transition hover:bg-base-700 disabled:opacity-30"
                    aria-label="Quitar una unidad"
                  >
                    <Minus className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <span className="w-6 text-center text-sm font-bold tabular text-white">
                    {quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => onQuantityChange(Math.min(MAX_QUANTITY, quantity + 1))}
                    disabled={quantity >= MAX_QUANTITY}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-300 transition hover:bg-base-700 disabled:opacity-30"
                    aria-label="Añadir una unidad"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={onContinue}
                  disabled={disabled || loading}
                  title={disabled ? disabledReason : undefined}
                  className={cn(
                    'inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl px-5 text-sm font-bold text-white transition sm:flex-none',
                    'bg-brand-gradient shadow-glow active:scale-[0.98]',
                    'disabled:opacity-40 disabled:shadow-none'
                  )}
                >
                  {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <>
                      Continuar
                      <ArrowRight className="h-4 w-4" aria-hidden />
                    </>
                  )}
                </button>
              </div>
            </div>

            {disabled && disabledReason && (
              <p className="mt-2 text-center text-[11px] text-amber-400">{disabledReason}</p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
