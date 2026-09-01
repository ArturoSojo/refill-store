/**
 * Modales de la tienda: el tutorial de «cómo recargar» y avisos parecidos.
 *
 * Se muestran solos al entrar según su frecuencia, y quedan accesibles después
 * desde un botón flotante. Ese botón importa tanto como el modal: quien lo
 * cierra sin leerlo no tiene otra forma de volver a abrirlo, y acaba
 * preguntando por WhatsApp lo mismo que el tutorial explicaba.
 */
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { GraduationCap, X } from 'lucide-react';
import { useStoreModals } from '@/hooks/useMisc';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import type { StoreModal } from '@/types/models';

/** Marca de «ya lo vio», por modal. */
const KEY = (id: string) => `refill.modal.${id}`;

/**
 * ¿Toca mostrarlo solo?
 *
 * Todo lo que falle al leer el almacenamiento se resuelve como «sí»: en modo
 * privado es preferible enseñar el tutorial de más que no enseñarlo nunca.
 */
function shouldAutoOpen(modal: StoreModal): boolean {
  if (modal.frequency === 'always') return true;
  if (modal.placement === 'manual') return false;

  try {
    const raw = localStorage.getItem(KEY(modal.id));
    if (!raw) return true;
    if (modal.frequency === 'once') return false;

    // `daily`: se repite al día siguiente.
    return Date.now() - Number(raw) > 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function markSeen(modal: StoreModal): void {
  try {
    localStorage.setItem(KEY(modal.id), String(Date.now()));
  } catch {
    // Sin almacenamiento el modal volverá a salir. Es el fallo menos malo.
  }
}

function ModalCard({ modal, onClose }: { modal: StoreModal; onClose: () => void }) {
  // Cada línea del cuerpo es un paso: es como lo escribe quien lo redacta y
  // ahorra tener que meter un editor con formato.
  const steps = modal.body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={modal.title}
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-base-600 bg-base-800 sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-base-600 bg-base-800/95 px-4 py-3 backdrop-blur">
          <h2 className="text-base font-bold text-white">{modal.title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-base-700 hover:text-white"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="space-y-4 p-4">
          {modal.videoUrl && (
            <div className="aspect-video overflow-hidden rounded-2xl bg-black">
              <iframe
                src={modal.videoUrl}
                title={modal.title}
                className="h-full w-full"
                allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          )}

          {modal.imageUrl && (
            <img
              src={modal.imageUrl}
              alt=""
              className="w-full rounded-2xl object-cover"
              loading="lazy"
            />
          )}

          {steps.length > 0 && (
            <ol className="space-y-2.5">
              {steps.map((step, index) => (
                <li key={index} className="flex gap-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-brand-gradient text-xs font-black text-white">
                    {index + 1}
                  </span>
                  <span className="text-sm leading-relaxed text-slate-300">{step}</span>
                </li>
              ))}
            </ol>
          )}

          {modal.ctaLabel && modal.ctaUrl && (
            <a
              href={modal.ctaUrl}
              target={modal.ctaUrl.startsWith('http') ? '_blank' : undefined}
              rel="noreferrer"
              className="block"
            >
              <Button fullWidth>{modal.ctaLabel}</Button>
            </a>
          )}

          <Button variant="secondary" fullWidth onClick={onClose}>
            Entendido
          </Button>
        </div>
      </div>
    </div>
  );
}

export function StoreModals() {
  const { pathname } = useLocation();
  const { data } = useStoreModals();
  const [openId, setOpenId] = useState<string | null>(null);
  const [autoDone, setAutoDone] = useState(false);

  const isHome = pathname === '/';

  const all = useMemo(() => data?.modals ?? [], [data]);

  /** Los que corresponden a esta pantalla. */
  const forHere = useMemo(
    () => all.filter((modal) => modal.placement === 'store' || (isHome && modal.placement === 'home')),
    [all, isHome]
  );

  useEffect(() => {
    if (autoDone || forHere.length === 0) return;

    const candidate = forHere.find(shouldAutoOpen);
    if (candidate) setOpenId(candidate.id);
    // Sólo se intenta una vez por carga: si no, cambiar de página volvería a
    // abrirlo y sería insoportable.
    setAutoDone(true);
  }, [forHere, autoDone]);

  const open = all.find((modal) => modal.id === openId) ?? null;

  // El botón reabre el primero de esta pantalla, o el primero que haya.
  const reopenable = forHere[0] ?? all[0] ?? null;

  const close = () => {
    if (open) markSeen(open);
    setOpenId(null);
  };

  if (all.length === 0) return null;

  return (
    <>
      {open && <ModalCard modal={open} onClose={close} />}

      {reopenable && !open && (
        <button
          type="button"
          onClick={() => setOpenId(reopenable.id)}
          className={cn(
            'fixed right-4 z-40 flex items-center gap-1.5 rounded-full bg-brand-gradient px-3.5 py-2.5',
            'text-xs font-bold text-white shadow-glow transition active:scale-95',
            // Por encima de la navegación inferior en móvil.
            'bottom-24 md:bottom-6'
          )}
        >
          <GraduationCap className="h-4 w-4" aria-hidden />
          {reopenable.ctaLabel || 'Cómo recargar'}
        </button>
      )}
    </>
  );
}
