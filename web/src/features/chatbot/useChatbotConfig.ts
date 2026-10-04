import { useConfig } from '@/providers/ConfigProvider';

export interface ChatbotConfig {
  enabled: boolean;
  name: string;
  welcomeMessage: string;
}

export function getLocalChatbotConfig(): ChatbotConfig | null {
  try {
    const local = localStorage.getItem('refill_chatbot_config');
    if (local) {
      return JSON.parse(local) as ChatbotConfig;
    }
  } catch {
    // ignore parsing errors
  }
  return null;
}

export function useChatbotConfig(): ChatbotConfig {
  const { config } = useConfig();
  const local = getLocalChatbotConfig();

  return (
    local ??
    config?.chatbot ?? {
      enabled: true,
      name: 'Asistente Refill',
      welcomeMessage:
        '¡Hola! 👋 Soy el asistente de Refill Store. Te guío paso a paso con tu recarga.',
    }
  );
}
