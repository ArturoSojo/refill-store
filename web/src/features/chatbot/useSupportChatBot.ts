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
    
    let answer = '';
    let addWa = false;

    // Intent: Métodos de pago
    if (/(pago|pagar|método|metodo|binance|movil|móvil|transferencia|tarjeta)/i.test(lower)) {
      answer = 'Aceptamos **Pago Móvil**, **Binance Pay (USDT)** y transferencias bancarias nacionales. También puedes depositar saldo a favor en tu billetera virtual y pagar directamente desde ahí.';
    } 
    // Intent: Tasa / Precios
    else if (/(tasa|dolar|dólar|bs|bolivar|bolívar|precio)/i.test(lower)) {
      answer = 'Nuestra tasa actual es de **' + (config?.rate || 0) + ' Bs por dólar**. Puedes verificarla en la cabecera de la página o al iniciar el flujo de cualquier compra.';
    } 
    // Intent: Tiempos / Demoras
    else if (/(tiempo|demora|tarda|espera|rápido|rapido)/i.test(lower)) {
      answer = '¡Las recargas son casi instantáneas! La mayoría de nuestros juegos (como Free Fire o Mobile Legends) se completan en **cuestión de segundos** tras la confirmación de tu pago.';
    } 
    // Intent: Catálogo / Juegos disponibles
    else if (/(juegos|lista|disponible|catálogo|catalogo|free fire|robux)/i.test(lower)) {
      answer = 'Contamos con un amplio catálogo incluyendo **Free Fire, Mobile Legends, Robux, y Gift Cards**. Cambia a la pestaña de **Recargas** o navega por nuestra página principal para verlos todos.';
    } 
    // Intent: Ayuda general / Hola
    else if (/(hola|buenas|saludos|ayuda)/i.test(lower)) {
      answer = '¡Hola! Estoy aquí para resolver tus dudas sobre la plataforma. Pregúntame sobre métodos de pago, nuestra tasa, o cómo funciona el proceso de recarga.';
    }
    // Fallback / Desconocido
    else {
      answer = 'Entiendo. Para consultas más específicas sobre pedidos particulares o problemas técnicos, te recomendamos contactar directamente a un agente humano.';
      addWa = true;
    }

    const actions = addWa ? [{ id: 'wa', label: '💬 Hablar con Soporte Humano' }] : undefined;

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


