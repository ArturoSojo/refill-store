/**
 * Creadores de contenido: listado y ficha con su libro de comisiones.
 *
 * El alta se hace desde la ficha del usuario (Usuarios → un usuario), porque es
 * ahí donde el administrador ya está mirando a la persona. Esta sección es para
 * ver cómo van y pagarles.
 */
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Coins, Sparkles, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';
import { useAdminCreators, useAdminCreator, usePayCreator } from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Modal';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback';
import { LoadMore } from '@/components/common/LoadMore';
import { ROUTES } from '@/lib/constants';
import { formatDateTime, formatRelative, formatUsd } from '@/lib/format';
import { cn, errorMessage } from '@/lib/utils';
import type { CommissionStatus } from '@/types/models';

const ESTADO: Record<CommissionStatus, { label: string; className: string }> = {
  pending: { label: 'Por pagar', className: 'text-amber-300' },
  paid: { label: 'Pagada', className: 'text-emerald-400' },
  reverted: { label: 'Anulada', className: 'text-slate-500' },
};

export function AdminCreators() {
  useDocumentTitle('Panel · Creadores');
  const creators = useAdminCreators();

  if (creators.error) return <ErrorState message="No pudimos cargar los creadores." />;

  const list = creators.items;
  const pendingTotal = list.reduce((total, entry) => total + (entry.stats?.pendingUsd ?? 0), 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Creadores</h1>
        <p className="text-sm text-slate-400">
          {creators.total !== null ? `${creators.total} creador(es)` : `${list.length} creador(es)`}
          {pendingTotal > 0 && (
            <>
              {' · '}
              <span className="text-amber-300">{formatUsd(pendingTotal)} por pagar</span>
            </>
          )}
        </p>
      </div>

      <Card className="flex items-start gap-2.5 border-sky-500/25 bg-sky-500/5">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" aria-hidden />
        <p className="text-xs leading-relaxed text-slate-300">
          Para nombrar a alguien creador, entra a{' '}
          <Link to={ROUTES.adminUsers} className="font-semibold text-neon-crimson hover:underline">
            Usuarios
          </Link>
          , abre su ficha y activa «Creador de contenido». Ahí le pones su código y su comisión.
        </p>
      </Card>

      {creators.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<TrendingUp className="h-7 w-7" aria-hidden />}
          title="Todavía no hay creadores"
          description="Nombra al primero desde la ficha de un usuario."
        />
      ) : (
        <Card className="p-0">
          {list.map((creator) => (
            <Link
              key={creator.uid}
              to={ROUTES.adminCreator(creator.uid)}
              className="flex items-center gap-3 border-b border-base-700 px-4 py-3 transition last:border-b-0 hover:bg-base-700/40"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-bold text-neon-crimson">
                    {creator.code}
                  </span>
                  {!creator.active && <Badge variant="danger">Inactivo</Badge>}
                  <Badge variant="info">{creator.commissionPercent}% comisión</Badge>
                </div>
                <p className="truncate text-xs text-slate-400">
                  {creator.displayName ?? creator.email ?? creator.uid}
                </p>
                <p className="text-xs text-slate-500">
                  {creator.stats?.orders ?? 0} recarga(s) ·{' '}
                  {formatUsd(creator.stats?.salesUsd ?? 0)} en ventas
                </p>
              </div>

              <div className="shrink-0 text-right">
                <p
                  className={cn(
                    'text-sm font-bold tabular',
                    (creator.stats?.pendingUsd ?? 0) > 0 ? 'text-amber-300' : 'text-slate-500'
                  )}
                >
                  {formatUsd(creator.stats?.pendingUsd ?? 0)}
                </p>
                <p className="text-xs text-slate-500">por pagar</p>
              </div>
            </Link>
          ))}
        </Card>
      )}

      <LoadMore
        loaded={list.length}
        total={creators.total}
        hasMore={creators.hasMore}
        loading={creators.isLoadingMore}
        onLoadMore={creators.loadMore}
        label="creadores"
      />
    </div>
  );
}

export function AdminCreatorDetail() {
  const { uid } = useParams<{ uid: string }>();
  useDocumentTitle('Panel · Creador');

  const detail = useAdminCreator(uid);
  const pay = usePayCreator(uid ?? '');
  const [confirmPay, setConfirmPay] = useState(false);

  if (detail.isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (detail.error || !detail.data) return <ErrorState message="No pudimos cargar al creador." />;

  const { creator, commissions } = detail.data;
  const pending = creator.stats?.pendingUsd ?? 0;

  return (
    <div className="space-y-4">
      <Link
        to={ROUTES.adminCreators}
        className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Creadores
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg font-black text-neon-crimson">{creator.code}</span>
              {!creator.active && <Badge variant="danger">Inactivo</Badge>}
            </div>
            <p className="mt-0.5 truncate text-sm text-white">
              {creator.displayName ?? 'Sin nombre'}
            </p>
            <p className="truncate text-xs text-slate-400">{creator.email}</p>
            <Link
              to={ROUTES.adminUser(creator.uid)}
              className="mt-1 inline-block text-xs font-semibold text-neon-crimson hover:underline"
            >
              Ver su ficha de usuario
            </Link>
          </div>

          <div className="text-right">
            <p className="text-xs text-slate-400">Comisión</p>
            <p className="text-lg font-bold text-white">{creator.commissionPercent}%</p>
            {creator.discountPercent > 0 && (
              <p className="text-xs text-emerald-300">
                −{creator.discountPercent}% al comprador
              </p>
            )}
          </div>
        </div>

        {creator.notes && (
          <p className="mt-3 rounded-xl bg-base-900/60 px-3 py-2 text-xs text-slate-400">
            {creator.notes}
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Por pagar', value: formatUsd(pending), accent: pending > 0 ? 'text-amber-300' : '' },
          { label: 'Ya pagado', value: formatUsd(creator.stats?.paidUsd ?? 0), accent: '' },
          { label: 'Ventas', value: formatUsd(creator.stats?.salesUsd ?? 0), accent: '' },
          { label: 'Anulado', value: formatUsd(creator.stats?.revertedUsd ?? 0), accent: '' },
        ].map((item) => (
          <Card key={item.label}>
            <p className="text-xs text-slate-400">{item.label}</p>
            <p className={cn('text-lg font-black tabular text-white', item.accent)}>{item.value}</p>
          </Card>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Wallet className="h-4 w-4 text-neon-red" aria-hidden />
              Liquidar comisiones
            </h2>
            <p className="mt-1 max-w-lg text-xs leading-relaxed text-slate-400">
              Acredita lo pendiente como saldo en la cuenta del creador, que puede gastarlo en
              recargas. Queda registrado en su cartera y en la bitácora.
            </p>
          </div>

          <Button
            size="sm"
            disabled={pending <= 0}
            leftIcon={<Coins className="h-4 w-4" aria-hidden />}
            onClick={() => setConfirmPay(true)}
          >
            Pagar {formatUsd(pending)}
          </Button>
        </div>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-white">Libro de comisiones</h2>

        {commissions.length === 0 ? (
          <EmptyState title="Sin comisiones" description="Aún no hay ventas con este código." />
        ) : (
          <Card className="p-0">
            {commissions.map((entry) => {
              const estado = ESTADO[entry.status];

              return (
                <div
                  key={entry.orderId}
                  className="flex items-center justify-between gap-3 border-b border-base-700 px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      to={ROUTES.adminOrder(entry.orderId)}
                      className="font-mono text-xs font-semibold text-neon-crimson hover:underline"
                    >
                      {entry.orderCode}
                    </Link>
                    <p className="truncate text-sm text-white">{entry.productName}</p>
                    <p className="truncate text-xs text-slate-500">
                      {entry.gameName} · {formatDateTime(entry.createdAt)} ·{' '}
                      {formatRelative(entry.createdAt)}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-xs tabular text-slate-500">
                      {formatUsd(entry.saleUsd)} × {entry.percent}%
                    </p>
                    <p
                      className={cn(
                        'text-sm font-bold tabular',
                        entry.status === 'reverted'
                          ? 'text-slate-600 line-through'
                          : 'text-emerald-400'
                      )}
                    >
                      {formatUsd(entry.amountUsd)}
                    </p>
                    <p className={cn('text-xs', estado.className)}>{estado.label}</p>
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirmPay}
        onClose={() => setConfirmPay(false)}
        onConfirm={() => {
          pay.mutate(undefined, {
            onSuccess: (result) => {
              toast.success(
                `Pagadas ${result.entries} comisión(es) por ${formatUsd(result.amountUsd)}.`
              );
              if (result.hasMore) {
                toast('Quedaron más comisiones pendientes: vuelve a pagar para liquidarlas.');
              }
              setConfirmPay(false);
            },
            onError: (error) => toast.error(errorMessage(error)),
          });
        }}
        title="Liquidar comisiones"
        message={`Se acreditarán ${formatUsd(pending)} al saldo de ${
          creator.displayName ?? creator.code
        }. Esta acción no se puede deshacer desde el panel.`}
        confirmLabel="Sí, pagar"
        cancelLabel="Volver"
        loading={pay.isPending}
      />
    </div>
  );
}
