import { useState, useRef, useCallback, useEffect } from 'react';
import { useConfig } from '@/providers/ConfigProvider';
import { useDualBotConfig } from './useChatbotConfig';
import { openWhatsapp } from '@/lib/utils';
import { ChatMessage, ChatOption } from './types';

export function useSupportChatBot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const nextId = useRef(1);
  const timers = useRef<NodeJS.Timeout[]>([]);
  const started = useRef(false);

  const { config } = useConfig();
  const dualConfig = useDualBotConfig();

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const push = useCallback((msg: Omit<ChatMessage, 'id' | 'timestamp'>) => {
    setMessages((prev) => [
      ...prev,
      {
        ...msg,
        id: nextId.current++,
        timestamp: new Date(),
      },
    ]);
  }, []);

  const botSay = useCallback(
    (queue: { text: string; actions?: ChatOption[] }[], onDone?: () => void) => {
      setIsTyping(true);
      let cumulativeDelay = 0;

      queue.forEach((item, index) => {
        cumulativeDelay += index === 0 ? 800 : Math.min(2500, Math.max(1000, item.text.length * 30));
        const timer = setTimeout(() => {
          push({ from: 'bot', text: item.text, actions: item.actions });
          if (index === queue.length - 1) {
            setIsTyping(false);
            onDone?.();
          }
        }, cumulativeDelay);
        timers.current.push(timer);
      });
      
      if (queue.length === 0) {
        setIsTyping(false);
        onDone?.();
      }
    },
    [push]
  );

  const start = useCallback(() => {
    if (started.current) return;
    started.current = true;
    
    botSay([
      {
        text: dualConfig.supportBot.welcomeMessage,
      },
    ]);
  }, [botSay, dualConfig.supportBot.welcomeMessage]);

  const selectOption = (actionId: string) => {
    if (actionId === 'wa') {
      push({ from: 'user', text: 'Contactar por WhatsApp' });
      if (config?.supportUrl) {
        openWhatsapp(config.supportUrl);
      }
    }
  };

  const processQuery = (text: string) => {
    const lower = text.toLowerCase();
    const instructions = dualConfig.supportBot.instructions;
    
    let answer = '';
    let addWa = false;

    if (lower.includes('pago') || lower.includes('binance') || lower.includes('movil') || lower.includes('transferencia')) {
      answer = 'Aceptamos Pago Móvil, Binance Pay (USDT) y transferencias bancarias nacionales. Si recargas saldo a favor en tu billetera, puedes pagar directamente desde allí. ' + instructions;
    } else if (lower.includes('tasa') || lower.includes('dolar') || lower.includes('bs')) {
      answer = `Nuestra tasa actual es de ${config?.rate || 0} Bs por dólar. Puedes verificarla en cualquier momento al iniciar una compra.`;
    } else if (lower.includes('tiempo') || lower.includes('demora') || lower.includes('tarda')) {
      answer = 'La mayoría de nuestras recargas (como Free Fire) son automáticas y se completan en segundos tras confirmar el pago.';
    } else if (lower.includes('juegos') || lower.includes('lista') || lower.includes('disponible')) {
      answer = 'Puedes ver nuestro catálogo completo haciendo clic en el carrito superior, o cambiando al Asistente de Recargas.';
    } else {
      answer = `Gracias por tu pregunta. Te recomendamos revisar el catálogo. ${instructions ? '\\n\\nNota: ' + instructions : ''}`;
      addWa = true;
    }

    const actions = addWa ? [{ id: 'wa', label: '💬 Hablar con soporte humano' }] : undefined;

    botSay([{ text: answer, actions }]);
  };

  const sendText = (raw: string) => {
    const text = raw.trim();
    if (!text || isTyping) return;

    push({ from: 'user', text });
    processQuery(text);
  };

  const reset = () => {
    clearTimers();
    setIsTyping(false);
    setMessages([]);
    nextId.current = 1;
    started.current = false;
    start();
  };

  useEffect(() => clearTimers, [clearTimers]);

  return {
    messages,
    isTyping,
    canType: !isTyping,
    inputPlaceholder: 'Escribe tu pregunta...',
    inputType: 'text' as const,
    inputMode: 'text' as const,
    start,
    reset,
    selectOption,
    sendText,
  };
}

