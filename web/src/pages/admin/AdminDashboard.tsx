import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  DollarSign,
  MessageCircle,
  Receipt,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useAdminOverview, useAdminTopProducts, useProvidersStatus } from '@/hooks/useAdmin';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card, CardHeader, StatCard } from '@/components/ui/Card';
import { Skeleton, EmptyState } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { formatBs, formatUsd, formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

const RANGES = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
];

const PIE_COLORS = ['#F03030', '#5B8CFF', '#F59E0B', '#22C55E', '#A855F7'];

function shortDate(value: string): string {
  const [, month, day] = value.split('-');
  return `${day}/${month}`;
}

/** Tooltip con el estilo oscuro del panel (el de Recharts viene en claro). */
function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  formatter?: (value: number) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl border border-base-500 bg-base-800 px-3 py-2 shadow-xl">
      {label && <p className="mb-1 text-xs font-medium text-slate-400">{label}</p>}
      {payload.map((entry) => (
        <p key={entry.name} className="text-sm font-semibold" style={{ color: entry.color }}>
          {entry.name}: {formatter ? formatter(entry.value) : formatNumber(entry.value)}
        </p>
      ))}
    </div>
  );
}

export function AdminDashboard() {
  useDocumentTitle('Panel · Resumen');
  const [days, setDays] = useState(30);

  const overview = useAdminOverview(days);
  const topProducts = useAdminTopProducts(days);
  const providers = useProvidersStatus();

  if (overview.isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }

  const data = overview.data;
  if (!data) return <EmptyState title="Sin datos" description="No pudimos cargar el resumen." />;

  const { totals, counters, series, trends } = data;

  const chartSeries = series.map((point) => ({
    ...point,
    label: shortDate(point.date),
  }));

  // Reparte por GANANCIA, no por facturación: un juego puede mover mucho dinero
  // y dejar poco. Se descartan los que no dejaron nada para que el gráfico no
  // intente dibujar porciones de cero.
  const gameData = Object.entries(totals.byGame)
    .map(([gameId, value]) => ({
      name: gameId,
      value: Math.round((value.profitUsd ?? 0) * 100) / 100,
    }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value);

  const alerts = [
    counters.failedOrders > 0 && {
      to: `${ROUTES.adminOrders}?status=failed`,
      text: `${counters.failedOrders} orden(es) pagadas con fallo de entrega`,
      tone: 'danger' as const,
      icon: AlertTriangle,
    },
    counters.awaitingManual > 0 && {
      to: `${ROUTES.adminOrders}?status=awaiting_manual`,
      text: `${counters.awaitingManual} producto(s) manuales por gestionar`,
      tone: 'warning' as const,
      icon: MessageCircle,
    },
    data.maintenanceMode && {
      to: ROUTES.adminSettings,
      text: 'La tienda está en modo mantenimiento',
      tone: 'warning' as const,
      icon: AlertTriangle,
    },
    providers.data &&
      !providers.data.pabilo.configured && {
        to: ROUTES.adminSettings,
        text: 'Falta configurar las credenciales de Pabilo (verificación de pagos)',
        tone: 'danger' as const,
        icon: AlertTriangle,
      },
    providers.data &&
      !providers.data.inefable.configured && {
        to: ROUTES.adminSettings,
        text: 'Falta configurar la credencial de Inefable (despacho automático)',
        tone: 'danger' as const,
        icon: AlertTriangle,
      },
  ].filter(Boolean) as Array<{
    to: string;
    text: string;
    tone: 'danger' | 'warning';
    icon: typeof AlertTriangle;
  }>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Resumen</h1>
          <p className="text-sm text-slate-400">
            Tasa actual: <strong className="text-white">{formatBs(data.rate.value)}</strong> ·{' '}
            {data.rate.source === 'auto' ? 'automática' : 'manual'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-base-600 bg-base-800 p-1">
            {RANGES.map((range) => (
              <button
                key={range.days}
                type="button"
                onClick={() => setDays(range.days)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-semibold transition',
                  days === range.days
                    ? 'bg-brand-gradient text-white'
                    : 'text-slate-400 hover:text-white'
                )}
              >
                {range.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void overview.refetch()}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-base-600 bg-base-800 text-slate-400 transition hover:text-white"
            aria-label="Actualizar"
          >
            <RefreshCw className={cn('h-4 w-4', overview.isFetching && 'animate-spin')} aria-hidden />
          </button>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert) => (
            <Link
              key={alert.text}
              to={alert.to}
              className={cn(
                'flex items-center gap-3 rounded-xl border px-4 py-3 text-sm transition',
                alert.tone === 'danger'
                  ? 'border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/15'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/15'
              )}
            >
              <alert.icon className="h-4 w-4 shrink-0" aria-hidden />
              {alert.text}
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Ingresos"
          value={formatUsd(totals.revenueUsd)}
          hint={formatBs(totals.revenueBs)}
          trend={trends.revenue}
          icon={<DollarSign className="h-4 w-4" aria-hidden />}
          accent="emerald"
        />
        <StatCard
          label="Utilidad"
          value={formatUsd(totals.profitUsd)}
          hint={`Costo ${formatUsd(totals.costUsd)}`}
          trend={trends.profit}
          icon={<TrendingUp className="h-4 w-4" aria-hidden />}
          accent="brand"
        />
        <StatCard
          label="Órdenes"
          value={formatNumber(totals.orders)}
          hint={`${totals.completedOrders} completadas · ${totals.conversionRate}%`}
          trend={trends.orders}
          icon={<Receipt className="h-4 w-4" aria-hidden />}
          accent="blue"
        />
        <StatCard
          label="Usuarios"
          value={formatNumber(counters.totalUsers)}
          hint={`+${totals.newUsers} nuevos`}
          icon={<Users className="h-4 w-4" aria-hidden />}
          accent="amber"
        />
      </div>

      <Card>
        <CardHeader
          title="Ingresos y utilidad"
          description={`Últimos ${days} días · ticket promedio ${formatUsd(totals.averageTicketUsd)}`}
        />
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartSeries} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#F03030" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#F03030" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="profitGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5B8CFF" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#5B8CFF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1F1F30" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#64748B"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                minTickGap={20}
              />
              <YAxis stroke="#64748B" fontSize={11} tickLine={false} axisLine={false} width={52} />
              <Tooltip content={<ChartTooltip formatter={formatUsd} />} />
              <Area
                type="monotone"
                dataKey="revenueUsd"
                name="Ingresos"
                stroke="#F03030"
                strokeWidth={2}
                fill="url(#revenueGradient)"
              />
              <Area
                type="monotone"
                dataKey="profitUsd"
                name="Utilidad"
                stroke="#5B8CFF"
                strokeWidth={2}
                fill="url(#profitGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Órdenes por día" description="Completadas frente a fallidas" />
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartSeries} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1F1F30" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="#64748B"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={20}
                />
                <YAxis stroke="#64748B" fontSize={11} tickLine={false} axisLine={false} width={40} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: '#ffffff08' }} />
                <Bar
                  dataKey="completedOrders"
                  name="Completadas"
                  fill="#22C55E"
                  radius={[4, 4, 0, 0]}
                  stackId="a"
                />
                <Bar
                  dataKey="failedOrders"
                  name="Fallidas"
                  fill="#EF4444"
                  radius={[4, 4, 0, 0]}
                  stackId="a"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Ganancia por juego"
            description={`Últimos ${days} días · ya descontado el proveedor`}
          />
          {gameData.length === 0 ? (
            <EmptyState title="Sin ventas todavía" className="py-8" />
          ) : (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={gameData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={3}
                  >
                    {gameData.map((entry, index) => (
                      <Cell key={entry.name} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip formatter={formatUsd} />} />
                  <Legend
                    verticalAlign="bottom"
                    formatter={(value: string) => (
                      <span className="text-xs text-slate-400">{value}</span>
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Productos más vendidos"
          description={`Top por ganancia en ${days} días`}
          action={
            <Link
              to={ROUTES.adminProducts}
              className="text-xs font-semibold text-neon-crimson hover:underline"
            >
              Ver catálogo
            </Link>
          }
        />

        {topProducts.isLoading ? (
          <Skeleton className="h-40 rounded-xl" />
        ) : (topProducts.data?.products.length ?? 0) === 0 ? (
          <EmptyState title="Sin ventas en el periodo" className="py-8" />
        ) : (
          <ul className="space-y-2">
            {topProducts.data!.products.map((product, index) => (
              <li
                key={product.productId}
                className="flex items-center gap-3 rounded-xl bg-base-900/60 px-3 py-2.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neon-red/15 text-xs font-bold text-neon-crimson">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{product.name}</p>
                  {/* Lo que entró y lo que costó, para que el número verde de la
                      derecha no se confunda con la facturación. */}
                  <p className="text-xs text-slate-500">
                    {product.orders} órdenes · vendió {formatUsd(product.revenueUsd)} · costó{' '}
                    {formatUsd(product.costUsd)}
                  </p>
                </div>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold tabular text-emerald-400">
                    {formatUsd(product.profitUsd)}
                  </span>
                  <span className="block text-[11px] text-slate-500">ganancia</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
