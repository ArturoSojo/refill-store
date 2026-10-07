import { useConfig } from '@/providers/ConfigProvider';
import type { ChatbotProfile } from '@/types/models';

export type ChatbotConfig = ChatbotProfile;

export interface SupportBotConfig extends ChatbotProfile {
  instructions: string;
}

export interface PublicDualBotConfig {
  chatbot: ChatbotConfig;
  supportBot: ChatbotConfig;
}

export interface AdminDualBotConfig {
  chatbot: ChatbotConfig;
  supportBot: SupportBotConfig;
}

export function useDualBotConfig(): PublicDualBotConfig {
  const { config } = useConfig();

  return {
    chatbot: config?.chatbot ?? {
      enabled: true,
      name: 'Asistente Refill',
      avatarUrl: '',
      welcomeMessage: '¡Hola! 🤖 Soy el asistente de Refill Store. Te guío paso a paso con tu recarga.',
    },
    supportBot: config?.supportBot ?? {
      enabled: true,
      name: 'Soporte Refill',
      avatarUrl: '',
      welcomeMessage: '¡Hola! 💬 Soy el asistente de soporte. ¿En qué te puedo ayudar hoy?',
    },
  };
}
