import { useConfig } from '@/providers/ConfigProvider';

export interface ChatbotConfig {
  enabled: boolean;
  name: string;
  avatarUrl?: string;
  welcomeMessage: string;
}

export interface SupportBotConfig {
  enabled: boolean;
  name: string;
  avatarUrl?: string;
  welcomeMessage: string;
  instructions: string;
}

export interface DualBotConfig {
  chatbot: ChatbotConfig;
  supportBot: SupportBotConfig;
}

export function getLocalDualBotConfig(): DualBotConfig | null {
  try {
    const local = localStorage.getItem('refill_dualbot_config');
    if (local) {
      return JSON.parse(local) as DualBotConfig;
    }
  } catch {
    // ignore parsing errors
  }
  return null;
}

export function useDualBotConfig(): DualBotConfig {
  const { config } = useConfig();
  const local = getLocalDualBotConfig();

  return (
    local ?? {
      chatbot: config?.chatbot ?? {
        enabled: true,
        name: 'Asistente Refill',
        welcomeMessage: '¡Hola! 🤖 Soy el asistente de Refill Store. Te guío paso a paso con tu recarga.',
      },
      supportBot: config?.supportBot ?? {
        enabled: true,
        name: 'Soporte Refill',
        welcomeMessage: '¡Hola! 💬 Soy el asistente de soporte. ¿En qué te puedo ayudar hoy?',
        instructions: 'Eres el asistente de soporte de Refill Store...',
      },
    }
  );
}
