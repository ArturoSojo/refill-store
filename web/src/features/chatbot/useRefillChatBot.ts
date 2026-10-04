/**
 * Máquina de estados del asistente de recargas.
 *
 * Reutiliza los hooks y funciones reales de la tienda, sin duplicar lógica:
 *   - `useCatalog` / `useFamilyCatalog`: juegos por categoría y base de la búsqueda.
 *   - `useGameCatalog(slug)`: paquetes del juego elegido.
 *   - `gameFields` / `fieldsAreValid` / `cleanValues`: datos de cuenta de cada juego.
 *   - `useCreateOrder`: crea la orden real y congela la tasa.
 *   - `useVerifyPayment` + `useLiveOrder`: verifica la referencia y sigue la orden en vivo.
 *
 * Flujo: bienvenida → categoría → juego → paquete → datos del jugador → resumen →
 * (sesión) → método de pago → orden → referencia → verificación → entrega.
 * En cualquier momento previo al pago el cliente puede escribir para buscar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { groupProducts, useCatalog, useFamilyCatalog, useGameCatalog } from '@/hooks/useCatalog';
import {
  useCancelOrder,
  useCreateOrder,
  useLiveOrder,
  useVerifyPayment,
} from '@/hooks/useOrders';
import { cleanValues, fieldsAreValid, gameFields } from '@/features/catalog/PlayerFields';
import { useAuth } from '@/providers/AuthProvider';
import { useConfig } from '@/providers/ConfigProvider';
import { api, ApiError, isGatewayTimeout } from '@/lib/api';
import { readCreatorCode } from '@/lib/creatorCode';
import { formatBs, formatUsd } from '@/lib/format';
import { errorMessage, openWhatsapp } from '@/lib/utils';
import { matchCategory, searchGames } from './fuzzy';
import { useChatbotConfig } from './useChatbotConfig';
import {
  PHONE_PATTERN,
  liveOrderMessages,
  methodLabel,
  paymentInstructionMessages,
  paymentMethodOptions,
  referenceRules,
} from './paymentMessages';
import type { CreateOrderResponse, Game, Order, PublicProduct } from '@/types/models';
import type { ChatFamily, ChatMessage, ChatOption, ChatPaymentMethod, ChatStep } from './types';

/** Pausa simulada de «escribiendo…» antes de cada respuesta del bot. */
const BOT_DELAY_MS = 500;
const PAGE_SIZE = 6;
/** Tamaño de página al descargar el catálogo de una categoría (misma clave de caché en todo el chat). */
const POOL_PAGE_SIZE = 50;
/** Tope de juegos descargados por categoría, para no pedir catálogos sin fin. */
const MAX_POOL_GAMES = 600;

const FAMILIES: ChatFamily[] = ['topup', 'gift_card', 'game_key'];

const CATEGORY_OPTIONS: ChatOption[] = [
  { id: 'cat:topup', label: '🎮 Juegos' },
  { id: 'cat:gift_card', label: '🎁 Gift Cards' },
  { id: 'cat:game_key', label: '🔑 Game Keys' },
];

const CATEGORY_LABEL: Record<ChatFamily, string> = {
  topup: 'juegos',
  gift_card: 'gift cards',
  game_key: 'game keys',
};

const MENU_ACTION: ChatOption = { id: 'menu', label: '⬅️ Menú principal' };

type Pending =
  | { kind: 'category'; family: ChatFamily }
  | { kind: 'search'; text: string }
  | { kind: 'packages' };

interface PagedList<T> {
  items: T[];
  shown: number;
}

function gameCards(games: Game[]): ChatOption[] {
  return games.map((game) => ({
    id: `game:${game.id}`,
    label: game.name,
    accent: game.accentColor || undefined,
    imageUrl: game.logoUrl || undefined,
    hint: game.minPriceUsd != null ? `Desde ${formatUsd(game.minPriceUsd)}` : undefined,
  }));
}

function productCards(products: PublicProduct[]): ChatOption[] {
  return products.map((product) => ({
    id: `pkg:${product.id}`,
    label: product.badge ? `${product.name} · ${product.badge}` : product.name,
    hint: `${formatUsd(product.priceUsd)} · ${formatBs(product.priceBs)}`,
  }));
}

export function useRefillChatBot() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [step, setStep] = useState<ChatStep>('welcome');
  const [isTyping, setIsTyping] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const [game, setGame] = useState<Game | null>(null);
  const [product, setProduct] = useState<PublicProduct | null>(null);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  // Fase 3: pago.
  const [busy, setBusy] = useState(false);
  const [contactPhone, setContactPhone] = useState('');
  const [orderData, setOrderData] = useState<CreateOrderResponse | null>(null);
  const [finalOrder, setFinalOrder] = useState<Order | null>(null);
  const [attempts, setAttempts] = useState(0);
  const lastAnnounced = useRef<string | null>(null);

  const { user, me, signInWithGoogle } = useAuth();
  const { config } = useConfig();
  const createOrder = useCreateOrder();
  const verifyPayment = useVerifyPayment(orderData?.order.id);
  const cancelOrder = useCancelOrder();
  // Mientras el despacho está en curso el estado cambia solo: se escucha en vivo.
  const liveOrder = useLiveOrder(finalOrder?.id, finalOrder ?? undefined);

  const nextId = useRef(1);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const started = useRef(false);
  const gameList = useRef<PagedList<Game>>({ items: [], shown: 0 });
  const productList = useRef<PagedList<PublicProduct>>({ items: [], shown: 0 });

  // ---------------------------------------------------------------------------
  // Datos reales del catálogo
  // ---------------------------------------------------------------------------

  const catalog = useCatalog();

  // Las categorías se descargan bajo demanda: al tocar una, o todas al buscar.
  const [enabledFamilies, setEnabledFamilies] = useState<ChatFamily[]>([]);
  const topup = useFamilyCatalog('topup', POOL_PAGE_SIZE, enabledFamilies.includes('topup'));
  const giftCards = useFamilyCatalog('gift_card', POOL_PAGE_SIZE, enabledFamilies.includes('gift_card'));
  const gameKeys = useFamilyCatalog('game_key', POOL_PAGE_SIZE, enabledFamilies.includes('game_key'));
  const familyQueries = { topup, gift_card: giftCards, game_key: gameKeys };

  const gameCatalog = useGameCatalog(game?.id);

  // La categoría está lista cuando se descargaron todas sus páginas (o falló).
  const ready = Object.fromEntries(
    FAMILIES.map((family) => {
      const query = familyQueries[family];
      const done =
        enabledFamilies.includes(family) &&
        !query.isLoading &&
        (Boolean(query.error) ||
          (query.data !== undefined &&
            !query.isFetching &&
            (!query.hasMore || query.data.games.length >= MAX_POOL_GAMES)));
      return [family, done];
    })
  ) as Record<ChatFamily, boolean>;
  const readyKey = FAMILIES.map((family) => (ready[family] ? '1' : '0')).join('');

  // Descarga las páginas restantes de las categorías activas, una a una.
  useEffect(() => {
    FAMILIES.forEach((family) => {
      const query = familyQueries[family];
      if (
        enabledFamilies.includes(family) &&
        query.hasMore &&
        !query.isFetching &&
        !query.error &&
        (query.data?.games.length ?? 0) < MAX_POOL_GAMES
      ) {
        query.loadMore();
      }
    });
  });

  /** Todos los juegos conocidos, sin repetir, ordenados como en la tienda. */
  const buildPool = (): Game[] => {
    const unique = new Map<string, Game>();
    [
      ...(topup.data?.games ?? []),
      ...(giftCards.data?.games ?? []),
      ...(gameKeys.data?.games ?? []),
      ...(catalog.data?.games ?? []),
    ].forEach((item) => {
      if (!unique.has(item.id)) unique.set(item.id, item);
    });
    return [...unique.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  };

  // ---------------------------------------------------------------------------
  // Utilidades de mensajes
  // ---------------------------------------------------------------------------

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const push = (message: Omit<ChatMessage, 'id'>) => {
    setMessages((current) => [...current, { ...message, id: nextId.current++ }]);
  };

  /** Encola mensajes del bot con retardo, mostrando el indicador de escritura. */
  const botSay = (items: Omit<ChatMessage, 'id' | 'from'>[], onDone?: () => void) => {
    setIsTyping(true);
    items.forEach((item, index) => {
      const timer = setTimeout(() => {
        push({ ...item, from: 'bot' });
        if (index === items.length - 1) {
          setIsTyping(false);
          onDone?.();
        }
      }, BOT_DELAY_MS * (index + 1));
      timers.current.push(timer);
    });
  };

  // ---------------------------------------------------------------------------
  // Pasos
  // ---------------------------------------------------------------------------

  const askCategory = (intro?: string) => {
    setStep('menu');
    setGame(null);
    setProduct(null);
    botSay([
      {
        text: intro ?? '¿Qué quieres recargar?',
        options: CATEGORY_OPTIONS,
        optionsVariant: 'buttons',
      },
    ]);
  };

  /** Muestra la siguiente página de la lista de juegos activa. */
  const showGamePage = (text: string, extraActions: ChatOption[] = []) => {
    const list = gameList.current;
    const page = list.items.slice(list.shown, list.shown + PAGE_SIZE);
    list.shown += page.length;
    const remaining = list.items.length - list.shown;

    setStep('games');
    botSay([
      {
        text,
        options: gameCards(page),
        optionsVariant: 'games',
        actions: [
          ...(remaining > 0 ? [{ id: 'more:games', label: `Ver más (${remaining})` }] : []),
          ...extraActions,
          MENU_ACTION,
        ],
      },
    ]);
  };

  const presentGames = (items: Game[], text: string, extraActions: ChatOption[] = []) => {
    gameList.current = { items, shown: 0 };
    showGamePage(text, extraActions);
  };

  const showProductPage = (text: string) => {
    const list = productList.current;
    const page = list.items.slice(list.shown, list.shown + PAGE_SIZE);
    list.shown += page.length;
    const remaining = list.items.length - list.shown;

    setStep('packages');
    botSay([
      {
        text,
        options: productCards(page),
        optionsVariant: 'list',
        actions: [
          ...(remaining > 0 ? [{ id: 'more:packages', label: `Ver más (${remaining})` }] : []),
          { id: 'back:games', label: '⬅️ Cambiar de juego' },
          MENU_ACTION,
        ],
      },
    ]);
  };

  const askField = (selected: Game, index: number, prefix?: string) => {
    const field = gameFields(selected)[index];
    if (!field) return;
    const hint = field.placeholder ? ` (${field.placeholder})` : '';
    const optional = field.required ? '' : ' Es opcional: escribe «no» para omitirlo.';
    setStep('fields');
    botSay([
      {
        text: `${prefix ?? ''}Escribe tu ${field.label}${hint}.${optional}`,
        actions: [MENU_ACTION],
      },
    ]);
  };

  const verifyPlayerAndFinish = async (selected: Game, chosen: PublicProduct, values: Record<string, string>) => {
    const isFreeFire = selected.id === 'free-fire' || (selected as any).slug === 'free-fire' || selected.id === 'freefire' || selected.name?.toLowerCase().includes('free fire');
    const validatesPlayerId = selected.validatesPlayerId === true;
    
    if (isFreeFire || validatesPlayerId) {
      const playerIdKey = gameFields(selected).find(f => f.key === 'playerId' || f.key.toLowerCase().includes('id'))?.key || gameFields(selected)[0]?.key;
      const playerId = playerIdKey ? values[playerIdKey] : null;

      if (playerId) {
        console.log('[ChatBot] Verificando jugador:', { gameId: selected.id, playerId });
        
        setBusy(true);
        push({ from: 'bot', text: '🔍 Verificando cuenta...', progress: true });
        try {
          const result = await api.post<{
            valid: boolean;
            playerName: string | null;
            region: string | null;
          }>(`/games/${encodeURIComponent(selected.id)}/validate-player`, { playerId });
          
          setBusy(false);
          if (!result.valid) {
            setStep('fields');
            setFieldValues({});
            setFieldIndex(0);
            botSay([
              {
                text: `❌ No pudimos encontrar ninguna cuenta con el ID ${playerId}. Por favor verifica tu ID e ingrésalo nuevamente o pulsa en Soporte.`,
                actions: [
                  { id: 'wa', label: '💬 Soporte' },
                  MENU_ACTION,
                ],
              },
            ]);
            return;
          }

          const namePart = result.playerName || 'Desconocido';
          const regionPart = result.region ? ` (${result.region})` : '';
          const verifiedName = `${namePart}${regionPart}`;
          push({ from: 'bot', text: `✅ Cuenta verificada: ${verifiedName}` });
          
          values['_nick'] = verifiedName;
          finish(selected, chosen, values);
        } catch (error) {
          setBusy(false);
          // HTTP 422 usually falls into catch block as ApiError or we can treat it here
          setStep('fields');
          setFieldValues({});
          setFieldIndex(0);
          botSay([
            {
              text: `❌ No pudimos encontrar ninguna cuenta con el ID ${playerId}. Por favor verifica tu ID e ingrésalo nuevamente o pulsa en Soporte.`,
              actions: [
                { id: 'wa', label: '💬 Soporte' },
                MENU_ACTION,
              ],
            },
          ]);
        }
        return;
      }
    }

    finish(selected, chosen, values);
  };

  const finish = (selected: Game, chosen: PublicProduct, values: Record<string, string>) => {
    const lines = gameFields(selected)
      .filter((field) => values[field.key])
      .map((field) => `• ${field.label}: ${field.sensitive || field.type === 'password' ? '••••••' : values[field.key]}`);

    if (values['_nick']) {
      lines.push(`• Cuenta: ${values['_nick']}`);
    }

    setStep('summary');
    botSay([
      {
        text: [
          'Este es el resumen de tu recarga:',
          `🎮 ${selected.name}`,
          `📦 ${chosen.name}`,
          `💵 ${formatUsd(chosen.priceUsd)} · ${formatBs(chosen.priceBs)}`,
          ...lines,
        ].join('\n'),
      },
      {
        text: '¿Todo correcto? Revisa bien los datos: la recarga entra en la cuenta que indicaste.',
        actions: [
          { id: 'pay', label: '💳 Continuar al pago' },
          { id: 'edit:id', label: '✏️ Cambiar ID' },
          { id: 'edit:pkg', label: '📦 Cambiar paquete' },
          { id: 'back:games', label: '⬅️ Volver' },
        ],
      },
    ]);
  };

  // ---------------------------------------------------------------------------
  // Pago: sesión → teléfono (si aplica) → método → orden → referencia
  // ---------------------------------------------------------------------------

  const needsPhone = product?.fulfillment === 'manual' && product.manualFlow === 'phone';

  const askAuth = (text: string) => {
    setStep('auth');
    botSay([
      {
        text,
        actions: [
          { id: 'auth:google', label: '🔐 Continuar con Google' },
          { id: 'menu', label: '⬅️ Menú principal' },
        ],
      },
    ]);
  };

  const askMethod = () => {
    if (config?.features.maintenanceMode) {
      botSay([
        {
          text: config.features.maintenanceMessage || 'Estamos en mantenimiento. Intenta de nuevo más tarde.',
          actions: [MENU_ACTION],
        },
      ]);
      return;
    }

    setStep('method');
    botSay([
      {
        text: '¿Cómo vas a pagar?',
        options: paymentMethodOptions(config),
        optionsVariant: 'buttons',
        actions: [MENU_ACTION],
      },
    ]);
  };

  const askPhone = (prefix = '') => {
    setStep('phone');
    botSay([
      {
        text: `${prefix}Este producto lo activa nuestro equipo a mano. Escribe tu número de WhatsApp para entregártelo (ej: 0412-0000000).`,
        actions: [MENU_ACTION],
      },
    ]);
  };

  /** Tras el resumen: sesión → teléfono → método. */
  const continueToPayment = (signedIn: boolean) => {
    if (!signedIn) {
      askAuth('Para generar tu orden y guardar tu historial necesitas iniciar sesión.');
      return;
    }
    if (needsPhone && !PHONE_PATTERN.test((contactPhone || me?.profile.phone || '').trim())) {
      askPhone();
      return;
    }
    askMethod();
  };

  const askReference = (payment: CreateOrderResponse['payment'], intro?: string) => {
    const rules = referenceRules(payment);
    setStep('reference');
    botSay([
      {
        text: `${intro ?? ''}Ingresa aquí el número de referencia bancaria una vez completado el pago:${
          rules.isBinance ? ' (código de la operación de Binance Pay)' : ''
        }`,
        actions: [{ id: 'cancel:order', label: '✖️ Cancelar orden' }],
      },
    ]);
  };

  const createOrderFor = (method: ChatPaymentMethod) => {
    if (!game || !product) return;
    setBusy(true);
    push({ from: 'bot', text: 'Creando tu orden…', progress: true });

    createOrder.mutate(
      {
        gameId: game.id,
        productId: product.id,
        playerFields: cleanValues(gameFields(game), fieldValues),
        quantity: 1,
        couponCode: null,
        creatorCode: readCreatorCode() || null,
        contactPhone: needsPhone ? (contactPhone || me?.profile.phone || '').trim() : null,
        paymentMethod: method,
        useWallet: false,
      },
      {
        onSuccess: (data) => {
          setBusy(false);
          setOrderData(data);
          setAttempts(0);
          lastAnnounced.current = null;

          // Pagada íntegra por otra vía: no hay nada que transferir.
          if (data.payment.amountBs <= 0) {
            setFinalOrder(data.order);
            setStep('monitoring');
            return;
          }

          botSay(paymentInstructionMessages(data.payment, data.order.code), () =>
            askReference(data.payment)
          );
        },
        onError: (error) => {
          setBusy(false);
          setStep('method');

          if (error instanceof ApiError && error.code === 'unauthenticated') {
            askAuth('Tu sesión expiró. Inicia sesión otra vez para continuar.');
            return;
          }

          const tooMany =
            error instanceof ApiError &&
            (error.details as { code?: string } | undefined)?.code === 'too_many_open_orders';

          botSay([
            {
              text: tooMany
                ? 'Tienes demasiadas órdenes abiertas sin pagar. Págalas o cancélalas en «Mis órdenes» y vuelve a intentarlo.'
                : `No pude crear la orden: ${errorMessage(error)}`,
              actions: [
                { id: 'pay', label: '🔄 Reintentar' },
                { id: 'menu', label: '⬅️ Menú principal' },
              ],
            },
          ]);
        },
      }
    );
  };

  const submitReference = (rawText: string) => {
    if (!orderData) return;
    const { payment } = orderData;
    const rules = referenceRules(payment);
    const reference = rules.sanitize(rawText);

    push({ from: 'user', text: reference || rawText });

    if (!rules.isValid(reference)) {
      botSay([
        {
          text: rules.invalidMessage,
          actions: [{ id: 'cancel:order', label: '✖️ Cancelar orden' }],
        },
      ]);
      return;
    }

    if (payment.expiresAt < Date.now()) {
      botSay([
        {
          text: 'Esta orden expiró. Crea una nueva para que el monto se calcule con la tasa vigente.',
          actions: [{ id: 'menu', label: '🔁 Hacer otra recarga' }],
        },
      ]);
      setStep('done');
      return;
    }

    setBusy(true);
    push({ from: 'bot', text: 'Verificando pago…', progress: true });

    verifyPayment.mutate(reference, {
      onSuccess: (result) => {
        setBusy(false);
        lastAnnounced.current = null;
        setFinalOrder(result.order);
        setStep('monitoring');
      },
      onError: (error) => {
        setBusy(false);

        // El proxy corta antes de que el servidor termine: no es un fallo, la
        // orden casi siempre sigue su curso. Se pasa a escuchar en vivo.
        if (isGatewayTimeout(error)) {
          lastAnnounced.current = null;
          setFinalOrder({ ...orderData.order, status: 'verifying' });
          setStep('monitoring');
          return;
        }

        if (error instanceof ApiError && error.code === 'unauthenticated') {
          askAuth('Tu sesión expiró. Inicia sesión y vuelve a enviar la referencia.');
          setStep('auth');
          return;
        }

        setAttempts((current) => current + 1);

        // Tras un pago parcial la orden pide sólo la diferencia.
        const details = (error as ApiError).details ?? {};
        const paid = details.paidBs;
        const pending = details.pendingBs;
        const expiresAt = details.expiresAt;
        if (typeof paid === 'number' || typeof expiresAt === 'number') {
          setOrderData({
            ...orderData,
            payment: {
              ...orderData.payment,
              ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
              ...(typeof paid === 'number' ? { paidBs: paid } : {}),
              ...(typeof pending === 'number' ? { amountBs: pending } : {}),
            },
          });
        }

        const providerDown = error instanceof ApiError && error.code === 'provider_error';
        setStep('reference');
        botSay([
          {
            text: providerDown
              ? 'El verificador de pagos no responde. Intenta de nuevo en un minuto.'
              : `No pude verificar el pago: ${errorMessage(error)}`,
            actions: [
              { id: 'retry:ref', label: '🔄 Reintentar referencia' },
              { id: 'cancel:order', label: '✖️ Cancelar orden' },
            ],
          },
        ]);
      },
    });
  };

  // Anuncia en el chat cada cambio de estado de la orden (una sola vez por estado).
  useEffect(() => {
    if (step !== 'monitoring') return;
    const current = liveOrder ?? finalOrder;
    if (!current || lastAnnounced.current === current.status) return;

    const items = liveOrderMessages(current, config?.supportUrl);
    if (!items) return;

    lastAnnounced.current = current.status;
    // Los avisos de progreso salen al instante; los finales, con la pausa habitual.
    if (current.status === 'verifying' || current.status === 'paid' || current.status === 'dispatching') {
      items.forEach((item) => push({ ...item, from: 'bot' }));
      return;
    }
    if (current.status === 'payment_rejected') setStep('reference');
    else setStep('done');
    botSay(items);
    // `push` y `botSay` sólo usan setters y refs: no hace falta listarlos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, liveOrder, finalOrder, config?.supportUrl]);

  // ---------------------------------------------------------------------------
  // Resolución de intenciones pendientes (cuando ya hay datos)
  // ---------------------------------------------------------------------------

  const resolveCategory = (family: ChatFamily) => {
    const games = buildPool().filter((item) => (item.providerFamily ?? 'topup') === family);
    if (games.length === 0) {
      botSay([
        {
          text: `Ahora mismo no hay ${CATEGORY_LABEL[family]} disponibles. Prueba con otra categoría.`,
          options: CATEGORY_OPTIONS,
          optionsVariant: 'buttons',
        },
      ]);
      setStep('menu');
      return;
    }
    presentGames(games, `Estos son los ${CATEGORY_LABEL[family]} disponibles. Elige uno o escribe el nombre:`);
  };

  const resolveSearch = (text: string) => {
    const pool = buildPool();
    const matches = searchGames(text, pool);
    const category = matchCategory(text);
    const topScore = matches[0]?.score ?? 0;

    // «gift cards», «juegos»…: se muestra directamente esa categoría.
    if (category && category.score >= 0.85 && topScore < 0.85) {
      resolveCategory(category.family);
      return;
    }

    if (matches.length > 0) {
      const extra: ChatOption[] =
        category && category.score >= 0.85
          ? [{ id: `cat:${category.family}`, label: `Ver todos los ${CATEGORY_LABEL[category.family]}` }]
          : [];
      presentGames(
        matches.map((match) => match.game),
        topScore >= 0.85 ? 'Esto fue lo que encontré:' : '¿Quizás buscabas alguno de estos?',
        extra
      );
      return;
    }

    // Sin coincidencia clara: lo más cercano, o si no, lo más buscado.
    const closest = searchGames(text, pool, 0.45)
      .slice(0, 4)
      .map((match) => match.game);
    const popular = (catalog.data?.games ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .slice(0, 4);
    const suggestions = closest.length > 0 ? closest : popular;

    setStep('games');
    gameList.current = { items: suggestions, shown: suggestions.length };
    botSay([
      {
        text: 'No encontré ese producto, pero aquí tienes lo más buscado:',
        options: gameCards(suggestions),
        optionsVariant: 'games',
        actions: CATEGORY_OPTIONS,
      },
    ]);
  };

  const resolvePackages = (selected: Game) => {
    const data = gameCatalog.data;
    if (gameCatalog.error || !data) {
      botSay([
        {
          text: 'No pude cargar los paquetes de ese juego. Inténtalo de nuevo en un momento.',
          actions: [{ id: 'back:games', label: '⬅️ Cambiar de juego' }, MENU_ACTION],
        },
      ]);
      setStep('games');
      return;
    }

    const { automatic, manual } = groupProducts(data.products);
    const items = [...automatic, ...manual].filter((item) => item.active !== false && item.stock !== 0);

    if (items.length === 0) {
      botSay([
        {
          text: `${selected.name} no tiene paquetes disponibles por ahora.`,
          actions: [{ id: 'back:games', label: '⬅️ Cambiar de juego' }, MENU_ACTION],
        },
      ]);
      setStep('games');
      return;
    }

    productList.current = { items, shown: 0 };
    showProductPage(`Elegiste ${selected.name}. ¿Qué monto quieres recargar?`);
  };

  useEffect(() => {
    if (!pending) return;

    if (pending.kind === 'category') {
      if (!ready[pending.family]) return;
      setPending(null);
      resolveCategory(pending.family);
      return;
    }

    if (pending.kind === 'search') {
      if (!FAMILIES.every((family) => ready[family])) return;
      setPending(null);
      resolveSearch(pending.text);
      return;
    }

    // packages
    if (!game || gameCatalog.isLoading) return;
    if (!gameCatalog.error && gameCatalog.data?.game.id !== game.id) return;
    setPending(null);
    resolvePackages(game);
    // Las funciones de resolución leen el estado de este mismo render; sólo
    // deben volver a evaluarse cuando cambian los datos de los que esperan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, readyKey, game, gameCatalog.isLoading, gameCatalog.data, gameCatalog.error]);

  // ---------------------------------------------------------------------------
  // API pública del hook
  // ---------------------------------------------------------------------------

  const chatbotConfig = useChatbotConfig();

  /** Arranca la conversación una sola vez. */
  const start = () => {
    if (started.current) return;
    started.current = true;
    setStep('welcome');
    botSay([{ text: chatbotConfig.welcomeMessage }], () =>
      askCategory()
    );
  };

  const startPending = (next: Pending) => {
    setIsTyping(true);
    setPending(next);
  };

  const selectOption = (optionId: string) => {
    if (isTyping || pending) return;
    const [kind, value = ''] = optionId.split(/:(.*)/s);
    const pool = buildPool();

    if (optionId === 'menu') {
      askCategory();
      return;
    }

    if (kind === 'cat' && FAMILIES.includes(value as ChatFamily)) {
      const family = value as ChatFamily;
      push({ from: 'user', text: CATEGORY_OPTIONS.find((item) => item.id === optionId)?.label ?? family });
      setEnabledFamilies((current) => (current.includes(family) ? current : [...current, family]));
      startPending({ kind: 'category', family });
      return;
    }

    if (kind === 'more') {
      if (value === 'games') showGamePage('Aquí tienes más opciones:');
      if (value === 'packages') showProductPage('Más montos disponibles:');
      return;
    }

    if (kind === 'back') {
      if (gameList.current.items.length > 0) {
        gameList.current.shown = 0;
        showGamePage('Elige otro juego:');
      } else {
        askCategory();
      }
      return;
    }

    if (kind === 'game') {
      const chosen = pool.find((item) => item.id === value);
      if (!chosen) return;
      push({ from: 'user', text: chosen.name });
      setGame(chosen);
      setProduct(null);
      startPending({ kind: 'packages' });
      return;
    }

    if (kind === 'pkg' && game) {
      const chosen = productList.current.items.find((item) => item.id === value);
      if (!chosen) return;
      push({ from: 'user', text: chosen.name });
      setProduct(chosen);
      setFieldValues({});
      setFieldIndex(0);

      if (game.requiresPlayerData === false) {
        verifyPlayerAndFinish(game, chosen, {});
      } else {
        askField(game, 0, `Perfecto, ${chosen.name}. `);
      }
      return;
    }

    if (kind === 'edit') {
      if (value === 'id' && game) {
        push({ from: 'user', text: 'Cambiar ID' });
        setFieldValues({});
        setFieldIndex(0);
        askField(game, 0, 'Empecemos de nuevo. ');
      } else if (value === 'pkg' && game) {
        push({ from: 'user', text: 'Cambiar paquete' });
        setProduct(null);
        startPending({ kind: 'packages' });
      }
      return;
    }

    if (kind === 'pay') {
      push({ from: 'user', text: 'Continuar al pago' });
      continueToPayment(Boolean(user));
      return;
    }

    if (kind === 'auth' && value === 'google') {
      push({ from: 'user', text: 'Continuar con Google' });
      signInWithGoogle();
      return;
    }

    if (kind === 'method') {
      push({ from: 'user', text: methodLabel(value as ChatPaymentMethod) });
      createOrderFor(value as ChatPaymentMethod);
      return;
    }

    if (kind === 'cancel' && value === 'order') {
      push({ from: 'user', text: 'Cancelar orden' });
      if (orderData?.order.id) cancelOrder.mutate(orderData.order.id);
      askCategory('Orden cancelada. ¿Qué quieres recargar?');
      return;
    }

    if (kind === 'retry' && value === 'ref') {
      push({ from: 'user', text: 'Reintentar referencia' });
      if (orderData?.payment) askReference(orderData.payment);
      return;
    }

    if (kind === 'wa') {
      push({ from: 'user', text: 'Hablar con soporte' });
      if (config?.supportUrl) {
        openWhatsapp(config.supportUrl);
      }
      return;
    }
  };

  const sendText = (raw: string) => {
    const text = raw.trim();
    if (!text || isTyping || pending || step === 'welcome') return;

    if (step === 'phone') {
      push({ from: 'user', text });
      if (!PHONE_PATTERN.test(text)) {
        botSay([{ text: 'Ese número no parece válido. Usa el formato 0412-1234567.', actions: [MENU_ACTION] }]);
        return;
      }
      setContactPhone(text);
      askMethod();
      return;
    }

    if (step === 'reference') {
      submitReference(text);
      return;
    }

    // Respuesta a un campo del juego.
    if (step === 'fields' && game && product) {
      const fields = gameFields(game);
      const field = fields[fieldIndex];
      if (!field) return;

      const masked = field.sensitive || field.type === 'password';
      push({ from: 'user', text: masked ? '•'.repeat(Math.min(text.length, 12)) : text });

      const skipped = !field.required && normalizeSkip(text);
      if (!skipped && !fieldsAreValid([field], { [field.key]: text })) {
        botSay([
          {
            text: `${field.help || `El valor de «${field.label}» no es válido.`} Inténtalo de nuevo.`,
            actions: [MENU_ACTION],
          },
        ]);
        return;
      }

      const values = skipped ? fieldValues : { ...fieldValues, [field.key]: text };
      setFieldValues(values);

      if (fieldIndex + 1 < fields.length) {
        setFieldIndex(fieldIndex + 1);
        askField(game, fieldIndex + 1);
      } else {
        verifyPlayerAndFinish(game, product, values);
      }
      return;
    }

    // En cualquier otro paso, el texto es una búsqueda.
    push({ from: 'user', text });
    setEnabledFamilies([...FAMILIES]);
    startPending({ kind: 'search', text });
  };

  const reset = () => {
    clearTimers();
    setIsTyping(false);
    setPending(null);
    setMessages([]);
    setGame(null);
    setProduct(null);
    setFieldIndex(0);
    setFieldValues({});
    setOrderData(null);
    setFinalOrder(null);
    setContactPhone('');
    setAttempts(0);
    lastAnnounced.current = null;
    gameList.current = { items: [], shown: 0 };
    productList.current = { items: [], shown: 0 };
    nextId.current = 1;
    started.current = false;
    start();
  };

  // Limpia los temporizadores pendientes al desmontar.
  useEffect(() => clearTimers, [clearTimers]);

  const currentField = step === 'fields' && game ? gameFields(game)[fieldIndex] : undefined;

  return {
    messages,
    step,
    isTyping: isTyping || pending !== null || busy,
    busy,
    attempts,
    game,
    product,
    /** Se puede escribir en cualquier momento salvo mientras el bot responde. */
    canType: step !== 'welcome' && !isTyping && pending === null && !busy,
    inputPlaceholder: currentField
      ? `Escribe tu ${currentField.label}…`
      : step === 'reference'
        ? 'Ingresa tu referencia aquí…'
        : step === 'phone'
          ? 'Ej: 0412-1234567'
          : 'Escribe un juego, ej: free fire, robux…',
    inputType: currentField?.type === 'password' ? ('password' as const) : ('text' as const),
    inputMode:
      currentField?.type === 'number' || step === 'reference'
        ? ('numeric' as const)
        : currentField?.type === 'email'
          ? ('email' as const)
          : step === 'phone'
            ? ('tel' as const)
            : ('text' as const),
    start,
    reset,
    selectOption,
    sendText,
  };
}

/** «no», «omitir», «-»: el cliente quiere saltarse un campo opcional. */
function normalizeSkip(text: string): boolean {
  return ['no', 'omitir', 'saltar', '-'].includes(text.trim().toLowerCase());
}
