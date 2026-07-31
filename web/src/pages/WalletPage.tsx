/**
 * Saldo a favor del cliente.
 *
 * Hasta ahora el panel permitía reembolsar «al saldo del usuario», pero ese
 * saldo no se veía en ninguna parte ni servía para pagar: era un número muerto.
 * Aquí se muestra el saldo, de dónde salió cada movimiento y cómo usarlo.
 */
import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, Wallet } from 'lucide-react';
import { useWallet } from '@/hooks/useAccount';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { formatDateTime, formatUsd } from '@/lib/format';

export function WalletPage() {
  useDocumentTitle('Mi saldo');
  const { data, isLoading, error } = useWallet();

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
                <p className="text-xs font-medium uppercase tracking-wide text-emerald-300">
                  Saldo disponible
                </p>
                <p className="text-3xl font-extrabold tabular text-white">
                  {formatUsd(balance)}
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm text-slate-300">
              {data?.enabled === false
                ? 'El pago con saldo está desactivado temporalmente. Escríbenos por soporte para usarlo.'
                : balance > 0
                  ? 'Actívalo al comprar: se descuenta del total y sólo transfieres la diferencia.'
                  : 'Aquí se acumulan tus reembolsos y las recompensas por referidos.'}
            </p>

            {balance > 0 && data?.enabled !== false && (
              <ButtonLink className="mt-4" to={ROUTES.home} fullWidth>
                Usarlo en una recarga
              </ButtonLink>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold text-white">Movimientos</h2>

            {transactions.length === 0 ? (
              <EmptyState
                icon={<Wallet className="h-7 w-7" aria-hidden />}
                title="Sin movimientos"
                description="Cuando recibas un reembolso o una recompensa aparecerá aquí."
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
