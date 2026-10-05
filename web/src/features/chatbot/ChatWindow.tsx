import { useState, type FormEvent } from 'react';
import { RotateCcw, Send, X, ShoppingCart, MessageSquare } from 'lucide-react';
import { useDualBotConfig } from './useChatbotConfig';
import { ChatMessageList } from './ChatMessageList';
import type { useRefillChatBot } from './useRefillChatBot';
import type { useSupportChatBot } from './useSupportChatBot';

type RefillBot = ReturnType<typeof useRefillChatBot>;
type SupportBot = ReturnType<typeof useSupportChatBot>;

interface ChatWindowProps {
  refillBot: RefillBot;
  supportBot: SupportBot;
  onClose: () => void;
}

export function ChatWindow({ refillBot, supportBot, onClose }: ChatWindowProps) {
  const dualConfig = useDualBotConfig();
  const [draft, setDraft] = useState('');
  
  const isRefillEnabled = dualConfig.chatbot.enabled;
  const isSupportEnabled = dualConfig.supportBot.enabled;
  
  const [activeTab, setActiveTab] = useState<'refill' | 'support'>(isRefillEnabled ? 'refill' : 'support');

  const bot = activeTab === 'refill' ? refillBot : supportBot;
  const config = activeTab === 'refill' ? dualConfig.chatbot : dualConfig.supportBot;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!bot.canType || !draft.trim()) return;
    bot.sendText(draft);
    setDraft('');
  };

  const showTabs = isRefillEnabled && isSupportEnabled;

  return (
    <div
      role="dialog"
      aria-label="Asistente virtual"
      className="fixed inset-0 z-[60] flex flex-col bg-base-900 md:inset-auto md:bottom-6 md:right-6 md:h-[560px] md:max-h-[calc(100dvh-3rem)] md:w-[380px] md:overflow-hidden md:rounded-2xl md:border md:border-base-600 md:shadow-2xl"
    >
      <style>{`
        @media (max-width: 768px) {
          [class*="elfsight-app-"],
          [id*="whatsapp-widget"],
          [class*="whatsapp-floating"],
          [id*="gb-widget"] {
            display: none !important;
          }
        }
      `}</style>

      {showTabs && (
        <div className="flex bg-base-900 p-1">
          <button
            onClick={() => setActiveTab('refill')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-xs font-bold transition-colors ${
              activeTab === 'refill' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:bg-base-800'
            }`}
          >
            <ShoppingCart className="h-4 w-4" /> Recargas
          </button>
          <button
            onClick={() => setActiveTab('support')}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2 text-xs font-bold transition-colors ${
              activeTab === 'support' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:bg-base-800'
            }`}
          >
            <MessageSquare className="h-4 w-4" /> Preguntas
          </button>
        </div>
      )}

      <header className={`safe-top flex items-center gap-3 px-4 py-3 text-white ${activeTab === 'refill' ? 'bg-emerald-700' : 'bg-blue-700'}`}>
        {config.avatarUrl ? (
          <img
            src={config.avatarUrl}
            alt=""
            className="h-9 w-9 shrink-0 rounded-full bg-white/20 object-cover"
          />
        ) : (
          <img
            src="/brand/emblem-128.png"
            alt=""
            className="h-9 w-9 shrink-0 rounded-full bg-white/20 object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold leading-tight">{config.name}</p>
          <p className="text-xs text-white/80">{bot.isTyping ? 'escribiendo...' : 'en línea'}</p>
        </div>
        <button
          type="button"
          onClick={bot.reset}
          aria-label="Reiniciar conversación"
          className={`rounded-full p-2 transition-colors ${activeTab === 'refill' ? 'hover:bg-emerald-600' : 'hover:bg-blue-600'}`}
        >
          <RotateCcw className="h-5 w-5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar asistente"
          className={`rounded-full p-2 transition-colors ${activeTab === 'refill' ? 'hover:bg-emerald-600' : 'hover:bg-blue-600'}`}
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </header>

      <ChatMessageList messages={bot.messages} isTyping={bot.isTyping} onSelectOption={bot.selectOption} />

      <form onSubmit={handleSubmit} className="flex items-end gap-2 border-t border-base-600 bg-base-800 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!bot.canType}
          placeholder={bot.inputPlaceholder || 'Escribe aquí...'}
          className="flex-1 rounded-xl border-none bg-base-900 px-4 py-3 text-sm outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!bot.canType || !draft.trim()}
          aria-label="Enviar mensaje"
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition disabled:cursor-not-allowed disabled:opacity-50 ${
            activeTab === 'refill' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-blue-600 hover:bg-blue-500'
          }`}
        >
          <Send className="h-5 w-5" aria-hidden />
        </button>
      </form>
    </div>
  );
}
