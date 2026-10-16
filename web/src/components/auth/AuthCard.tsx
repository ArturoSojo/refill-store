import { useState } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff, Gamepad2, History, Lock, Mail, Phone, ShieldCheck, User, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth, authErrorMessage } from '@/providers/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { BrandLockup } from '@/components/common/Brand';
import { api } from '@/lib/api';
import { isPhoneInput, normalizePhone } from '@/lib/phone';
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
        fill="#EA4335"
        d="M12 5c1.5 0 2.8.5 3.9 1.5l2.9-2.9C17 1.8 14.7 1 12 1 7.5 1 3.7 3.6 1.9 7.3l3.5 2.7C6.3 7.3 8.9 5 12 5z"
      />
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.7l3.7 2.9c2.2-2 3.7-5 3.7-8.8z"
      />
      <path
        fill="#FBBC05"
        d="M5.4 14.7c-.2-.7-.4-1.5-.4-2.7s.2-2 .4-2.7L1.9 6.6C.7 9 0 10.9 0 12s.7 3 1.9 5.4l3.5-2.7z"
      />
      <path
        fill="#34A853"
        d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.7-2.3-6.6-5.3L1.9 15.7C3.7 19.4 7.5 23 12 23z"
      />
    </svg>
  );
}

export interface AuthCardProps {
  onSuccess?: () => void;
  isModal?: boolean;
}

export function AuthCard({ onSuccess, isModal = false }: AuthCardProps) {
  const { signingIn, signInWithGoogle, signInWithEmail, registerWithEmail, resetPassword } = useAuth();

  const [mode, setMode] = useState<Mode>('login');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const isLoginValid =
    mode === 'login' &&
    password.length >= 6 &&
    (identifier.includes('@') || normalizePhone(identifier).length >= 7);

  const isRegisterValid =
    mode === 'register' &&
    password.length >= 6 &&
    email.includes('@') &&
    name.trim().length >= 2;

  const canSubmit = isLoginValid || isRegisterValid;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);

    try {
      if (mode === 'login') {
        let targetEmail = identifier.trim();
        if (!targetEmail.includes('@')) {
          const normalized = normalizePhone(targetEmail);
          const res = await api.post<{ exists: boolean; email: string | null; maskedEmail: string | null }>(
            '/auth/resolve-phone',
            { phone: normalized },
            { anonymous: true }
          );
          if (!res.exists || !res.email) {
            toast.error('No encontramos ninguna cuenta asociada a este número de teléfono.');
            return;
          }
          targetEmail = res.email;
        }

        await signInWithEmail(targetEmail, password);
        toast.success('¡Bienvenido de vuelta!');
        onSuccess?.();
      } else {
        const cleanEmail = email.trim();
        let normalizedRegisterPhone: string | undefined;
        if (phone.trim()) {
          normalizedRegisterPhone = normalizePhone(phone.trim());
          if (!normalizedRegisterPhone || normalizedRegisterPhone.length < 8) {
            toast.error('El número de teléfono no tiene un formato válido.');
            return;
          }
          const check = await api.post<{ exists: boolean }>(
            '/auth/resolve-phone',
            { phone: normalizedRegisterPhone },
            { anonymous: true }
          );
          if (check.exists) {
            toast.error('Este número de teléfono ya está registrado en otra cuenta.');
            return;
          }
        }

        await registerWithEmail(cleanEmail, password, name, normalizedRegisterPhone);
        toast.success('Cuenta creada. ¡A recargar!');
        onSuccess?.();
      }
    } catch (error) {
      toast.error(authErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    const raw = identifier.trim();
    if (!raw) {
      toast.error('Escribe tu correo o número de teléfono en el campo de arriba y vuelve a tocar aquí.');
      return;
    }

    if (raw.includes('@')) {
      try {
        await resetPassword(raw);
        toast.success('Si ese correo tiene una cuenta, recibirás instrucciones para restablecer la contraseña.');
      } catch (error) {
        toast.error(authErrorMessage(error));
      }
      return;
    }

    const normalized = normalizePhone(raw);
    if (!normalized || normalized.length < 8) {
      toast.error('Ingresa un número de teléfono válido.');
      return;
    }

    try {
      const res = await api.post<{ exists: boolean; email: string | null; maskedEmail: string | null }>(
        '/auth/resolve-phone',
        { phone: normalized },
        { anonymous: true }
      );

      if (!res.exists || !res.email) {
        toast.error('No encontramos ninguna cuenta asociada a este número de teléfono.');
        return;
      }

      await resetPassword(res.email);
      toast.success(
        `Hemos enviado las instrucciones de recuperación al correo asociado a tu número (${res.maskedEmail || res.email})`
      );
    } catch (error) {
      toast.error(authErrorMessage(error));
    }
  };

  return (
    <div className={cn(!isModal && 'neon-card p-6')} data-selected={!isModal ? 'true' : undefined}>
      <div className="text-center">
        <BrandLockup width={isModal ? 150 : 190} className="mx-auto" />

        <h1 className={cn('font-black text-white', isModal ? 'mt-3 text-xl' : 'mt-4 text-2xl')}>
          {mode === 'login' ? 'Entra a Refill Store' : 'Crea tu cuenta'}
        </h1>
        <p className="mt-1 text-xs text-slate-400 sm:text-sm">
          {mode === 'login'
            ? isModal
              ? 'Inicia sesión para continuar con tu recarga.'
              : 'Necesitas una cuenta para completar el pago.'
            : 'Es gratis y te toma 20 segundos.'}
        </p>
      </div>

      <Button
        className={cn(isModal ? 'mt-4' : 'mt-6')}
        size={isModal ? 'md' : 'lg'}
        fullWidth
        variant="secondary"
        loading={signingIn && busy === false}
        onClick={() => {
          void signInWithGoogle()
            .then(() => onSuccess?.())
            .catch((error) => toast.error(authErrorMessage(error)));
        }}
        leftIcon={<GoogleIcon />}
      >
        Continuar con Google
      </Button>

      <div className={cn('flex items-center gap-3', isModal ? 'my-3' : 'my-5')}>
        <span className="h-px flex-1 bg-base-600" />
        <span className="text-xs font-medium text-slate-500">
          {mode === 'login' ? 'o con tu correo o teléfono' : 'o con tus datos'}
        </span>
        <span className="h-px flex-1 bg-base-600" />
      </div>

      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === 'login' ? (
          <Input
            label="Correo electrónico o Número de teléfono"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="Correo o teléfono"
            className="text-sm placeholder:text-slate-500"
            leftIcon={
              isPhoneInput(identifier) ? (
                <Phone className="h-4 w-4" aria-hidden />
              ) : (
                <Mail className="h-4 w-4" aria-hidden />
              )
            }
            autoComplete="username"
          />
        ) : (
          <>
            <Input
              label="Tu nombre"
              value={name}
              onChange={(event) => setName(event.target.value.slice(0, 60))}
              placeholder="Cómo te llamamos"
              leftIcon={<User className="h-4 w-4" aria-hidden />}
              autoComplete="name"
            />

            <Input
              label="Correo electrónico"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value.trim())}
              placeholder="tucorreo@gmail.com"
              leftIcon={<Mail className="h-4 w-4" aria-hidden />}
              autoComplete="email"
              inputMode="email"
            />

            <Input
              label="Teléfono (opcional)"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="0412-1234567"
              leftIcon={<Phone className="h-4 w-4" aria-hidden />}
              autoComplete="tel"
              hint="Para acceder o recuperar tu cuenta sin usar SMS."
            />
          </>
        )}

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

        <Button
          type="submit"
          size={isModal ? 'md' : 'lg'}
          fullWidth
          loading={busy}
          disabled={!canSubmit}
        >
          {mode === 'login' ? 'Entrar' : 'Crear cuenta'}
        </Button>
      </form>

      <div className="mt-4 flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={() => {
            if (mode === 'login') {
              if (identifier.includes('@')) setEmail(identifier);
              else if (identifier.trim()) setPhone(identifier);
              setMode('register');
            } else {
              if (email.trim()) setIdentifier(email);
              else if (phone.trim()) setIdentifier(phone);
              setMode('login');
            }
          }}
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

      {!isModal && (
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
      )}

      <p className="mt-4 text-center text-xs text-slate-500">
        Al continuar aceptas que guardemos tus órdenes para poder darte soporte.
      </p>
    </div>
  );
}
