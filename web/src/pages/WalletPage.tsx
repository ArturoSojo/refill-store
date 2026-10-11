/**
 * Saldo a favor del cliente.
 *
 * Hasta ahora el panel permitía reembolsar «al saldo del usuario», pero ese
 * saldo no se veía en ninguna parte ni servía para pagar: era un número muerto.
 * Aquí se muestra el saldo, de dónde salió cada movimiento y cómo usarlo.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Wallet, Plus } from 'lucide-react';
import { useWallet } from '@/hooks/useAccount';
import { useDocumentTitle } from '@/hooks/useMisc';
import { useConfig } from '@/providers/ConfigProvider';
import { useOrder, useVerifyPayment, useCancelOrder, useSetPaymentMethod, useCreateOrder } from '@/hooks/useOrders';
import { PaymentStep } from '@/features/checkout/PaymentStep';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Field';
import { api } from '@/lib/api';
import { ROUTES } from '@/lib/constants';
import { formatDateTime, formatUsd, formatBs } from '@/lib/format';
import { cn, errorMessage } from '@/lib/utils';
import toast from 'react-hot-toast';

function TopupModal({ open, onClose, initialOrderId }: { open: boolean; onClose: () => void; initialOrderId?: string | null }) {
  const { config } = useConfig();
  const [inputCurrency, setInputCurrency] = useState<'USD' | 'VES'>('USD');
  const [inputValue, setInputValue] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'pagomovil_bdv' | 'transfer' | 'binance_pay'>('pagomovil_bdv');
  const [orderId, setOrderId] = useState<string | null>(initialOrderId ?? null);
  const [error, setError] = useState<string | null>(null);
  const orderQuery = useOrder(orderId ?? undefined);

  const createOrder = useCreateOrder();
  const verifyPayment = useVerifyPayment(orderId ?? undefined);
  const setPaymentMethodMutation = useSetPaymentMethod(orderId ?? undefined);
  const cancelOrder = useCancelOrder();

  // Reset state when modal opens/closes or initialOrderId changes
  useEffect(() => {
    if (open) {
      if (initialOrderId && initialOrderId !== orderId) {
        setOrderId(initialOrderId);
      }
    } else {
      setOrderId(null);
      setError(null);
      setInputValue('');
    }
  }, [open, initialOrderId]);

  // If we have an order loaded and it's awaiting payment, we show the payment step.
  const isPaymentStep = Boolean(orderId && orderQuery.data?.order.status === 'awaiting_payment');

  const parsedInput = parseFloat(inputValue);
  const amountUsd = !isNaN(parsedInput) ? (inputCurrency === 'USD' ? parsedInput : parsedInput / (config?.rate ?? 1)) : 0;
  const amountBs = !isNaN(parsedInput) ? (inputCurrency === 'VES' ? parsedInput : parsedInput * (config?.rate ?? 1)) : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (createOrder.isPending) return;
    setError(null);

    if (amountUsd < 1 || amountUsd > 100) {
      setError('Por favor, ingresa un monto válido de recarga entre $1 y $100.');
      return;
    }

    try {
      const response = await api.post<{ order: { id: string } }>('/orders/topup', {
        amountUsd: Number(amountUsd.toFixed(2)),
        paymentMethod,
      });
      setOrderId(response.order.id);
    } catch (err: any) {
      setError(err.message || 'Ocurrió un error al procesar la recarga.');
    }
  };

  const handleVerify = (reference: string) => {
    verifyPayment.mutate(reference, {
      onSuccess: () => {
        toast.success('Pago verificado. Tu saldo será acreditado en breve.');
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const handleCancel = () => {
    if (!orderId) return;
    cancelOrder.mutate(orderId, {
      onSuccess: () => {
        toast.success('Orden de recarga cancelada.');
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const handleMethodChange = (method: any) => {
    if (orderId) {
      setPaymentMethodMutation.mutate(method);
    } else {
      setPaymentMethod(method);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isPaymentStep ? 'Completar pago' : 'Recargar saldo'}
      description={isPaymentStep ? 'Transfiere el dinero exacto y envía la referencia.' : 'El dinero se sumará a tu cartera y podrás usarlo en tus próximas compras.'}
      dismissable={!createOrder.isPending && !verifyPayment.isPending && !cancelOrder.isPending}
      size={isPaymentStep ? 'lg' : 'md'}
    >
      {isPaymentStep && orderQuery.data ? (
        <div className="-mx-4 -mb-4 sm:mx-0 sm:mb-0">
          <PaymentStep
            data={orderQuery.data as any}
            transferEnabled={config?.transfer?.enabled ?? false}
            binancePayEnabled={config?.binancePay?.enabled ?? false}
            walletEnabled={false}
            walletBalanceUsd={0}
            payingWithWallet={false}
            onPayWithWallet={() => undefined}
            switchingMethod={setPaymentMethodMutation.isPending}
            onMethodChange={handleMethodChange}
            onVerify={handleVerify}
            verifying={verifyPayment.isPending}
            error={error}
            onCancel={handleCancel}
            cancelling={cancelOrder.isPending}
            attemptsLeft={Math.max(0, (config?.checkout.maxVerifyAttempts ?? 5) - (orderQuery.data.order.payment?.attempts ?? 0))}
          />
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-semibold text-white">Monto a recargar</label>
            <div className="flex rounded-xl border border-base-600 bg-base-900 overflow-hidden focus-within:border-neon-red focus-within:ring-1 focus-within:ring-neon-red">
              <div className="flex border-r border-base-600 bg-base-800">
                <button
                  type="button"
                  className={cn('px-3 py-2.5 text-sm font-semibold transition-colors', inputCurrency === 'USD' ? 'text-white' : 'text-slate-400 hover:text-white')}
                  onClick={() => {
                    if (inputCurrency !== 'USD') {
                      setInputCurrency('USD');
                      setInputValue(amountUsd > 0 ? amountUsd.toFixed(2) : '');
                    }
                  }}
                >
                  USD ($)
                </button>
                <button
                  type="button"
                  className={cn('px-3 py-2.5 text-sm font-semibold transition-colors border-l border-base-600', inputCurrency === 'VES' ? 'text-white' : 'text-slate-400 hover:text-white')}
                  onClick={() => {
                    if (inputCurrency !== 'VES') {
                      setInputCurrency('VES');
                      setInputValue(amountBs > 0 ? amountBs.toFixed(2) : '');
                    }
                  }}
                >
                  Bs
                </button>
              </div>
              <input
                type="number"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                min={inputCurrency === 'USD' ? 1 : (config?.rate ?? 1)}
                step="any"
                required
                className="flex-1 bg-transparent px-4 py-2.5 text-sm text-white outline-none placeholder:text-slate-500"
                placeholder={inputCurrency === 'USD' ? 'Ej. 5' : `Ej. ${((config?.rate ?? 1) * 5).toFixed(2)}`}
              />
            </div>
            {amountUsd > 0 && (
              <p className="text-xs text-slate-400">
                {inputCurrency === 'USD' ? (
                  <>Equivale a <strong className="text-white">{formatBs(amountBs)} Bs</strong> a la tasa actual.</>
                ) : (
                  <>Se acreditarán <strong className="text-emerald-400">{formatUsd(amountUsd)}</strong> a tu saldo.</>
                )}
              </p>
            )}
          </div>

          <Select
            label="Método de pago"
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as any)}
            options={[
              { value: 'pagomovil_bdv', label: 'Pago Móvil (Recomendado)' },
              ...(config?.transfer?.enabled ? [{ value: 'transfer', label: 'Transferencia Bancaria' }] : []),
              ...(config?.binancePay?.enabled ? [{ value: 'binance_pay', label: 'Binance Pay' }] : []),
            ]}
            required
          />

          <div className="pt-2">
            <Button type="submit" loading={createOrder.isPending} fullWidth disabled={amountUsd < 1 || amountUsd > 100}>
              Generar orden de recarga
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export function WalletPage() {
  useDocumentTitle('Mi saldo');
  const [searchParams, setSearchParams] = useSearchParams();
  const resumeOrderId = searchParams.get('orden');
  
  const { data, isLoading, error } = useWallet();
  const [topupOpen, setTopupOpen] = useState(Boolean(resumeOrderId));

  useEffect(() => {
    if (resumeOrderId && !topupOpen) {
      setTopupOpen(true);
    }
  }, [resumeOrderId]);

  const handleCloseModal = () => {
    setTopupOpen(false);
    if (resumeOrderId) {
      // Remover param 'orden' de la url de forma limpia
      setSearchParams(new URLSearchParams());
    }
  };

  const balance = data?.balanceUsd ?? 0;
  const transactions = data?.transactions ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <Link
        to={ROUTES.account}
        className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Mi cuenta
      </Link>

      {isLoading ? (
        <Skeleton className="h-32 rounded-2xl" />
      ) : error ? (
        <ErrorState message="No pudimos cargar tu saldo." />
      ) : (
        <>
          <Card className="border-emerald-500/30 bg-emerald-500/5">
            <div className="flex items-center gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
                <Wallet className="h-7 w-7" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-emerald-400">
                  Saldo disponible
                </p>
                <p className="text-3xl font-extrabold tabular text-white">
                  {formatUsd(balance)}
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm text-slate-300">
              Recarga tu saldo una vez y compra después sin esperar verificación de pago.
            </p>

            <Button
              className="mt-4"
              fullWidth
              onClick={() => setTopupOpen(true)}
              disabled={data?.enabled === false}
            >
              <Plus className="mr-2 h-4 w-4" />
              Recargar saldo
            </Button>
            
            {data?.enabled === false && (
              <p className="mt-3 text-center text-xs text-slate-400">
                El pago con saldo está desactivado temporalmente. Escríbenos por soporte.
              </p>
            )}
          </Card>

          <TopupModal open={topupOpen} onClose={handleCloseModal} initialOrderId={resumeOrderId} />

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-white">Movimientos</h2>

            {transactions.length === 0 ? (
              <EmptyState
                icon={<Wallet className="h-7 w-7" aria-hidden />}
                title="Sin movimientos"
                description="Cuando recargues saldo, recibas un reembolso o una recompensa, aparecerá aquí."
              />
            ) : (
              <ul className="divide-y divide-base-700">
                {transactions.map((item) => {
                  const isCredit = item.type === 'credit';

                  return (
                    <li key={item.id} className="flex items-center gap-3 py-3">
                      <span
                        className={
                          isCredit
                            ? 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400'
                            : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-base-700 text-slate-300'
                        }
                      >
                        {isCredit ? (
                          <ArrowDownLeft className="h-4 w-4" aria-hidden />
                        ) : (
                          <ArrowUpRight className="h-4 w-4" aria-hidden />
                        )}
                      </span>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-white">{item.reason}</p>
                        <p className="text-xs text-slate-500">
                          {formatDateTime(item.createdAt)}
                          {item.orderCode && (
                            <>
                              {' · '}
                              <span className="tabular">{item.orderCode}</span>
                            </>
                          )}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        <p
                          className={
                            isCredit
                              ? 'text-sm font-bold tabular text-emerald-400'
                              : 'text-sm font-bold tabular text-slate-300'
                          }
                        >
                          {isCredit ? '+' : '−'}
                          {formatUsd(item.amountUsd)}
                        </p>
                        <p className="text-xs tabular text-slate-500">
                          {formatUsd(item.balanceAfterUsd)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
