import { useState, useRef, useCallback, useEffect } from 'react';
import { useConfig } from '@/providers/ConfigProvider';
import { useDualBotConfig } from './useChatbotConfig';
import { openWhatsapp } from '@/lib/utils';
import { ChatMessage, ChatOption } from './types';
import { api } from '@/lib/api';

export function useSupportChatBot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const nextId = useRef(1);
  const timers = useRef<NodeJS.Timeout[]>([]);
  const started = useRef(false);
  const requestGeneration = useRef(0);
  const conversation = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);

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

  const sendText = (raw: string) => {
    const text = raw.trim();
    if (!text || isTyping) return;

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...conversation.current,
      { role: 'user' as const, content: text },
    ].slice(-12);
    while (history[0]?.role === 'assistant') history.shift();
    const generation = requestGeneration.current;

    push({ from: 'user', text });
    setIsTyping(true);

    void api
      .post<{ reply: string; needsSupport: boolean; action?: 'start_recharge' | 'view_orders' }>('/chatbot/answer', { messages: history })
      .then((answer) => {
        if (generation !== requestGeneration.current) return;
        const nextConversation: Array<{ role: 'user' | 'assistant'; content: string }> = [
          ...history,
          { role: 'assistant' as const, content: answer.reply },
        ].slice(-12);
        conversation.current = nextConversation;
        while (conversation.current[0]?.role === 'assistant') conversation.current.shift();
        push({
          from: 'bot',
          text: answer.reply,
          actions: answer.action === 'start_recharge'
            ? [{ id: 'start_recharge', label: '🛒 Empezar recarga' }]
            : answer.action === 'view_orders'
              ? [{ id: 'view_orders', label: '📋 Ver mis órdenes' }]
              : answer.needsSupport
                ? [{ id: 'wa', label: '💬 Hablar con Soporte Humano' }]
                : undefined,
        });
      })
      .catch(() => {
        if (generation !== requestGeneration.current) return;
        push({
          from: 'bot',
          text: 'Ahora mismo no puedo responder. Puedes escribirnos por WhatsApp y te ayudamos.',
          actions: [{ id: 'wa', label: '💬 Hablar con Soporte Humano' }],
        });
      })
      .finally(() => {
        if (generation === requestGeneration.current) setIsTyping(false);
      });
  };

  const reset = () => {
    requestGeneration.current += 1;
    conversation.current = [];
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
