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
    <button
      type="button"
      onClick={onClick}
      aria-label="Abrir asistente de recargas"
      className="fixed right-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-black/40 transition hover:scale-105 hover:bg-emerald-500 bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-6 md:right-6 md:h-14 md:w-14 overflow-hidden"
    >
      <MessageCircle className="h-6 w-6" aria-hidden />
    </button>
  );
}
