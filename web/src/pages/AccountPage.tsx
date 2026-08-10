import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  ChevronRight,
  Gamepad2,
  LogOut,
  Mail,
  Receipt,
  Save,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '@/providers/AuthProvider';
import { useUpdateProfile } from '@/hooks/useAccount';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Switch } from '@/components/ui/Field';
import { FullPageLoader, OrderStatusBadge } from '@/components/ui/Feedback';
import { ROUTES } from '@/lib/constants';
import { TIER_META, formatBs, formatRelative, formatUsd } from '@/lib/format';
import { shortOrderItem } from '@/lib/orderItem';
import { cn, errorMessage, initials } from '@/lib/utils';

function TierCard() {
  const { me } = useAuth();
  if (!me) return null;

  const tier = TIER_META[me.profile.tier];
  const spent = me.profile.stats.totalSpentUsd;

  // Umbrales espejo de `tierForSpend` en el backend.
  const nextThreshold =
    spent < 40 ? 40 : spent < 120 ? 120 : spent < 300 ? 300 : null;
  const progress = nextThreshold ? Math.min(100, (spent / nextThreshold) * 100) : 100;

  return (
    <Card className="relative overflow-hidden">
      <div
        className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br opacity-10', tier.className)}
        aria-hidden
      />
      <div className="relative">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Tu nivel</p>
            <p className="mt-1 flex items-center gap-2 text-lg font-bold text-white">
              <span aria-hidden>{tier.icon}</span>
              {tier.label}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400">Descuento activo</p>
            <p className="text-lg font-bold text-emerald-400">−{me.tierDiscountPercent}%</p>
          </div>
        </div>

        <div className="mt-4">
          <div className="h-2 overflow-hidden rounded-full bg-base-700">
            <div
              className="h-full rounded-full bg-brand-gradient transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-400">
            {nextThreshold
              ? `Llevas ${formatUsd(spent)} de ${formatUsd(nextThreshold)} para el siguiente nivel.`
              : '¡Estás en el nivel máximo! Gracias por comprar con nosotros.'}
          </p>
        </div>
      </div>
    </Card>
  );
}

export function AccountPage() {
  useDocumentTitle('Mi cuenta');
  const { me, profileLoading, signOut, isStaff } = useAuth();
  const updateProfile = useUpdateProfile();

  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifyOrders, setNotifyOrders] = useState(true);

  useEffect(() => {
    if (!me) return;
    setDisplayName(me.profile.displayName ?? '');
    setPhone(me.profile.phone ?? '');
    setNotifyEmail(me.profile.preferences.notifyEmail);
    setNotifyOrders(me.profile.preferences.notifyOrderUpdates);
  }, [me]);

  if (profileLoading || !me) return <FullPageLoader label="Cargando tu cuenta…" />;

  const dirty =
    displayName !== (me.profile.displayName ?? '') ||
    phone !== (me.profile.phone ?? '') ||
    notifyEmail !== me.profile.preferences.notifyEmail ||
    notifyOrders !== me.profile.preferences.notifyOrderUpdates;

  const save = () => {
    updateProfile.mutate(
      {
        displayName: displayName.trim() || undefined,
        phone: phone.trim() || null,
        preferences: { notifyEmail, notifyOrderUpdates: notifyOrders },
      },
      {
        onSuccess: () => toast.success('Perfil actualizado.'),
        onError: (error) => toast.error(errorMessage(error)),
      }
    );
  };

  const shortcuts = [
    { to: ROUTES.orders, label: 'Mis órdenes', icon: Receipt, hint: `${me.profile.stats.totalOrders} en total` },
    { to: ROUTES.playerIds, label: 'IDs de jugador', icon: Gamepad2, hint: 'Accesos rápidos' },
    {
      to: ROUTES.referrals,
      label: 'Referidos',
      icon: Users,
      hint: `${me.profile.referralCount} invitados`,
    },
    {
      to: ROUTES.notifications,
      label: 'Notificaciones',
      icon: Bell,
      hint: me.unreadNotifications > 0 ? `${me.unreadNotifications} sin leer` : 'Al día',
    },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <Card>
        <div className="flex items-center gap-4">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-base-700 text-lg font-bold text-white">
            {me.profile.photoURL ? (
              <img
                src={me.profile.photoURL}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              initials(me.profile.displayName)
            )}
          </span>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-white">
              {me.profile.displayName ?? 'Jugador'}
            </h1>
            <p className="flex items-center gap-1.5 truncate text-sm text-slate-400">
              <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {me.profile.email}
            </p>
            {isStaff && (
              <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-neon-red/30 bg-neon-red/10 px-2 py-0.5 text-[11px] font-semibold text-neon-crimson">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                {me.profile.role === 'admin' ? 'Administrador' : 'Staff'}
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 border-t border-base-600 pt-4 text-center">
          <div>
            <p className="text-lg font-bold tabular text-white">{me.profile.stats.completedOrders}</p>
            <p className="text-xs text-slate-400">Recargas</p>
          </div>
          <div>
            <p className="text-lg font-bold tabular text-white">
              {formatUsd(me.profile.stats.totalSpentUsd)}
            </p>
            <p className="text-xs text-slate-400">Comprado</p>
          </div>
          <div>
            <p className="text-lg font-bold tabular text-white">{me.profile.points}</p>
            <p className="text-xs text-slate-400">Puntos</p>
          </div>
        </div>
      </Card>

      {me.profile.walletBalanceUsd > 0 && (
        <Link to={ROUTES.wallet} className="block">
          <Card className="border-emerald-500/30 bg-emerald-500/5 transition hover:border-emerald-400/50">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
                <Wallet className="h-5 w-5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-emerald-200">Saldo a favor</p>
                <p className="text-lg font-bold text-white">
                  {formatUsd(me.profile.walletBalanceUsd)}
                </p>
                <p className="text-xs text-emerald-300/80">
                  Actívalo al comprar y sólo transfieres la diferencia.
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-emerald-300/70" aria-hidden />
            </div>
          </Card>
        </Link>
      )}

      <TierCard />

      <div className="grid grid-cols-2 gap-3">
        {shortcuts.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="card card-hover flex items-center gap-3 p-4"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neon-red/15 text-neon-red">
              <item.icon className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-white">{item.label}</span>
              <span className="block truncate text-xs text-slate-400">{item.hint}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
          </Link>
        ))}
      </div>

      {me.recentOrders.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Últimas órdenes</h2>
            <Link to={ROUTES.orders} className="text-xs font-semibold text-neon-crimson hover:underline">
              Ver todas
            </Link>
          </div>
          <ul className="space-y-2">
            {me.recentOrders.slice(0, 3).map((order) => (
              <li key={order.id}>
                <Link
                  to={ROUTES.order(order.id)}
                  className="flex items-center justify-between gap-3 rounded-xl bg-base-900/60 px-3 py-2.5 transition hover:bg-base-700/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">{shortOrderItem(order)}</p>
                    <p className="text-xs text-slate-500">{formatRelative(order.createdAt)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs tabular text-slate-400">
                      {formatBs(order.pricing.totalBs)}
                    </span>
                    <OrderStatusBadge status={order.status} showPulse={false} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
          <Sparkles className="h-4 w-4 text-neon-red" aria-hidden />
          Datos y preferencias
        </h2>

        <div className="space-y-4">
          <Input
            label="Nombre para mostrar"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value.slice(0, 60))}
            placeholder="Tu nombre"
          />
          <Input
            label="Teléfono (opcional)"
            value={phone}
            onChange={(event) => setPhone(event.target.value.slice(0, 20))}
            placeholder="0412-0000000"
            hint="Lo usamos sólo si necesitamos contactarte por una orden."
          />

          <div className="space-y-3 border-t border-base-600 pt-4">
            <Switch
              checked={notifyOrders}
              onChange={setNotifyOrders}
              label="Avisos de mis órdenes"
              description="Notificaciones cuando tu recarga se entregue o necesite atención."
            />
            <Switch
              checked={notifyEmail}
              onChange={setNotifyEmail}
              label="Novedades y promociones"
              description="Ofertas y nuevos productos. Sin spam."
            />
          </div>

          <Button
            fullWidth
            disabled={!dirty}
            loading={updateProfile.isPending}
            onClick={save}
            leftIcon={<Save className="h-4 w-4" aria-hidden />}
          >
            Guardar cambios
          </Button>
        </div>
      </Card>

      <Button
        variant="ghost"
        fullWidth
        leftIcon={<LogOut className="h-4 w-4" aria-hidden />}
        onClick={() => void signOut()}
      >
        Cerrar sesión
      </Button>
    </div>
  );
}
