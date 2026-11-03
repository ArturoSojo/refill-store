/**
 * Ventana de invitación a la primera recarga.
 *
 * Sale a quien se acaba de registrar y a quien tiene cuenta pero nunca ha
 * completado una recarga. Se recuerda el cierre 24 h para no insistir en cada
 * visita; desaparece para siempre en cuanto el cliente completa una orden.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GraduationCap, Rocket, X } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';
import { useRechargeTour } from '@/features/tour/useRechargeTour';
import { Button } from '@/components/ui/Button';
import { ROUTES } from '@/lib/constants';

const DISMISSED_KEY = 'refill.firstRecharge.dismissedAt';
const REPEAT_AFTER_MS = 24 * 60 * 60 * 1000;
const SHOW_DELAY_MS = 2500;

function recentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? Date.now() - Number(raw) < REPEAT_AFTER_MS : false;
  } catch {
    return false;
  }
}

function rememberDismissal(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    /* sin almacenamiento volverá a salir: es el fallo menos malo */
  }
}

export function FirstRechargePrompt() {
  const { user, me } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tour = useRechargeTour();
  const [open, setOpen] = useState(false);

  const completed = me?.profile.stats?.completedOrders;
  // Sólo con el dato real del perfil: sin él no se puede saber si ya compró.
  const eligible =
    Boolean(user && me) && !me!.profile.banned && typeof completed === 'number' && completed === 0;
  // En el pago y el acceso no se interrumpe: ahí ya está en lo suyo.
  const blockedHere = pathname.startsWith('/comprar') || pathname.startsWith('/entrar');

  useEffect(() => {
    if (!eligible || blockedHere || tour.active || recentlyDismissed()) return undefined;

    const timer = window.setTimeout(() => {
      // No se apila sobre otro modal (avisos del panel, menú, etc.).
      if (!document.querySelector('[role="dialog"]')) setOpen(true);
    }, SHOW_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [eligible, blockedHere, tour.active]);

  if (!open || !eligible) return null;

  const close = () => {
    rememberDismissal();
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Haz tu primera recarga"
      onClick={close}
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-t-3xl border border-base-600 bg-base-800 p-6 text-center sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={close}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 transition hover:bg-base-700 hover:text-white"
          aria-label="Cerrar"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>

        <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-gradient shadow-glow">
          <Rocket className="h-8 w-8 text-white" aria-hidden />
        </span>

        <h2 className="text-xl font-black text-white">¡Haz tu primera recarga!</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">
          Elige tu juego, escribe tu ID, paga con Pago Móvil y tu recarga llega sola a tu cuenta. Es
          rápido y sin subir capturas.
        </p>

        <div className="mt-5 space-y-2">
          <Button
            fullWidth
            size="lg"
            onClick={() => {
              close();
              navigate(ROUTES.family('topup'));
            }}
          >
            Recargar ahora
          </Button>
          <Button
            fullWidth
            variant="secondary"
            leftIcon={<GraduationCap className="h-4 w-4" aria-hidden />}
            onClick={() => {
              close();
              tour.start(0);
            }}
          >
            Enséñame paso a paso
          </Button>
          <button
            type="button"
            onClick={close}
            className="w-full py-1.5 text-xs font-medium text-slate-500 transition hover:text-slate-300"
          >
            Ahora no
          </button>
        </div>
      </div>
    </div>
  );
}
