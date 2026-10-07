import { configDoc, now, privateChatbotConfigDoc } from '../config/firebase';
import { FieldValue } from 'firebase-admin/firestore';
import { GEMINI_API_KEY, geminiModel } from '../config/env';
import { failedPrecondition, providerError } from '../lib/errors';
import { log } from '../lib/logger';
import { belongsToStorefront, type Storefront } from '../lib/storefront';
import type { AppConfig, ChatbotProfile, Game, Product } from '../types/models';
import { buildSupportSystemInstruction, parseSupportAnswer } from './chatbotPrompt';
import { getConfig, invalidateConfigCache } from './settings';
import * as catalog from './catalog';
import { buildSupportUrl } from './whatsapp';

export interface AdminChatbotConfig {
  chatbot: ChatbotProfile;
  supportBot: ChatbotProfile & { instructions: string };
}

export interface AdminChatbotSettings {
  config: AdminChatbotConfig;
  configured: boolean;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

const PRIVATE_INSTRUCTIONS_MAX_LENGTH = 10_000;
const MAX_RELEVANT_GAMES = 4;

function defaults(config: AppConfig): AdminChatbotConfig {
  return {
    chatbot: config.chatbot,
    supportBot: { ...config.supportBot, instructions: '' },
  };
}

export async function getAdminChatbotSettings(): Promise<AdminChatbotSettings> {
  const [config, publicSnapshot, privateSnapshot] = await Promise.all([
    getConfig({ fresh: true }),
    configDoc().get(),
    privateChatbotConfigDoc().get(),
  ]);
  const base = defaults(config);
  const privateData = privateSnapshot.data();
  const supportBot = privateData?.supportBot as Partial<AdminChatbotConfig['supportBot']> | undefined;

  return {
    config: {
      chatbot: base.chatbot,
      supportBot: {
        ...base.supportBot,
        ...(supportBot ?? {}),
        instructions: typeof supportBot?.instructions === 'string' ? supportBot.instructions : '',
      },
    },
    configured: Boolean(
      publicSnapshot.get('chatbot') || publicSnapshot.get('supportBot') || privateSnapshot.exists
    ),
  };
}

export async function saveAdminChatbotConfig(
  input: AdminChatbotConfig,
  updatedBy: string
): Promise<AdminChatbotConfig> {
  const instructions = input.supportBot.instructions.trim().slice(0, PRIVATE_INSTRUCTIONS_MAX_LENGTH);
  const timestamp = now();

  await configDoc().firestore.runTransaction(async (transaction) => {
    transaction.set(
      configDoc(),
      {
        chatbot: input.chatbot,
        supportBot: {
          enabled: input.supportBot.enabled,
          name: input.supportBot.name,
          avatarUrl: input.supportBot.avatarUrl,
          welcomeMessage: input.supportBot.welcomeMessage,
          instructions: FieldValue.delete(),
        },
        updatedAt: timestamp,
        updatedBy,
      },
      { merge: true }
    );
    transaction.set(
      privateChatbotConfigDoc(),
      { supportBot: { instructions }, updatedAt: timestamp, updatedBy },
      { merge: true }
    );
  });

  invalidateConfigCache();
  return (await getAdminChatbotSettings()).config;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchingGames(query: string, games: Game[]): Game[] {
  const normalizedQuery = normalizeText(query);
  const queryTokens = new Set(normalizedQuery.split(/\s+/).filter((token) => token.length >= 3));
  const matches = games.filter((game) => {
    const name = normalizeText(`${game.name} ${game.shortName} ${game.id}`);
    return name.length > 0 && (normalizedQuery.includes(name) || [...queryTokens].some((token) => name.includes(token)));
  });
  return matches.slice(0, MAX_RELEVANT_GAMES);
}

function summarizeProduct(product: Product, game: Game, rate: number, roundToBs: number): string {
  const publicProduct = catalog.toPublicProduct(product, rate, roundToBs);
  const amount = publicProduct.amount + publicProduct.bonus;
  return [
    `${game.name}: ${publicProduct.name}`,
    publicProduct.badge ? `etiqueta ${publicProduct.badge}` : '',
    `USD ${publicProduct.priceUsd}`,
    `Bs ${publicProduct.priceBs}`,
    amount > 0 ? `entrega ${amount} ${game.currencyLabel}` : '',
    `modalidad ${publicProduct.fulfillment === 'manual' ? 'manual' : 'automática'}`,
    publicProduct.stock === 0 ? 'sin stock' : '',
  ].filter(Boolean).join(', ');
}

function paymentContext(config: AppConfig): { methods: string[]; details: string[] } {
  const methods = ['Pago Móvil'];
  const details = [
    `Pago Móvil: ${config.bank.name}, código ${config.bank.code}, titular ${config.bank.holder}, documento ${config.bank.idNumber}, teléfono ${config.bank.phone}`,
  ];

  if (config.transfer.enabled) {
    methods.push('transferencia bancaria');
    details.push(
      `Transferencia: ${config.transfer.name}, código ${config.transfer.code}, titular ${config.transfer.holder}, documento ${config.transfer.idNumber}, cuenta ${config.transfer.accountNumber}`
    );
  }
  if (config.binancePay.enabled) {
    methods.push('Binance Pay');
    details.push(`Binance Pay ID: ${config.binancePay.payId}`);
  }
  if (config.checkout.walletEnabled) methods.push('saldo de la billetera');
  return { methods, details };
}

export async function answerSupportQuestion(
  history: ChatHistoryMessage[],
  storefront: Storefront
): Promise<{ reply: string; needsSupport: boolean }> {
  const apiKey = GEMINI_API_KEY.value().trim();
  if (!apiKey) throw providerError('El asistente está temporalmente fuera de servicio.');

  const config = await getConfig();
  if (!config.supportBot.enabled) {
    throw failedPrecondition('El asistente de preguntas está desactivado.');
  }

  const [privateSnapshot, allGames] = await Promise.all([
    privateChatbotConfigDoc().get(),
    catalog.listGames({ onlyActive: true }),
  ]);

  const questionContext = history
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join(' ');
  const relevantGames = matchingGames(questionContext, allGames)
    .filter((game) => belongsToStorefront(game, storefront));
  const productsForGames = await Promise.all(
    relevantGames.map(async (game) => ({
      game,
      products: await catalog.listProducts({ gameId: game.id, onlyActive: true }),
    }))
  );
  const currentProducts = productsForGames.flatMap(({ game, products }) =>
    products
      .filter((product) => product.stock !== 0)
      .slice(0, 30)
      .map((product) => summarizeProduct(product, game, config.rate.value, config.pricing.roundToBs))
  );
  const visibleGames = allGames
    .filter((game) => belongsToStorefront(game, storefront))
    .map((game) => `${game.name}${game.providerFamily ? ` (${game.providerFamily})` : ''}`);
  const payment = paymentContext(config);
  const privateInstructions = privateSnapshot.data()?.supportBot as { instructions?: unknown } | undefined;
  const systemInstruction = buildSupportSystemInstruction({
    storeName: config.storeName,
    tagline: config.tagline,
    rate: config.rate.value,
    paymentMethods: payment.methods,
    paymentDetails: payment.details,
    orderExpiryMinutes: config.checkout.orderExpiryMinutes,
    referenceMinLength: config.checkout.referenceMinLength,
    referenceMaxLength: config.checkout.referenceMaxLength,
    supportUrl: buildSupportUrl(config.whatsapp.supportNumber),
    customInformation:
      typeof privateInstructions?.instructions === 'string'
        ? privateInstructions.instructions.slice(0, PRIVATE_INSTRUCTIONS_MAX_LENGTH)
        : '',
    games: visibleGames,
    matchingProducts: currentProducts,
  });

  const model = geminiModel();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: history.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: {
          maxOutputTokens: 500,
          thinkingConfig: { thinkingLevel: 'low' },
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              reply: { type: 'STRING' },
              needsSupport: { type: 'BOOLEAN' },
            },
            required: ['reply', 'needsSupport'],
          },
        },
      }),
    });
  } catch (error) {
    log.warn('No se pudo conectar con Gemini', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
    throw providerError('El asistente no está disponible en este momento.');
  }

  if (!response.ok) {
    log.warn('Gemini respondió con error', { status: response.status, model });
    throw providerError('El asistente no está disponible en este momento.');
  }

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  const rawAnswer = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? '')
    .join('')
    .trim();
  if (!rawAnswer) {
    log.warn('Gemini no devolvió texto utilizable', {
      finishReason: payload.candidates?.[0]?.finishReason ?? 'unknown',
    });
    throw providerError('El asistente no está disponible en este momento.');
  }

  return parseSupportAnswer(rawAnswer);
}
