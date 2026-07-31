/** Cascarón del panel: barra lateral en escritorio, menú deslizante en móvil. */
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import {
  BellRing,
  Gamepad2,
  LayoutDashboard,
  LifeBuoy,
  Menu,
  Package,
  Receipt,
  ScrollText,
  Settings,
  Store,
  Tag,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';
import { useAdminAlerts } from '@/hooks/useAdmin';
import { BrandMark } from '@/components/common/Brand';
import { ROUTES } from '@/lib/constants';
import { cn, initials } from '@/lib/utils';

const NAV = [
  { to: ROUTES.admin, label: 'Resumen', icon: LayoutDashboard, end: true },
  { to: ROUTES.adminOrders, label: 'Órdenes', icon: Receipt, end: false },
  { to: ROUTES.adminAlerts, label: 'Avisos', icon: BellRing, end: false },
  { to: ROUTES.adminProducts, label: 'Productos', icon: Package, end: false },
  { to: ROUTES.adminGames, label: 'Juegos', icon: Gamepad2, end: false },
  { to: ROUTES.adminUsers, label: 'Usuarios', icon: Users, end: false },
  { to: ROUTES.adminCoupons, label: 'Cupones', icon: Tag, end: false },
  { to: ROUTES.adminTickets, label: 'Soporte', icon: LifeBuoy, end: false },
  { to: ROUTES.adminSettings, label: 'Configuración', icon: Settings, end: false },
  { to: ROUTES.adminLogs, label: 'Bitácora', icon: ScrollText, end: false },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const { isAdmin } = useAuth();
  // El contador va en el menú porque un despacho fallido no puede esperar a que
  // a alguien se le ocurra abrir la sección.
  const alerts = useAdminAlerts({ onlyUnread: true, limit: 1 });
  const unread = alerts.data?.unread ?? 0;

  return (
    <ul className="space-y-1">
      {NAV.map((item) => {
        // La bitácora y la configuración son sólo para administradores.
        const adminOnly = item.to === ROUTES.adminLogs;
        if (adminOnly && !isAdmin) return null;

        const badge = item.to === ROUTES.adminAlerts && unread > 0 ? unread : null;

        return (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                  isActive
                    ? 'bg-neon-red/15 text-red-100 shadow-[inset_2px_0_0_0_#F03030]'
                    : 'text-slate-400 hover:bg-base-700 hover:text-white'
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1">{item.label}</span>
              {badge && (
                <span className="rounded-full bg-neon-red px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}

function SidebarFooter() {
  const { me } = useAuth();

  return (
    <div className="border-t border-base-600 p-3">
      <Link
        to={ROUTES.home}
        className="mb-2 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-400 transition hover:bg-base-700 hover:text-white"
      >
        <Store className="h-4 w-4" aria-hidden />
        Ver la tienda
      </Link>

      {me && (
        <div className="flex items-center gap-3 rounded-xl bg-base-900/60 px-3 py-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-base-700 text-xs font-bold text-white">
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
            <p className="truncate text-xs font-semibold text-white">
              {me.profile.displayName ?? 'Staff'}
            </p>
            <p className="truncate text-[11px] capitalize text-slate-500">{me.profile.role}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function AdminLayout() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-dvh bg-base">
      {/* Barra lateral fija en escritorio */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-base-600 bg-base-900 lg:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-base-600 px-4">
          <BrandMark size={30} glow={false} />
          <span className="font-display text-sm font-bold text-white">Panel Refill</span>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <NavItems />
        </nav>

        <SidebarFooter />
      </aside>

      {/* Menú deslizante en móvil */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-base-600 bg-base-900 animate-slide-up">
            <div className="flex h-14 items-center justify-between border-b border-base-600 px-4">
              <span className="flex items-center gap-2.5">
                <BrandMark size={26} glow={false} />
                <span className="font-display text-sm font-bold text-white">Panel Refill</span>
              </span>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-base-700 hover:text-white"
                aria-label="Cerrar menú"
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3">
              <NavItems onNavigate={() => setMenuOpen(false)} />
            </nav>
            <SidebarFooter />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-base-600 bg-base-900/90 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="rounded-lg p-1.5 text-slate-300 hover:bg-base-700"
            aria-label="Abrir menú"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <span className="font-display text-sm font-bold text-white">Panel Refill</span>
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
