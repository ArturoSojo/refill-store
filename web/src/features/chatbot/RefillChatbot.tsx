import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChatFloatingButton } from './ChatFloatingButton';
import { ChatWindow } from './ChatWindow';
import { useRefillChatBot } from './useRefillChatBot';
import { useChatbotConfig } from './useChatbotConfig';

/** Punto de entrada del asistente: botón flotante + ventana de chat. */
export function RefillChatbot() {
  const [open, setOpen] = useState(false);
  const bot = useRefillChatBot();
  const { pathname } = useLocation();
  const chatbotConfig = useChatbotConfig();

  // En el checkout lo importante es el monto y la referencia: no se tapa.
  if (pathname.startsWith('/comprar') || chatbotConfig.enabled === false) return null;

  const openChat = () => {
    setOpen(true);
    bot.start();
  };

  return open ? (
    <ChatWindow bot={bot} onClose={() => setOpen(false)} />
  ) : (
    <ChatFloatingButton onClick={openChat} />
  );
}
