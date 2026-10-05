import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ChatFloatingButton } from './ChatFloatingButton';
import { ChatWindow } from './ChatWindow';
import { useRefillChatBot } from './useRefillChatBot';
import { useSupportChatBot } from './useSupportChatBot';
import { useDualBotConfig } from './useChatbotConfig';

export function RefillChatbot() {
  const [open, setOpen] = useState(false);
  const refillBot = useRefillChatBot();
  const supportBot = useSupportChatBot();
  const { pathname } = useLocation();
  const dualConfig = useDualBotConfig();

  const isRefillEnabled = dualConfig.chatbot.enabled;
  const isSupportEnabled = dualConfig.supportBot.enabled;

  if (pathname.startsWith('/comprar') || (!isRefillEnabled && !isSupportEnabled)) return null;

  const openChat = () => {
    setOpen(true);
    if (isRefillEnabled) refillBot.start();
    if (isSupportEnabled) supportBot.start();
  };

  return open ? (
    <ChatWindow 
      refillBot={refillBot} 
      supportBot={supportBot} 
      onClose={() => setOpen(false)} 
    />
  ) : (
    <ChatFloatingButton onClick={openChat} />
  );
}
