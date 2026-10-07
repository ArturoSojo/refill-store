import { useEffect, useRef, useState, type FormEvent } from 'react';
import { applyActionCode, checkActionCode, confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, KeyRound, LoaderCircle, Mail, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { AnimatedBackground } from '@/components/common/Decor';
import { BrandLockup } from '@/components/common/Brand';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { auth } from '@/lib/firebase';

type ScreenState =
  | { kind: 'checking' }
  | { kind: 'reset'; email: string }
  | { kind: 'success'; title: string; message: string }
  | { kind: 'error'; message: string };

const TRUSTED_CONTINUE_HOSTS = new Set([
  'recargasrefillstore.com',
  'www.recargasrefillstore.com',
  'refill-store-ve.netlify.app',
]);

function safeContinueUrl(raw: string | null): string {
  const fallback = `${window.location.origin}/entrar`;
  if (!raw) return fallback;

  try {
    const url = new URL(raw);
    const sameOrigin = url.origin === window.location.origin;
    if (url.protocol === 'https:' && (sameOrigin || TRUSTED_CONTINUE_HOSTS.has(url.hostname))) {
      return url.toString();
    }
  } catch {
    // Un enlace mal formado nunca debe convertirse en una redirección externa.
  }

  return fallback;
}

function actionError(error: unknown): string {
  const code = (error as { code?: string }).code ?? '';
  if (code === 'auth/expired-action-code') return 'Este enlace ya venció. Solicita uno nuevo desde la pantalla de acceso.';
  if (code === 'auth/invalid-action-code') return 'Este enlace ya se usó o no es válido. Solicita uno nuevo.';
  if (code === 'auth/weak-password') return 'La contraseña es muy fácil de adivinar. Prueba con una más segura.';
  if (code === 'auth/network-request-failed') return 'No hay conexión. Revisa tu internet e intenta de nuevo.';
  return 'No pudimos validar este enlace. Solicita uno nuevo desde la pantalla de acceso.';
}

/** Pantalla propia para enlaces de restablecimiento y otras acciones de Firebase Auth. */
export function AuthActionPage() {
  const [searchParams] = useSearchParams();
  const mode = searchParams.get('mode');
  const actionCode = searchParams.get('oobCode');
  const continueUrl = safeContinueUrl(searchParams.get('continueUrl'));
  const started = useRef(false);
  const [screen, setScreen] = useState<ScreenState>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // El código de un solo uso no debe quedarse visible en el historial del navegador.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);

    if (!actionCode) {
      setScreen({ kind: 'error', message: 'El enlace está incompleto. Solicita uno nuevo desde la pantalla de acceso.' });
      return;
    }

    const handleAction = async () => {
      try {
        if (mode === 'resetPassword') {
          const email = await verifyPasswordResetCode(auth, actionCode);
          setScreen({ kind: 'reset', email });
          return;
        }

        if (mode === 'verifyEmail') {
          await applyActionCode(auth, actionCode);
          setScreen({
            kind: 'success',
            title: 'Correo confirmado',
            message: 'Tu correo quedó verificado. Ya puedes volver a Refill Store.',
          });
          return;
        }

        if (mode === 'recoverEmail') {
          await checkActionCode(auth, actionCode);
          await applyActionCode(auth, actionCode);
          setScreen({
            kind: 'success',
            title: 'Cuenta recuperada',
            message: 'Se restauró el correo anterior de tu cuenta. Por seguridad, inicia sesión de nuevo.',
          });
          return;
        }

        setScreen({ kind: 'error', message: 'Este tipo de enlace no está disponible.' });
      } catch (error) {
        setScreen({ kind: 'error', message: actionError(error) });
      }
    };

    void handleAction();
  }, [actionCode, mode]);

  const submitReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (screen.kind !== 'reset' || !actionCode || busy) return;
    if (password.length < 6) {
      setFormError('La contraseña debe tener al menos 6 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setFormError('Las contraseñas no coinciden. Revísalas e intenta de nuevo.');
      return;
    }

    setFormError('');
    setBusy(true);
    try {
      await confirmPasswordReset(auth, actionCode, password);
      setScreen({
        kind: 'success',
        title: 'Contraseña actualizada',
        message: 'Listo. Ya puedes iniciar sesión con tu nueva contraseña.',
      });
    } catch (error) {
      setScreen({ kind: 'error', message: actionError(error) });
    } finally {
      setBusy(false);
    }
  };

  const isError = screen.kind === 'error';

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <AnimatedBackground className="fixed inset-0" />
      <motion.section
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="card relative w-full max-w-md overflow-hidden p-6 sm:p-8"
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-brand-gradient" aria-hidden />
        <div className="text-center">
          <BrandLockup width={190} className="mx-auto" />
          <div className="mx-auto mt-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-neon-red/15 text-neon-crimson">
            {screen.kind === 'checking' ? (
              <LoaderCircle className="h-6 w-6 animate-spin" aria-hidden />
            ) : isError ? (
              <AlertCircle className="h-6 w-6" aria-hidden />
            ) : screen.kind === 'success' ? (
              <CheckCircle2 className="h-6 w-6" aria-hidden />
            ) : (
              <KeyRound className="h-6 w-6" aria-hidden />
            )}
          </div>
          <h1 className="mt-4 text-2xl font-black">
            {screen.kind === 'checking'
              ? 'Validando tu enlace'
              : screen.kind === 'reset'
                ? 'Crea una nueva contraseña'
                : screen.kind === 'success'
                  ? screen.title
                  : 'No pudimos completar el enlace'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {screen.kind === 'checking'
              ? 'Un momento, estamos comprobando que el enlace sea válido y siga vigente.'
              : screen.kind === 'reset'
                ? 'Elige una contraseña nueva para proteger tu cuenta.'
                : screen.kind === 'success'
                  ? screen.message
                  : screen.message}
          </p>
        </div>

        <AnimatePresence mode="wait">
          {screen.kind === 'checking' && (
            <motion.div key="checking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-6">
              <div className="h-2 overflow-hidden rounded-full bg-base-700">
                <div className="h-full w-1/2 animate-pulse rounded-full bg-brand-gradient" />
              </div>
            </motion.div>
          )}

          {screen.kind === 'reset' && (
            <motion.form
              key="reset"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              onSubmit={(event) => void submitReset(event)}
              className="mt-6 space-y-4"
            >
              <div className="flex items-center gap-2 rounded-xl border border-base-600 bg-base-900/70 px-3 py-2.5 text-sm text-slate-300">
                <Mail className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                <span className="break-all">{screen.email}</span>
              </div>
              <Input
                label="Nueva contraseña"
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFormError('');
                }}
                placeholder="Mínimo 6 caracteres"
                autoComplete="new-password"
                leftIcon={<KeyRound className="h-4 w-4" aria-hidden />}
                hint="Usa una contraseña que no utilices en otros sitios."
              />
              <Input
                label="Confirma la contraseña"
                type="password"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setFormError('');
                }}
                placeholder="Escríbela de nuevo"
                autoComplete="new-password"
                leftIcon={<ShieldCheck className="h-4 w-4" aria-hidden />}
              />
              {formError && <p role="alert" className="text-sm text-red-400">{formError}</p>}
              <Button type="submit" size="lg" fullWidth loading={busy} disabled={password.length < 6 || !confirmPassword}>
                Guardar nueva contraseña
              </Button>
            </motion.form>
          )}
        </AnimatePresence>

        {screen.kind !== 'checking' && screen.kind !== 'reset' && (
          <a
            href={continueUrl}
            rel="noreferrer"
            className="mt-6 flex min-h-11 items-center justify-center rounded-xl bg-brand-gradient px-4 py-3 text-sm font-bold text-white shadow-glow transition hover:brightness-110"
          >
            {screen.kind === 'success' ? 'Volver a Refill Store' : 'Ir a iniciar sesión'}
          </a>
        )}

        <p className="mt-6 border-t border-base-600 pt-4 text-center text-xs text-slate-500">
          ¿Necesitas ayuda? Escríbenos a{' '}
          <a className="font-semibold text-slate-300 hover:text-white" href="mailto:recargasrefillstore@gmail.com">
            recargasrefillstore@gmail.com
          </a>
        </p>
      </motion.section>
    </main>
  );
}
