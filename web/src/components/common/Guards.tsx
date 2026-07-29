/** Guardas de ruta y utilidades de navegación. */
import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';
import { FullPageLoader, ErrorState } from '@/components/ui/Feedback';
import { ButtonLink } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';

/** Exige sesión iniciada; recuerda a dónde quería ir el usuario. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader label="Verificando tu sesión…" />;

  if (!user) {
    return <Navigate to={ROUTES.login} state={{ from: location.pathname + location.search }} replace />;
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

/** Sube al inicio al cambiar de ruta (los móviles conservan el scroll). */
export function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);

  return null;
}
