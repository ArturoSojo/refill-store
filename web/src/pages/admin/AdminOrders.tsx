import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Search, SlidersHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAdminOrders, useAdminOrderSearch, useAdminGames } from '@/hooks/useAdmin';
import { useDebouncedValue, useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { EmptyState, OrderStatusBadge, Skeleton } from '@/components/ui/Feedback';
import { ROUTES, ORDER_STATUS_OPTIONS } from '@/lib/constants';
import { formatBs, formatDateTime, formatUsd } from '@/lib/format';
import { downloadFile } from '@/lib/api';
import { errorMessage } from '@/lib/utils';
import type { Order } from '@/types/models';

function OrderRow({ order }: { order: Order }) {
  return (
    <Link
      to={ROUTES.adminOrder(order.id)}
      className="block border-b border-base-700 px-4 py-3 transition last:border-b-0 hover:bg-base-700/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-neon-crimson">{order.code}</span>
            <OrderStatusBadge status={order.status} />
            {order.fulfillment === 'manual' && (
              <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-semibold text-green-300">
                MANUAL
              </span>
            )}
          </div>

          <p className="mt-1 truncate text-sm text-white">{order.productName}</p>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {order.user.email ?? 'Sin correo'} · ID <span className="tabular">{order.playerId}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">{formatDateTime(order.createdAt)}</p>
        </div>

        <div className="shrink-0 text-right">
          <p className="text-sm font-bold tabular text-white">{formatBs(order.pricing.totalBs)}</p>
          <p className="text-xs tabular text-slate-500">{formatUsd(order.pricing.totalUsd)}</p>
          {order.pricing.profitUsd !== undefined && (
            <p className="text-xs tabular text-emerald-400">
              +{formatUsd(order.pricing.profitUsd)}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}

export function AdminOrders() {
  useDocumentTitle('Panel · Órdenes');
  const [searchParams, setSearchParams] = useSearchParams();

  const [term, setTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const debouncedTerm = useDebouncedValue(term, 400);

  const status = searchParams.get('status') ?? '';
  const gameId = searchParams.get('gameId') ?? '';
  const fulfillment = (searchParams.get('fulfillment') ?? '') as '' | 'auto' | 'manual';

  const games = useAdminGames();
  const orders = useAdminOrders({
    status: status || undefined,
    gameId: gameId || undefined,
    fulfillment: fulfillment || undefined,
    limit: 50,
  });
  const search = useAdminOrderSearch(debouncedTerm);

  const searching = debouncedTerm.trim().length >= 3;
  const list = searching ? (search.data?.orders ?? []) : (orders.data?.orders ?? []);
  const loading = searching ? search.isLoading : orders.isLoading;

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const exportCsv = async () => {
    try {
      await downloadFile('/admin/orders/export/csv?limit=1000', 'ordenes-refill-store.csv');
      toast.success('Exportación lista.');
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Órdenes</h1>
          <p className="text-sm text-slate-400">
            {searching
              ? `${list.length} resultado(s) para "${debouncedTerm}"`
              : `${list.length} orden(es) cargadas`}
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<SlidersHorizontal className="h-4 w-4" aria-hidden />}
            onClick={() => setShowFilters((current) => !current)}
          >
            Filtros
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Download className="h-4 w-4" aria-hidden />}
            onClick={() => void exportCsv()}
          >
            CSV
          </Button>
        </div>
      </div>

      <Input
        placeholder="Buscar por código, ID de jugador o referencia…"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        leftIcon={<Search className="h-4 w-4" aria-hidden />}
        hint="Escribe al menos 3 caracteres"
      />

      {showFilters && (
        <Card className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Estado"
            value={status}
            onChange={(event) => setFilter('status', event.target.value)}
            placeholder="Todos"
            options={ORDER_STATUS_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
          <Select
            label="Juego"
            value={gameId}
            onChange={(event) => setFilter('gameId', event.target.value)}
            placeholder="Todos"
            options={(games.data?.games ?? []).map((game) => ({
              value: game.id,
              label: game.name,
            }))}
          />
          <Select
            label="Modalidad"
            value={fulfillment}
            onChange={(event) => setFilter('fulfillment', event.target.value)}
            placeholder="Todas"
            options={[
              { value: 'auto', label: 'Automática' },
              { value: 'manual', label: 'Manual (WhatsApp)' },
            ]}
          />
        </Card>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          title="Sin órdenes"
          description={
            searching
              ? 'No encontramos nada con ese criterio.'
              : 'Todavía no hay órdenes con esos filtros.'
          }
        />
      ) : (
        <Card className="p-0">
          {list.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </Card>
      )}
    </div>
  );
}
