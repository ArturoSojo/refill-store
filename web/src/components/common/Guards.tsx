/** Guardas de ruta y utilidades de navegación. */
import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';
import { FullPageLoader, ErrorState } from '@/components/ui/Feedback';
import { ButtonLink } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';
import {
  sanitizeScrollTarget,
  scrollToAndHighlight,
  type ScrollNavigationState,
} from '@/lib/scrollTargets';

/** Exige sesión iniciada; recuerda a dónde quería ir el usuario (incluido `#ancla`). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader label="Verificando tu sesión…" />;

  if (!user) {
    return (
      <Navigate
        to={ROUTES.login}
        state={{ from: location.pathname + location.search + location.hash }}
        replace
      />
    );
  }

  return <>{children}</>;
}

/** Exige rol staff o admin. */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { user, isStaff, loading, profileLoading } = useAuth();
  const location = useLocation();

  if (loading || (user && profileLoading)) {
    return <FullPageLoader label="Comprobando permisos…" />;
  }

  if (!user) {
    return <Navigate to={ROUTES.login} state={{ from: location.pathname }} replace />;
  }

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <ErrorState
          title="Acceso restringido"
          message="Esta sección es sólo para el equipo de Refill Store."
          action={
            <ButtonLink to={ROUTES.home} variant="secondary">
              Volver a la tienda
            </ButtonLink>
          }
        />
        <div className="mt-4 flex justify-center text-slate-600">
          <ShieldAlert className="h-5 w-5" aria-hidden />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

/** Exige el rol de administrador para acciones globales del sistema. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, isAdmin, loading, profileLoading } = useAuth();
  const location = useLocation();

  if (loading || (user && profileLoading)) {
    return <FullPageLoader label="Comprobando permisos…" />;
  }

  if (!user) {
    return <Navigate to={ROUTES.login} state={{ from: location.pathname }} replace />;
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <ErrorState
          title="Acceso restringido"
          message="Sólo los administradores pueden enviar notificaciones push a la app."
          action={
            <ButtonLink to={ROUTES.admin} variant="secondary">
              Volver al panel
            </ButtonLink>
          }
        />
        <div className="mt-4 flex justify-center text-slate-600">
          <ShieldAlert className="h-5 w-5" aria-hidden />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Sube al inicio al cambiar de ruta o ejecuta scroll suave + resalte Gamer Mode
 * cuando la navegación incluye un `#ancla` o `scrollTarget`.
 */
export function ScrollToTop() {
  const location = useLocation();
  const prevPathnameRef = useRef(location.pathname);
  const navState = location.state as ScrollNavigationState | null;
  const scrollTrigger = navState?.scrollTrigger ?? 0;
  const explicitTarget = navState?.scrollTarget ?? '';

  useEffect(() => {
    const pathnameChanged = prevPathnameRef.current !== location.pathname;
    prevPathnameRef.current = location.pathname;

    const rawHash = location.hash ? decodeURIComponent(location.hash.replace(/^#+/, '')) : '';
    const targetId = sanitizeScrollTarget(explicitTarget || rawHash);

    if (targetId) {
      if (pathnameChanged) {
        window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      }
      return scrollToAndHighlight(targetId, { maxWaitMs: 700 });
    }

    if (pathnameChanged) {
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    }
    return undefined;
  }, [location.pathname, location.hash, scrollTrigger, explicitTarget]);

  return null;
}
