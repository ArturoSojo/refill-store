/** Cascarón de la tienda: cabecera, contenido, navegación inferior y pie. */
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Bell,
  Gamepad2,
  Home,
  LayoutDashboard,
  LogOut,
  Receipt,
  ShieldCheck,
  User as UserIcon,
  X,
  Menu,
  LifeBuoy,
  Coins,
  Users,
  ChevronRight,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { BrandMark, BrandLockup } from '@/components/common/Brand';
import { ROUTES } from '@/lib/constants';
import { cn, initials, isImageUrl } from '@/lib/utils';
import { captureCreatorCodeFromUrl } from '@/lib/creatorCode';
import { StoreModals } from '@/components/common/StoreModals';
import { RefillChatbot } from '@/features/chatbot';
import { formatBs, formatRefillCoins } from '@/lib/format';
import { Button, ButtonLink } from '@/components/ui/Button';
import type { StoreNotice } from '@/types/models';
import { resolveNavigationTarget, useSmartStoreNavigate } from '@/lib/scrollTargets';

function Logo() {
  return (
    <Link to={ROUTES.home} className="flex items-center gap-2.5" aria-label="Refill Store">
      <BrandMark size={36} />
      <span className="font-display text-lg font-bold leading-none text-white">
        Refill<span className="gradient-text">Store</span>
      </span>
    </Link>
  );
}

function RateChip() {
  const { config } = useConfig();
  if (!config) return null;

  return (
    <span className="hidden items-center gap-1.5 rounded-full border border-base-600 bg-base-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 sm:inline-flex">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      Tasa {formatBs(config.rate)}
    </span>
  );
}

function Header({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { user, me, isStaff } = useAuth();

  return (
    <header className="sticky top-0 z-40 border-b border-base-600/70 bg-base-900/85 backdrop-blur-lg">
      <div className="safe-top mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4">
        <Logo />

        <div className="flex items-center gap-2">
          <RateChip />

          {user ? (
            <>
              <Link
                to={ROUTES.notifications}
                className="relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 transition hover:bg-base-700 hover:text-white"
                aria-label="Notificaciones"
              >
                <Bell className="h-5 w-5" aria-hidden />
                {(me?.unreadNotifications ?? 0) > 0 && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-neon-red px-1 text-[10px] font-bold text-white">
                    {me!.unreadNotifications > 9 ? '9+' : me!.unreadNotifications}
                  </span>
                )}
              </Link>

              {isStaff && (
                <Link
                  to={ROUTES.admin}
                  className="hidden h-9 items-center gap-1.5 rounded-xl border border-neon-red/40 bg-neon-red/10 px-3 text-xs font-semibold text-neon-crimson transition hover:bg-neon-red/20 sm:flex"
                >
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                  Panel
                </Link>
              )}

              <button
                type="button"
                onClick={onOpenMenu}
                className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl border border-base-500 bg-base-700 text-xs font-bold text-white"
                aria-label="Abrir menú de cuenta"
              >
                {me?.profile.photoURL ? (
                  <img
                    src={me.profile.photoURL}
                    alt=""
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  initials(me?.profile.displayName ?? user.displayName)
                )}
              </button>
            </>
          ) : (
            <>
              <ButtonLink to={ROUTES.login} size="sm" variant="primary">
                Entrar
              </ButtonLink>
              <button
                type="button"
                onClick={onOpenMenu}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 transition hover:bg-base-700 sm:hidden"
                aria-label="Abrir menú"
              >
                <Menu className="h-5 w-5" aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function GooglePlayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 466 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        fill="#EA4335"
        d="M199.9 237.8 1.4 470.17c7.22 24.57 30.16 41.81 55.8 41.81 11.16 0 20.93-2.79 29.3-8.37l244.16-139.46L199.9 237.8z"
      />
      <path
        fill="#FBBC04"
        d="m433.91 205.1-104.65-60-111.61 110.22 113.01 108.83 104.64-58.6c18.14-9.77 30.7-29.3 30.7-50.23-1.4-20.93-13.95-40.46-32.09-50.22z"
      />
      <path
        fill="#34A853"
        d="M199.42 273.45 329.27 145.1 87.9 8.37C79.53 2.79 68.36 0 57.2 0 30.7 0 6.98 18.14 1.4 41.86l198.02 231.59z"
      />
      <path
        fill="#4285F4"
        d="M1.39 41.86C0 46.04 0 51.63 0 57.2v397.64c0 5.57 0 9.76 1.4 15.34l216.27-214.86L1.39 41.86z"
      />
    </svg>
  );
}

function CategoryNav() {
  const links = [
    { to: ROUTES.family('topup'), label: 'Juegos' },
    { to: ROUTES.family('gift_card'), label: 'Gift cards' },
    { to: ROUTES.family('game_key'), label: 'Game key' },
  ];

  return (
    <nav
      className="sticky top-14 z-30 border-b border-base-600/60 bg-base-900/90 px-4 py-2 backdrop-blur-lg"
      aria-label="Catálogo"
    >
      <div className="mx-auto flex max-w-6xl items-center gap-2 overflow-x-auto no-scrollbar">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => cn(
              'shrink-0 rounded-full border px-4 py-1.5 text-xs font-bold transition',
              isActive
                ? 'border-neon-red bg-neon-red/15 text-white'
                : 'border-base-600 bg-base-800/70 text-slate-300 hover:border-neon-red/50 hover:text-white'
            )}
          >
            {link.label}
          </NavLink>
        ))}

        <a
          href="https://play.google.com/store/apps/details?id=com.refillstore.app"
          target="_blank"
          rel="noopener noreferrer"
          title="Descargar app oficial en Google Play"
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-base-600 bg-base-800/70 px-4 py-1.5 text-xs font-bold text-slate-300 transition hover:border-neon-red/50 hover:bg-base-800 hover:text-white sm:ml-auto"
        >
          <GooglePlayIcon className="h-3.5 w-3.5 shrink-0" />
          <span>Descargar App</span>
        </a>
      </div>
    </nav>
  );
}

function AccountDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, me, isStaff, signOut } = useAuth();
  const { config } = useConfig();

  if (!open) return null;

  const links = [
    { to: ROUTES.account, label: 'Mi cuenta', icon: UserIcon },
    { to: ROUTES.orders, label: 'Mis órdenes', icon: Receipt },
    { to: ROUTES.wallet, label: 'RefillCoins', icon: Coins },
    { to: ROUTES.playerIds, label: 'Mis cuentas guardadas', icon: Gamepad2 },
    { to: ROUTES.referrals, label: 'Referidos', icon: Users },
    { to: ROUTES.support, label: 'Soporte', icon: LifeBuoy },
  ];

  return (
    <div className="fixed inset-0 z-50 sm:justify-end">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <aside className="absolute right-0 top-0 flex h-full w-full max-w-xs flex-col border-l border-base-600 bg-base-800 shadow-2xl animate-slide-up">
        <div className="flex items-center justify-between border-b border-base-600 px-4 py-4">
          <span className="text-sm font-semibold text-white">Menú</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-base-700 hover:text-white"
            aria-label="Cerrar menú"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {user && me && (
          <div className="border-b border-base-600 px-4 py-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-base-700 text-sm font-bold text-white">
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
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">
                  {me.profile.displayName ?? 'Jugador'}
                </p>
                <p className="truncate text-xs text-slate-400">{me.profile.email}</p>
              </div>
            </div>

            {me.profile.walletBalanceUsd > 0 && (
              <div className="mt-3 flex items-center justify-between rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <span className="flex items-center gap-1.5 font-medium">
                  <Coins className="h-3.5 w-3.5 text-amber-400" />
                  RefillCoins:
                </span>
                <strong className="font-bold text-amber-200">{formatRefillCoins(me.profile.walletBalanceUsd)}</strong>
              </div>
            )}
          </div>
        )}

        <nav className="flex-1 overflow-y-auto p-3">
          {user ? (
            <ul className="space-y-1">
              {links.map((link) => (
                <li key={link.to}>
                  <NavLink
                    to={link.to}
                    onClick={onClose}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                        isActive
                          ? 'bg-neon-red/15 text-neon-crimson'
                          : 'text-slate-300 hover:bg-base-700 hover:text-white'
                      )
                    }
                  >
                    <link.icon className="h-5 w-5" aria-hidden />
                    {link.label}
                  </NavLink>
                </li>
              ))}

              {isStaff && (
                <li>
                  <NavLink
                    to={ROUTES.admin}
                    onClick={onClose}
                    className="flex items-center gap-3 rounded-xl border border-neon-red/30 bg-neon-red/10 px-3 py-2.5 text-sm font-semibold text-neon-crimson"
                  >
                    <LayoutDashboard className="h-5 w-5" aria-hidden />
                    Panel de administración
                  </NavLink>
                </li>
              )}
            </ul>
          ) : (
            <div className="space-y-3 px-1 py-4">
              <p className="text-sm text-slate-400">
                Inicia sesión con Google para comprar, ver tu historial y guardar tus IDs.
              </p>
              <ButtonLink to={ROUTES.login} fullWidth onClick={onClose}>
                Iniciar sesión
              </ButtonLink>
            </div>
          )}
        </nav>

        <div className="safe-bottom space-y-2 border-t border-base-600 p-3">
          {config?.supportUrl && (
            <ButtonLink
              to={config.supportUrl}
              external
              variant="whatsapp"
              size="sm"
              fullWidth
              leftIcon={<LifeBuoy className="h-4 w-4" aria-hidden />}
            >
              Escríbenos por WhatsApp
            </ButtonLink>
          )}
          {user && (
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              leftIcon={<LogOut className="h-4 w-4" aria-hidden />}
              onClick={() => {
                onClose();
                void signOut();
              }}
            >
              Cerrar sesión
            </Button>
          )}
        </div>
      </aside>
    </div>
  );
}

const BOTTOM_LINKS = [
  { to: ROUTES.home, label: 'Inicio', icon: Home, end: true },
  { to: ROUTES.orders, label: 'Órdenes', icon: Receipt, end: false },
  { to: ROUTES.support, label: 'Soporte', icon: LifeBuoy, end: false },
  { to: ROUTES.account, label: 'Cuenta', icon: UserIcon, end: false },
];

function BottomNav() {
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-base-600/70 bg-base-900/90 backdrop-blur-lg md:hidden">
      <ul className="mx-auto flex max-w-lg items-stretch justify-around px-2 pt-1.5">
        {BOTTOM_LINKS.map((link) => (
          <li key={link.to} className="flex-1">
            <NavLink
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[11px] font-medium transition',
                  isActive ? 'text-neon-crimson' : 'text-slate-500 hover:text-slate-300'
                )
              }
            >
              {({ isActive }) => (
                <>
                  <link.icon
                    className={cn('h-5 w-5', isActive && 'drop-shadow-[0_0_8px_rgba(240,48,48,0.8)]')}
                    aria-hidden
                  />
                  {link.label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Footer() {
  const { config } = useConfig();

  return (
    <footer className="mt-16 border-t border-base-600/70 bg-base-900/50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xs">
            <Link to={ROUTES.home} aria-label="Refill Store">
              <BrandLockup width={176} />
            </Link>
            <p className="mt-3 text-sm text-slate-400">
              {config?.tagline ?? 'Recargas al instante para tus juegos favoritos.'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 text-sm">
            <div>
              <p className="mb-2 font-semibold text-white">Tienda</p>
              <ul className="space-y-1.5 text-slate-400">
                <li>
                  <Link to={ROUTES.home} className="hover:text-white">
                    Inicio
                  </Link>
                </li>
                <li>
                  <Link to={ROUTES.orders} className="hover:text-white">
                    Mis órdenes
                  </Link>
                </li>
                <li>
                  <Link to={ROUTES.faq} className="hover:text-white">
                    Preguntas frecuentes
                  </Link>
                </li>
                <li>
                  <Link to={ROUTES.privacy} className="hover:text-white">
                    Política de privacidad
                  </Link>
                </li>
                <li>
                  <Link to={ROUTES.accountDeletion} className="hover:text-white">
                    Eliminar mi cuenta
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-2 font-semibold text-white">Contacto</p>
              <ul className="space-y-1.5 text-slate-400">
                {config?.supportUrl && (
                  <li>
                    <a
                      href={config.supportUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-white"
                    >
                      WhatsApp
                    </a>
                  </li>
                )}
                {config?.contact.instagram && (
                  <li>
                    <a
                      href={`https://instagram.com/${config.contact.instagram.replace('@', '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-white"
                    >
                      Instagram
                    </a>
                  </li>
                )}
                {config?.contact.email && (
                  <li>
                    <a href={`mailto:${config.contact.email}`} className="hover:text-white">
                      {config.contact.email}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>

        <p className="mt-8 border-t border-base-600/70 pt-5 text-xs text-slate-500">
          © {new Date().getFullYear()} {config?.storeName ?? 'Refill Store'}. Los nombres y logos de
          los juegos pertenecen a sus respectivos dueños. No somos un servicio oficial.
        </p>
      </div>
    </footer>
  );
}

function AnnouncementBar() {
  const { config } = useConfig();
  const location = useLocation();
  const smartNavigate = useSmartStoreNavigate();
  const activeNotices = useMemo<StoreNotice[]>(() => {
    const stored = Array.isArray(config?.announcement.notices) ? config.announcement.notices : [];
    if (stored.length === 0) {
      const legacyText = config?.announcement.text?.trim();
      return legacyText ? [{ id: 'legacy-announcement', text: legacyText, active: true }] : [];
    }
    const active = stored.filter((notice) => notice.active && notice.text.trim());
    return active;
  }, [config?.announcement.notices, config?.announcement.text]);
  const intervalMs = Math.min(60, Math.max(2, config?.announcement.intervalSeconds ?? 5)) * 1000;
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    setCurrentIndex((current) => (current >= activeNotices.length ? 0 : current));
  }, [activeNotices.length]);

  useEffect(() => {
    if (activeNotices.length <= 1) return;
    const timer = window.setInterval(() => {
      setCurrentIndex((index) => (index + 1) % activeNotices.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [activeNotices.length, intervalMs]);

  if (!config?.announcement.enabled || activeNotices.length === 0) return null;
  // En el checkout distrae: allí lo que importa es el monto y la referencia.
  if (location.pathname.startsWith('/comprar')) return null;

  const notice = activeNotices[currentIndex] ?? activeNotices[0];
  const navTarget = resolveNavigationTarget(notice.linkUrl, notice.scrollTarget);
  const isExternal = navTarget.isExternal;

  const innerContent = (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      {notice.iconUrl || (notice.icon && isImageUrl(notice.icon)) ? (
        <img
          src={notice.iconUrl || notice.icon}
          alt=""
          className="inline-block h-5 w-auto max-w-[28px] object-contain shrink-0 rounded-sm"
        />
      ) : notice.icon ? (
        <span aria-hidden="true">{notice.icon}</span>
      ) : null}
      {notice.badge && (
        <span className="rounded bg-neon-red/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-neon-crimson border border-neon-red/30">
          {notice.badge}
        </span>
      )}
      <span className="text-slate-200">
        {notice.text}{' '}
        {notice.highlightText && (
          <strong className="font-semibold text-neon-crimson">
            {notice.highlightText}
          </strong>
        )}
      </span>
      {notice.linkText && (
        <span className="ml-1 inline-flex items-center gap-0.5 font-medium text-neon-crimson underline underline-offset-2 hover:text-white transition-colors">
          {notice.linkText} <ChevronRight className="h-3 w-3" aria-hidden="true" />
        </span>
      )}
    </div>
  );

  const content = navTarget.fullHref ? (
    isExternal ? (
      <a
        href={navTarget.fullHref}
        target="_blank"
        rel="noopener noreferrer"
        className="block hover:opacity-90"
      >
        {innerContent}
      </a>
    ) : (
      <Link
        to={navTarget.fullHref}
        onClick={(event) => {
          if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
            event.preventDefault();
            smartNavigate(notice.linkUrl, notice.scrollTarget);
          }
        }}
        className="block hover:opacity-90"
      >
        {innerContent}
      </Link>
    )
  ) : (
    innerContent
  );

  return (
    <div
      className="relative z-10 flex min-h-[40px] items-center justify-center overflow-hidden border-b border-neon-red/20 bg-gradient-to-r from-base-900 via-base-800 to-base-900 px-4 py-2 text-center text-sm text-slate-200 shadow-[inset_0_1px_0_rgba(240,48,48,0.15)]"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-neon-red/10 via-transparent to-transparent" />

      <AnimatePresence mode="wait">
        <motion.div
          key={notice.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3 }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function StoreLayout() {
  const [menuOpen, setMenuOpen] = useState(false);

  // El código del creador llega por `?c=` en el enlace que él comparte. Se
  // guarda al aterrizar, en cualquier página, porque el cliente puede entrar
  // directo a un juego y no pasar nunca por el inicio.
  useEffect(() => {
    captureCreatorCodeFromUrl();
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header onOpenMenu={() => setMenuOpen(true)} />
      <CategoryNav />
      <AnnouncementBar />

      {/* pb-24 deja aire para la navegación inferior en móvil. */}
      <main className="flex-1 pb-24 md:pb-0">
        <Outlet />
      </main>

      <StoreModals />

      <Footer />
      <BottomNav />
      <RefillChatbot />
      <AccountDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  );
}
