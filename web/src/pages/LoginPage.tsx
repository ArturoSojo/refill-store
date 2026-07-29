import { useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Eye, EyeOff, Gamepad2, History, Lock, Mail, ShieldCheck, User, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth, authErrorMessage } from '@/providers/AuthProvider';
import { useDocumentTitle } from '@/hooks/useMisc';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { FullPageLoader } from '@/components/ui/Feedback';
import { AnimatedBackground } from '@/components/common/Decor';
import { BrandLockup } from '@/components/common/Brand';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils';

const BENEFITS = [
  { icon: Zap, text: 'Compra en segundos, sin repetir tus datos' },
  { icon: History, text: 'Historial completo de tus recargas' },
  { icon: Gamepad2, text: 'Guarda tus IDs de jugador favoritos' },
  { icon: ShieldCheck, text: 'Descuentos por nivel y cupones' },
];

type Mode = 'login' | 'register';

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C39.9 35.9 44 30.5 44 24c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  );
}

export function LoginPage() {
  useDocumentTitle('Iniciar sesión');
  const { user, loading, signingIn, signInWithGoogle, signInWithEmail, registerWithEmail, resetPassword } =
    useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? ROUTES.home;

  // Si la sesión se resuelve estando aquí, se devuelve al usuario a lo que hacía.
  useEffect(() => {
    if (user && !loading) navigate(from, { replace: true });
  }, [user, loading, from, navigate]);

  if (loading) return <FullPageLoader />;
  if (user) return <Navigate to={from} replace />;

  const canSubmit =
    email.includes('@') && password.length >= 6 && (mode === 'login' || name.trim().length >= 2);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);

    try {
      if (mode === 'login') {
        await signInWithEmail(email, password);
        toast.success('¡Bienvenido de vuelta!');
      } else {
        await registerWithEmail(email, password, name);
        toast.success('Cuenta creada. ¡A recargar!');
      }
    } catch (error) {
      toast.error(authErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!email.includes('@')) {
      toast.error('Escribe tu correo primero y vuelve a tocar aquí.');
      return;
    }

    try {
      await resetPassword(email);
      toast.success('Te enviamos un correo para restablecer la contraseña.');
    } catch (error) {
      toast.error(authErrorMessage(error));
    }
  };

  return (
    <div className="relative flex min-h-[85vh] items-center justify-center px-4 py-10">
      <AnimatedBackground />

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-md"
      >
        <div className="neon-card p-6" data-selected="true">
          <div className="text-center">
            <BrandLockup width={190} className="mx-auto" />

            <h1 className="mt-4 text-2xl font-black">
              {mode === 'login' ? 'Entra a Refill Store' : 'Crea tu cuenta'}
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {mode === 'login'
                ? 'Necesitas una cuenta para completar el pago.'
                : 'Es gratis y te toma 20 segundos.'}
            </p>
          </div>

          <Button
            className="mt-6"
            size="lg"
            fullWidth
            variant="secondary"
            loading={signingIn && busy === false}
            onClick={() => {
              void signInWithGoogle().catch((error) => toast.error(authErrorMessage(error)));
            }}
            leftIcon={<GoogleIcon />}
          >
            Continuar con Google
          </Button>

          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-base-600" />
            <span className="text-xs font-medium text-slate-500">o con tu correo</span>
            <span className="h-px flex-1 bg-base-600" />
          </div>

          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {mode === 'register' && (
              <Input
                label="Tu nombre"
                value={name}
                onChange={(event) => setName(event.target.value.slice(0, 60))}
                placeholder="Cómo te llamamos"
                leftIcon={<User className="h-4 w-4" aria-hidden />}
                autoComplete="name"
              />
            )}

            <Input
              label="Correo"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value.trim())}
              placeholder="tucorreo@gmail.com"
              leftIcon={<Mail className="h-4 w-4" aria-hidden />}
              autoComplete="email"
              inputMode="email"
            />

            <Input
              label="Contraseña"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              leftIcon={<Lock className="h-4 w-4" aria-hidden />}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              hint={mode === 'register' ? 'Mínimo 6 caracteres.' : undefined}
              rightSlot={
                <button
                  type="button"
                  onClick={() => setShowPassword((current) => !current)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:text-white"
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              }
            />

            <Button type="submit" size="lg" fullWidth loading={busy} disabled={!canSubmit}>
              {mode === 'login' ? 'Entrar' : 'Crear cuenta'}
            </Button>
          </form>

          <div className="mt-4 flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              className="font-semibold text-neon-crimson hover:underline"
            >
              {mode === 'login' ? 'Crear una cuenta nueva' : 'Ya tengo cuenta'}
            </button>

            {mode === 'login' && (
              <button
                type="button"
                onClick={() => void handleReset()}
                className="text-slate-400 hover:text-white hover:underline"
              >
                Olvidé mi contraseña
              </button>
            )}
          </div>

          <ul className="mt-6 space-y-2.5 border-t border-base-600 pt-5">
            {BENEFITS.map((benefit, index) => (
              <motion.li
                key={benefit.text}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.15 + index * 0.06 }}
                className="flex items-center gap-3 text-sm text-slate-300"
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    'bg-neon-red/15 text-neon-red'
                  )}
                >
                  <benefit.icon className="h-4 w-4" aria-hidden />
                </span>
                {benefit.text}
              </motion.li>
            ))}
          </ul>

          <p className="mt-5 text-center text-xs text-slate-500">
            Al continuar aceptas que guardemos tus órdenes para poder darte soporte.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
