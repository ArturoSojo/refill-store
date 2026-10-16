import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useAuth } from '@/providers/AuthProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { FullPageLoader } from '@/components/ui/Feedback';
import { AnimatedBackground } from '@/components/common/Decor';
import { ROUTES } from '@/lib/constants';
import { AuthCard } from '@/components/auth/AuthCard';

export function LoginPage() {
  useDocumentTitle('Iniciar sesión');
  const { user, loading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const from = (location.state as { from?: string } | null)?.from ?? ROUTES.home;

  // Si la sesión se resuelve estando aquí, se devuelve al usuario a lo que hacía.
  useEffect(() => {
    if (user && !loading) navigate(from, { replace: true });
  }, [user, loading, from, navigate]);

  if (loading) return <FullPageLoader />;
  if (user) return <Navigate to={from} replace />;

  return (
    <div className="relative flex min-h-[85vh] items-center justify-center px-4 py-10">
      <AnimatedBackground />

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-md"
      >
        <AuthCard />
      </motion.div>
    </div>
  );
}
