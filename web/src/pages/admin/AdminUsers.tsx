import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Ban,
  Bell,
  ChevronLeft,
  Search,
  ShieldCheck,
  Users as UsersIcon,
  Wallet,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  useAdminUsers,
  useAdminUser,
  useSetUserRole,
  useBanUser,
  useAdjustWallet,
  useAdminUserWallet,
  useNotifyUser,
} from '@/hooks/useAdmin';
import { useAuth } from '@/providers/AuthProvider';
import { useDebouncedValue, useDocumentTitle } from '@/hooks/useMisc';
import { Card, CardHeader } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import {
  Badge,
  EmptyState,
  ErrorState,
  FullPageLoader,
  OrderStatusBadge,
  Skeleton,
} from '@/components/ui/Feedback';
import { LoadMore } from '@/components/common/LoadMore';
import { ROUTES } from '@/lib/constants';
import { TIER_META, formatBs, formatDateTime, formatRelative, formatUsd } from '@/lib/format';
import { shortOrderItem } from '@/lib/orderItem';
import { errorMessage, initials } from '@/lib/utils';

export function AdminUsers() {
  useDocumentTitle('Panel · Usuarios');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const debounced = useDebouncedValue(search, 400);

  const users = useAdminUsers({
    search: debounced.trim() || undefined,
    role: role || undefined,
    limit: 50,
  });

  const list = users.items;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Usuarios</h1>
        <p className="text-sm text-slate-400">
          {users.total !== null ? `${users.total} usuario(s)` : `${list.length} usuario(s)`}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr,200px]">
        <Input
          placeholder="Buscar por correo, nombre o código de referido…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          leftIcon={<Search className="h-4 w-4" aria-hidden />}
        />
        <Select
          value={role}
          onChange={(event) => setRole(event.target.value)}
          placeholder="Todos los roles"
          options={[
            { value: 'user', label: 'Clientes' },
            { value: 'staff', label: 'Staff' },
            { value: 'admin', label: 'Administradores' },
          ]}
        />
      </div>

      {users.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<UsersIcon className="h-7 w-7" aria-hidden />}
          title="Sin usuarios"
          description="No encontramos usuarios con esos criterios."
        />
      ) : (
        <Card className="p-0">
          {list.map((profile) => (
            <Link
              key={profile.uid}
              to={ROUTES.adminUser(profile.uid)}
              className="flex items-center gap-3 border-b border-base-700 px-4 py-3 transition last:border-b-0 hover:bg-base-700/40"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-base-700 text-xs font-bold text-white">
                {profile.photoURL ? (
                  <img
                    src={profile.photoURL}
                    alt=""
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  initials(profile.displayName)
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-white">
                    {profile.displayName ?? 'Sin nombre'}
                  </span>
                  {profile.role !== 'user' && (
                    <Badge variant="brand">
                      {profile.role === 'admin' ? 'Admin' : 'Staff'}
                    </Badge>
                  )}
                  {profile.banned && <Badge variant="danger">Bloqueado</Badge>}
                </div>
                <p className="truncate text-xs text-slate-400">{profile.email}</p>
              </div>

              <div className="shrink-0 text-right">
                <p className="text-sm font-bold tabular text-white">
                  {formatUsd(profile.stats.totalSpentUsd)}
                </p>
                <p className="text-xs text-slate-500">
                  {profile.stats.completedOrders} recarga(s)
                </p>
              </div>
            </Link>
          ))}
        </Card>
      )}

      <LoadMore
        loaded={list.length}
        total={users.total}
        hasMore={users.hasMore}
        loading={users.isLoadingMore}
        onLoadMore={users.loadMore}
        label="usuarios"
      />
    </div>
  );
}

export function AdminUserDetail() {
  const { uid } = useParams<{ uid: string }>();
  const { isAdmin, user: currentUser } = useAuth();
  const { data, isLoading, error } = useAdminUser(uid);
  const wallet = useAdminUserWallet(uid);

  const setRole = useSetUserRole();
  const banUser = useBanUser();
  const adjustWallet = useAdjustWallet();
  const notifyUser = useNotifyUser();

  const [banOpen, setBanOpen] = useState(false);
  const [banReason, setBanReason] = useState('');
  const [walletOpen, setWalletOpen] = useState(false);
  const [delta, setDelta] = useState('');
  const [walletReason, setWalletReason] = useState('');
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [notifyTitle, setNotifyTitle] = useState('');
  const [notifyBody, setNotifyBody] = useState('');

  useDocumentTitle(data ? `Usuario ${data.profile.displayName ?? ''}` : 'Usuario');

  if (isLoading) return <FullPageLoader />;
  if (error || !data) return <ErrorState title="Usuario no encontrado" />;

  const { profile, orders } = data;
  const tier = TIER_META[profile.tier];
  const isSelf = currentUser?.uid === profile.uid;

  return (
    <div className="space-y-4">
      <Link
        to={ROUTES.adminUsers}
        className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-white"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Usuarios
      </Link>

      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-base-700 text-lg font-bold text-white">
            {profile.photoURL ? (
              <img
                src={profile.photoURL}
                alt=""
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              initials(profile.displayName)
            )}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold text-white">
                {profile.displayName ?? 'Sin nombre'}
              </h1>
              <Badge variant="brand">
                {tier.icon} {tier.label}
              </Badge>
              {profile.role !== 'user' && (
                <Badge variant="info">{profile.role === 'admin' ? 'Admin' : 'Staff'}</Badge>
              )}
              {profile.banned && <Badge variant="danger">Bloqueado</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-slate-400">{profile.email}</p>
            <p className="mt-0.5 font-mono text-xs text-slate-500">
              {profile.uid} · {profile.referralCode}
            </p>
            {profile.banned && profile.bannedReason && (
              <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
                Motivo: {profile.bannedReason}
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-base-600 pt-4 sm:grid-cols-4">
          <div>
            <p className="text-xs text-slate-400">Gastado</p>
            <p className="text-lg font-bold tabular text-white">
              {formatUsd(profile.stats.totalSpentUsd)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Recargas</p>
            <p className="text-lg font-bold tabular text-white">{profile.stats.completedOrders}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Saldo</p>
            <p className="text-lg font-bold tabular text-emerald-400">
              {formatUsd(profile.walletBalanceUsd)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Referidos</p>
            <p className="text-lg font-bold tabular text-white">{profile.referralCount}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 border-t border-base-600 pt-4">
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Bell className="h-4 w-4" aria-hidden />}
            onClick={() => setNotifyOpen(true)}
          >
            Notificar
          </Button>

          {isAdmin && (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Wallet className="h-4 w-4" aria-hidden />}
                onClick={() => setWalletOpen(true)}
              >
                Ajustar saldo
              </Button>

              <Select
                value={profile.role}
                onChange={(event) =>
                  setRole.mutate(
                    {
                      uid: profile.uid,
                      role: event.target.value as 'user' | 'staff' | 'admin',
                    },
                    {
                      onSuccess: () =>
                        toast.success('Rol actualizado. El usuario debe volver a entrar.'),
                      onError: (mutationError) => toast.error(errorMessage(mutationError)),
                    }
                  )
                }
                disabled={isSelf || setRole.isPending}
                options={[
                  { value: 'user', label: 'Cliente' },
                  { value: 'staff', label: 'Staff' },
                  { value: 'admin', label: 'Administrador' },
                ]}
                containerClassName="w-44"
                className="py-2"
              />

              {!isSelf && (
                <Button
                  size="sm"
                  variant={profile.banned ? 'success' : 'danger'}
                  leftIcon={
                    profile.banned ? (
                      <ShieldCheck className="h-4 w-4" aria-hidden />
                    ) : (
                      <Ban className="h-4 w-4" aria-hidden />
                    )
                  }
                  onClick={() => {
                    if (profile.banned) {
                      banUser.mutate(
                        { uid: profile.uid, banned: false },
                        { onSuccess: () => toast.success('Usuario desbloqueado.') }
                      );
                    } else {
                      setBanOpen(true);
                    }
                  }}
                >
                  {profile.banned ? 'Desbloquear' : 'Bloquear'}
                </Button>
              )}
            </>
          )}
        </div>
      </Card>

      {/* Movimientos del saldo: sin este libro, un reembolso y un error de
          dedo son indistinguibles cuando el cliente reclama. */}
      <Card>
        <CardHeader
          title="Movimientos de saldo"
          description={`Saldo actual: ${formatUsd(wallet.data?.balanceUsd ?? profile.walletBalanceUsd)}`}
        />
        {wallet.isLoading ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : (wallet.data?.transactions.length ?? 0) === 0 ? (
          <EmptyState title="Sin movimientos" className="py-8" />
        ) : (
          <ul className="divide-y divide-base-700">
            {wallet.data?.transactions.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-white">{item.reason}</p>
                  <p className="text-xs text-slate-500">
                    {formatDateTime(item.createdAt)}
                    {item.orderCode && (
                      <>
                        {' · '}
                        <span className="font-mono">{item.orderCode}</span>
                      </>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={
                      item.type === 'credit'
                        ? 'text-sm font-bold tabular text-emerald-400'
                        : 'text-sm font-bold tabular text-slate-300'
                    }
                  >
                    {item.type === 'credit' ? '+' : '−'}
                    {formatUsd(item.amountUsd)}
                  </p>
                  <p className="text-xs tabular text-slate-500">
                    {formatUsd(item.balanceAfterUsd)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Órdenes recientes" description={`${orders.length} mostradas`} />
        {orders.length === 0 ? (
          <EmptyState title="Sin órdenes" className="py-8" />
        ) : (
          <ul className="space-y-2">
            {orders.map((order) => (
              <li key={order.id}>
                <Link
                  to={ROUTES.adminOrder(order.id)}
                  className="flex items-center justify-between gap-3 rounded-xl bg-base-900/60 px-3 py-2.5 transition hover:bg-base-700/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">{shortOrderItem(order)}</p>
                    <p className="text-xs text-slate-500">
                      <span className="font-mono">{order.code}</span> ·{' '}
                      {formatRelative(order.createdAt)}
                    </p>
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
        )}
      </Card>

      <Card>
        <CardHeader title="Datos de la cuenta" />
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Registrado</dt>
            <dd className="text-white">{formatDateTime(profile.createdAt)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Último acceso</dt>
            <dd className="text-white">{formatDateTime(profile.lastLoginAt)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Teléfono</dt>
            <dd className="text-white">{profile.phone ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-400">Puntos</dt>
            <dd className="tabular text-white">{profile.points}</dd>
          </div>
        </dl>
      </Card>

      <ConfirmDialog
        open={banOpen}
        onClose={() => setBanOpen(false)}
        onConfirm={() =>
          banUser.mutate(
            { uid: profile.uid, banned: true, reason: banReason.trim() || undefined },
            {
              onSuccess: () => {
                toast.success('Usuario bloqueado.');
                setBanOpen(false);
              },
              onError: (mutationError) => toast.error(errorMessage(mutationError)),
            }
          )
        }
        title="Bloquear usuario"
        message={
          <div className="space-y-3">
            <p>
              No podrá iniciar sesión ni crear órdenes. Sus sesiones activas se cierran de
              inmediato.
            </p>
            <Input
              placeholder="Motivo (opcional)"
              value={banReason}
              onChange={(event) => setBanReason(event.target.value)}
            />
          </div>
        }
        confirmLabel="Bloquear"
        destructive
        loading={banUser.isPending}
      />

      <Modal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
        title="Ajustar saldo"
        description={`Saldo actual: ${formatUsd(profile.walletBalanceUsd)}`}
        size="sm"
      >
        <div className="space-y-4">
          <Input
            label="Monto (USD)"
            type="number"
            step="0.01"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            hint="Usa un número negativo para descontar."
          />
          <Input
            label="Motivo"
            value={walletReason}
            onChange={(event) => setWalletReason(event.target.value)}
            placeholder="Ej: compensación por orden fallida"
            required
          />
          <Button
            fullWidth
            loading={adjustWallet.isPending}
            disabled={!delta || walletReason.trim().length < 3}
            onClick={() =>
              adjustWallet.mutate(
                {
                  uid: profile.uid,
                  deltaUsd: Number(delta),
                  reason: walletReason.trim(),
                },
                {
                  onSuccess: () => {
                    toast.success('Saldo actualizado.');
                    setWalletOpen(false);
                    setDelta('');
                    setWalletReason('');
                  },
                  onError: (mutationError) => toast.error(errorMessage(mutationError)),
                }
              )
            }
          >
            Aplicar ajuste
          </Button>
        </div>
      </Modal>

      <Modal
        open={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        title="Enviar notificación"
        size="sm"
      >
        <div className="space-y-4">
          <Input
            label="Título"
            value={notifyTitle}
            onChange={(event) => setNotifyTitle(event.target.value.slice(0, 80))}
          />
          <Textarea
            label="Mensaje"
            value={notifyBody}
            onChange={(event) => setNotifyBody(event.target.value.slice(0, 300))}
            rows={3}
          />
          <Button
            fullWidth
            loading={notifyUser.isPending}
            disabled={notifyTitle.trim().length < 2 || notifyBody.trim().length < 2}
            onClick={() =>
              notifyUser.mutate(
                { uid: profile.uid, title: notifyTitle.trim(), body: notifyBody.trim() },
                {
                  onSuccess: () => {
                    toast.success('Notificación enviada.');
                    setNotifyOpen(false);
                    setNotifyTitle('');
                    setNotifyBody('');
                  },
                  onError: (mutationError) => toast.error(errorMessage(mutationError)),
                }
              )
            }
          >
            Enviar
          </Button>
        </div>
      </Modal>
    </div>
  );
}
