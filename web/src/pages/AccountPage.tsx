import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  Camera,
  ChevronDown,
  ChevronRight,
  Gamepad2,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Receipt,
  Save,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Coins,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';
import { updateProfile as updateAuthProfile, updatePassword } from 'firebase/auth';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { auth, db, storage } from '@/lib/firebase';
import { useAuth, authErrorMessage } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { useUpdateProfile } from '@/hooks/useAccount';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Switch } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { FullPageLoader, OrderStatusBadge } from '@/components/ui/Feedback';
import { QUERY_KEYS, ROUTES } from '@/lib/constants';
import { TIER_META, formatBs, formatRelative, formatUsd, formatRefillCoins } from '@/lib/format';
import { shortOrderItem } from '@/lib/orderItem';
import { cn, errorMessage, initials } from '@/lib/utils';
import type { MeResponse } from '@/types/models';

const AVATAR_MAX_SIDE = 512;

async function shrinkAvatar(file: File): Promise<{ blob: Blob; ext: string }> {
  const defaultExt = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, AVATAR_MAX_SIDE / Math.max(bitmap.width, bitmap.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob: file, ext: defaultExt };

    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.88)
    );

    if (blob && blob.size < file.size) {
      return { blob, ext: 'webp' };
    }
  } catch {
    // Si falla el procesamiento en canvas, continúa con el archivo original
  }
  return { blob: file, ext: defaultExt };
}

function TierCard() {
  const { me } = useAuth();
  const { config } = useConfig();
  const [showLadder, setShowLadder] = useState(false);
  if (!me) return null;

  const tier = TIER_META[me.profile.tier];
  const spent = me.profile.stats.totalSpentUsd;

  // La escalera viene del backend: aquí no se repite ningún umbral.
  const ladder = config?.tiers ?? [];
  const currentIndex = ladder.findIndex((entry) => entry.tier === me.profile.tier);
  const next = currentIndex >= 0 ? ladder[currentIndex + 1] : undefined;

  // El progreso se mide dentro del tramo actual, no desde cero: si no, alguien
  // que ya gastó $900 vería la barra casi llena en cada nivel que sube.
  const floor = currentIndex >= 0 ? ladder[currentIndex].minSpentUsd : 0;
  const progress = next
    ? Math.min(100, Math.max(0, ((spent - floor) / (next.minSpentUsd - floor)) * 100))
    : 100;

  return (
    <Card id="mi-nivel" className="relative scroll-mt-24 overflow-hidden transition-all duration-500">
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
            {next
              ? `Llevas ${formatUsd(spent)} comprados. Con ${formatUsd(
                  next.minSpentUsd - spent
                )} más llegas a ${next.label} y tu descuento sube a −${next.discountPercent}%.`
              : '¡Estás en el nivel máximo! Gracias por comprar con nosotros.'}
          </p>
        </div>

        {ladder.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowLadder((current) => !current)}
              className="mt-3 flex items-center gap-1 text-xs font-semibold text-neon-crimson hover:underline"
            >
              {showLadder ? 'Ocultar los niveles' : 'Ver todos los niveles'}
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', showLadder && 'rotate-180')}
                aria-hidden
              />
            </button>

            {showLadder && (
              <ul className="mt-3 space-y-1.5 border-t border-base-600 pt-3">
                {ladder.map((entry) => {
                  const meta = TIER_META[entry.tier];
                  const reached = spent >= entry.minSpentUsd;
                  const isCurrent = entry.tier === me.profile.tier;

                  return (
                    <li
                      key={entry.tier}
                      className={cn(
                        'flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs',
                        isCurrent ? 'bg-base-700/70' : 'opacity-70'
                      )}
                    >
                      <span className="shrink-0 text-base" aria-hidden>
                        {meta.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-white">
                          {meta.label}
                          {isCurrent && (
                            <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-neon-crimson">
                              Tu nivel
                            </span>
                          )}
                        </span>
                        <span className="block text-slate-400">{entry.profile}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span
                          className={cn(
                            'block font-bold tabular',
                            entry.discountPercent > 0 ? 'text-emerald-400' : 'text-slate-500'
                          )}
                        >
                          {entry.discountPercent > 0 ? `−${entry.discountPercent}%` : 'Sin descuento'}
                        </span>
                        <span className="block tabular text-slate-500">
                          {reached ? 'Alcanzado' : `Desde ${formatUsd(entry.minSpentUsd)}`}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

export function AccountPage() {
  useDocumentTitle('Mi cuenta');
  const { me, user, profileLoading, signOut, isStaff, refreshProfile } = useAuth();
  const updateProfile = useUpdateProfile();
  const queryClient = useQueryClient();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);

  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifyOrders, setNotifyOrders] = useState(true);

  const providers = user?.providerData.map((p) => p.providerId) ?? [];
  const hasPasswordProvider = providers.includes('password');
  const hasGoogleProvider = providers.includes('google.com');
  const isGoogleOnly = hasGoogleProvider && !hasPasswordProvider;

  useEffect(() => {
    if (!me) return;
    setDisplayName(me.profile.displayName ?? '');
    setPhone(me.profile.phone ?? '');
    setNotifyEmail(me.profile.preferences.notifyEmail);
    setNotifyOrders(me.profile.preferences.notifyOrderUpdates);
  }, [me]);

  const handleAvatarFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;

    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      toast.error('Formato no permitido. Solo se aceptan imágenes JPG, PNG o WebP.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const maxBytes = 2 * 1024 * 1024; // 2MB
    if (file.size > maxBytes) {
      toast.error('La imagen no debe superar los 2 MB.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setAvatarUploading(true);
    const toastId = toast.loading('Subiendo foto de perfil…');

    try {
      const { blob, ext } = await shrinkAvatar(file);
      const filename = `profile_${Date.now()}.${ext}`;
      const destination = storageRef(storage, `avatars/${user.uid}/${filename}`);

      await uploadBytes(destination, blob, {
        contentType: blob.type,
        cacheControl: 'public, max-age=31536000',
      });

      const photoURL = await getDownloadURL(destination);

      // 1. Actualizar perfil en Firebase Auth
      if (auth.currentUser) {
        await updateAuthProfile(auth.currentUser, { photoURL });
      }

      // 2. Actualizar campo photoURL en Firestore
      await updateDoc(doc(db, 'users', user.uid), {
        photoURL,
        updatedAt: serverTimestamp(),
      });

      // 3. Actualizar la caché de React Query al instante
      queryClient.setQueryData<MeResponse>(QUERY_KEYS.me, (old) => {
        if (!old) return old;
        return {
          ...old,
          profile: {
            ...old.profile,
            photoURL,
          },
        };
      });

      // 4. Refrescar el estado global del perfil
      await refreshProfile();

      toast.success('Foto de perfil actualizada.', { id: toastId });
    } catch (error) {
      toast.error(errorMessage(error, 'No se pudo subir la foto de perfil.'), { id: toastId });
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleChangePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordError('');

    if (newPassword.trim().length < 6) {
      setPasswordError('La nueva contraseña debe tener al menos 6 caracteres.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('Las contraseñas no coinciden.');
      return;
    }

    if (!auth.currentUser) {
      toast.error('No se detectó una sesión activa.');
      return;
    }

    setChangingPassword(true);
    const toastId = toast.loading('Actualizando contraseña…');

    try {
      await updatePassword(auth.currentUser, newPassword);
      toast.success('Contraseña actualizada correctamente', { id: toastId });
      setPasswordModalOpen(false);
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === 'auth/requires-recent-login') {
        const msg =
          'Por seguridad, esta acción requiere un inicio de sesión reciente. Cierra sesión e ingresa de nuevo para cambiar tu contraseña.';
        setPasswordError(msg);
        toast.error(msg, { id: toastId, duration: 6000 });
      } else {
        const msg = authErrorMessage(error);
        setPasswordError(msg);
        toast.error(msg, { id: toastId });
      }
    } finally {
      setChangingPassword(false);
    }
  };

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
    ...(me.isCreator
      ? [
          {
            to: ROUTES.creator,
            label: 'Panel de creador',
            icon: TrendingUp,
            hint: 'Tus comisiones',
          },
        ]
      : []),
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
          <div
            role="button"
            tabIndex={0}
            onClick={() => !avatarUploading && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !avatarUploading) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className="group relative flex h-16 w-16 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-2xl bg-base-700 text-lg font-bold text-white ring-2 ring-transparent transition hover:ring-neon-red/60 focus:outline-none focus:ring-neon-red"
            title="Cambiar foto de perfil"
            aria-label="Cambiar foto de perfil"
          >
            {me.profile.photoURL ? (
              <img
                src={me.profile.photoURL}
                alt={me.profile.displayName ?? ''}
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              initials(me.profile.displayName)
            )}

            {/* Overlay sutil para hover o tap */}
            <div
              className={cn(
                'absolute inset-0 flex flex-col items-center justify-center bg-black/65 text-white backdrop-blur-[2px] transition-opacity duration-150',
                avatarUploading ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
              )}
            >
              {avatarUploading ? (
                <Loader2 className="h-5 w-5 animate-spin text-neon-crimson" />
              ) : (
                <>
                  <Camera className="h-5 w-5" aria-hidden />
                  <span className="mt-0.5 text-[9px] font-semibold tracking-wide">Cambiar</span>
                </>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              disabled={avatarUploading}
              onChange={handleAvatarFileSelect}
            />
          </div>

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

      <Link to={ROUTES.wallet} className="block">
        <Card
          id="refillcoins"
          className="scroll-mt-24 border-amber-500/30 bg-amber-500/5 transition-all duration-500 hover:border-amber-400/50"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
              <Coins className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-amber-300">RefillCoins disponibles</p>
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-200">1 USD = 1 RC</span>
              </div>
              <p className="text-lg font-extrabold text-white">
                {formatRefillCoins(me.profile.walletBalanceUsd)}
              </p>
              <p className="text-xs text-amber-300/80">
                Úsalas al comprar para pagar al instante sin esperar verificación.
              </p>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-amber-300/70" aria-hidden />
          </div>
        </Card>
      </Link>

      <TierCard />

      <div
        id="accesos-rapidos"
        className="grid scroll-mt-24 grid-cols-2 gap-3 rounded-2xl transition-all duration-500"
      >
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
        <Card id="ultimas-ordenes" className="scroll-mt-24 transition-all duration-500">
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

      <Card id="datos-preferencias" className="scroll-mt-24 transition-all duration-500">
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
            ref={phoneInputRef}
            containerId="telefono"
            containerClassName="-mx-2.5 scroll-mt-24 rounded-2xl px-2.5 py-2 transition-all duration-500"
            label="Teléfono (opcional)"
            value={phone}
            onChange={(event) => setPhone(event.target.value.slice(0, 20))}
            placeholder="0412-0000000"
            hint="Puedes usarlo para iniciar sesión o recuperar tu cuenta sin usar SMS."
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

      <Card id="seguridad" className="scroll-mt-24 transition-all duration-500">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
          <KeyRound className="h-4 w-4 text-neon-red" aria-hidden />
          Seguridad
        </h2>

        {isGoogleOnly ? (
          <div className="flex items-center gap-3 rounded-xl border border-base-600 bg-base-900/60 p-3.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <ShieldCheck className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white">Tu cuenta está vinculada con Google</p>
              <p className="text-xs text-slate-400">
                La autenticación se realiza de forma segura a través de tu cuenta de Google.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-base-600 bg-base-900/60 p-3.5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-white">Contraseña de acceso</p>
              <p className="text-xs text-slate-400">
                Actualiza tu clave periódicamente para mantener tu cuenta protegida.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<Lock className="h-4 w-4" aria-hidden />}
              onClick={() => {
                setPasswordModalOpen(true);
                setNewPassword('');
                setConfirmPassword('');
                setPasswordError('');
              }}
            >
              Cambiar contraseña
            </Button>
          </div>
        )}
      </Card>

      <Modal
        open={passwordModalOpen}
        onClose={() => {
          if (!changingPassword) {
            setPasswordModalOpen(false);
            setNewPassword('');
            setConfirmPassword('');
            setPasswordError('');
          }
        }}
        title="Cambiar contraseña"
        description="Ingresa una nueva contraseña para tu cuenta (mínimo 6 caracteres)."
        size="sm"
        dismissable={!changingPassword}
      >
        <form onSubmit={handleChangePassword} className="space-y-4">
          <Input
            label="Nueva contraseña"
            type="password"
            value={newPassword}
            onChange={(e) => {
              setNewPassword(e.target.value);
              setPasswordError('');
            }}
            placeholder="Mínimo 6 caracteres"
            autoComplete="new-password"
            leftIcon={<Lock className="h-4 w-4" aria-hidden />}
            disabled={changingPassword}
            required
            autoFocus
          />

          <Input
            label="Confirmar nueva contraseña"
            type="password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              setPasswordError('');
            }}
            placeholder="Repite la contraseña"
            autoComplete="new-password"
            leftIcon={<ShieldCheck className="h-4 w-4" aria-hidden />}
            disabled={changingPassword}
            required
          />

          {passwordError && (
            <p role="alert" className="text-sm text-red-400">
              {passwordError}
            </p>
          )}

          <div className="mt-6 flex justify-end gap-3 border-t border-base-600 pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={changingPassword}
              onClick={() => setPasswordModalOpen(false)}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              loading={changingPassword}
              disabled={!newPassword || !confirmPassword || changingPassword}
            >
              Guardar contraseña
            </Button>
          </div>
        </form>
      </Modal>

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
