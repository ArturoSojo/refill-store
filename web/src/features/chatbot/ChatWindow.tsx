import { useState, type FormEvent } from 'react';
import { RotateCcw, Send, X } from 'lucide-react';
import { useChatbotConfig } from './useChatbotConfig';
import { ChatMessageList } from './ChatMessageList';
import type { useRefillChatBot } from './useRefillChatBot';

type ChatBot = ReturnType<typeof useRefillChatBot>;

interface ChatWindowProps {
  bot: ChatBot;
  onClose: () => void;
}

/** Ventana de chat: pantalla completa en móvil, tarjeta flotante en escritorio. */
export function ChatWindow({ bot, onClose }: ChatWindowProps) {
  const [draft, setDraft] = useState('');
  const chatbotConfig = useChatbotConfig();
  
  const botName = chatbotConfig.name;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!bot.canType || !draft.trim()) return;
    bot.sendText(draft);
    setDraft('');
  };

  return (
    <div
      role="dialog"
      aria-label="Asistente de recargas"
      className="fixed inset-0 z-[60] flex flex-col bg-base-900 md:inset-auto md:bottom-6 md:right-6 md:h-[560px] md:max-h-[calc(100dvh-3rem)] md:w-[380px] md:overflow-hidden md:rounded-2xl md:border md:border-base-600 md:shadow-2xl"
    >
      <header className="safe-top flex items-center gap-3 bg-emerald-700 px-4 py-3 text-white">
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-bold uppercase"
        >
          {botName.charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold leading-tight">{botName}</p>
          <p className="text-xs text-emerald-100">{bot.isTyping ? 'escribiendo...' : 'en línea'}</p>
        </div>
        <button
          type="button"
          onClick={bot.reset}
          aria-label="Reiniciar conversación"
          className="rounded-full p-2 hover:bg-emerald-600"
        >
          <RotateCcw className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar asistente"
          className="rounded-full p-2 hover:bg-emerald-600"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </header>

      <ChatMessageList messages={bot.messages} isTyping={bot.isTyping} onSelectOption={bot.selectOption} />

      <form onSubmit={handleSubmit} className="safe-bottom flex items-end gap-2 border-t border-base-600 bg-base-800 p-3">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!bot.canType}
          placeholder="Escribe aquí..."
          className="flex-1 rounded-xl border-none bg-base-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!bot.canType || !draft.trim()}
          aria-label="Enviar mensaje"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-5 w-5" aria-hidden />
        </button>
      </form>
    </div>
  );
}
