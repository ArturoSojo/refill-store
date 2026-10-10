import { useState, useEffect } from 'react';
import { MessageCircle } from 'lucide-react';
import { motion } from 'framer-motion';
import { useDualBotConfig } from './useChatbotConfig';

interface ChatFloatingButtonProps {
  onClick: () => void;
}

/**
 * Botón flotante. En móvil se eleva por encima de la `BottomNav` (~ 5rem más
 * el área segura); desde `md` baja a la esquina pero sobre botones de WhatsApp.
 */
export function ChatFloatingButton({ onClick }: ChatFloatingButtonProps) {
  const dualConfig = useDualBotConfig();
  const profile = dualConfig.chatbot.enabled ? dualConfig.chatbot : dualConfig.supportBot;
  
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  
  useEffect(() => {
    const handleResize = () => setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <motion.div
      drag
      dragMomentum={false}
      // Assuming button is ~60px and rendered near bottom-right, we give constraints relative to initial position.
      dragConstraints={{ 
        left: -(windowSize.width - 80), 
        right: 0, 
        top: -(windowSize.height - 120), 
        bottom: 0 
      }}
      // z-40 allows modals (z-50) and ChatWindow (z-[60]) to cover it, but floats over standard elements.
      // We set bottom-24 (6rem) for desktop to ensure it's above WhatsApp button if present.
      className="fixed right-4 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-40 flex cursor-grab flex-col items-end gap-2.5 active:cursor-grabbing md:bottom-24 md:right-6"
    >
      {/* Píldora invitacional */}
      <div
        className="group relative flex origin-bottom items-center gap-2 rounded-full border border-emerald-500/30 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-emerald-50 shadow-lg backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:bg-slate-800 animate-in fade-in slide-in-from-bottom-4 zoom-in-95 pointer-events-none"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
        </span>
        Asistente Virtual
        <div className="absolute -bottom-1.5 right-4 h-3 w-3 rotate-45 border-b border-r border-emerald-500/30 bg-slate-900/90 backdrop-blur-sm transition-colors group-hover:bg-slate-800" />
      </div>

      {/* Botón principal */}
      <button
        type="button"
        onClick={onClick}
        aria-label={`Abrir ${profile.name}`}
        className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-emerald-600 text-white shadow-lg shadow-black/40 transition-transform duration-300 hover:scale-105 hover:bg-emerald-500 md:h-14 md:w-14"
      >
        {profile.avatarUrl ? (
          <img src={profile.avatarUrl} alt="" className="pointer-events-none h-full w-full object-cover" />
        ) : (
          <MessageCircle className="pointer-events-none h-6 w-6" aria-hidden />
        )}
      </button>
    </motion.div>
  );
}


