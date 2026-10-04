import { MessageCircle } from 'lucide-react';

interface ChatFloatingButtonProps {
  onClick: () => void;
}

/**
 * Botón flotante. En móvil se eleva por encima de la `BottomNav` (~ 4rem más
 * el área segura); desde `md` esa barra desaparece y baja a la esquina.
 */
export function ChatFloatingButton({ onClick }: ChatFloatingButtonProps) {
  return (
    <div className="fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-end gap-2.5 md:bottom-6 md:right-6">
      {/* Píldora invitacional */}
      <button
        type="button"
        onClick={onClick}
        className="group relative flex origin-bottom items-center gap-2 rounded-full border border-emerald-500/30 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-emerald-50 shadow-lg backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:bg-slate-800 animate-in fade-in slide-in-from-bottom-4 zoom-in-95"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
        </span>
        Asistente Virtual
        {/* Flechita apuntando hacia el botón principal */}
        <div className="absolute -bottom-1.5 right-4 h-3 w-3 rotate-45 border-b border-r border-emerald-500/30 bg-slate-900/90 backdrop-blur-sm transition-colors group-hover:bg-slate-800" />
      </button>

      {/* Botón principal */}
      <button
        type="button"
        onClick={onClick}
        aria-label="Abrir asistente de recargas"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-black/40 transition-transform duration-300 hover:scale-105 hover:bg-emerald-500 md:h-14 md:w-14"
      >
        <MessageCircle className="h-6 w-6" aria-hidden />
      </button>
    </div>
  );
}
