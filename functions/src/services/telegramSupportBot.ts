/**
 * Bot de Telegram dedicado a Soporte Automatizado para Clientes y
 * Administración Rápida de Órdenes en Refill Store.
 *
 * Funcionalidades:
 *  1. Menú interactivo con Inline Keyboards (Consultar Orden, FAQs, Soporte Humano).
 *  2. Búsqueda y sincronización en tiempo real con proveedores (Inefable/FazerCards).
 *  3. Seguridad estricta por Chat ID:
 *     - Clientes: vista privada de órdenes y solicitud de reintento con rate-limit.
 *     - Administradores: ficha técnica completa y botones directos de acción (reintentar,
 *       marcar completada manual, sincronizar con proveedor).
 *  4. Escalamiento a soporte humano con enlace directo al chat del cliente y botones
 *     de resolución rápida para el admin.
 */
import { orders, paymentRefs, now, db } from '../config/firebase';
import { telegramSupportBotToken } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { log } from '../lib/logger';
import { getConfig } from './settings';
import { checkOrderProviderStatus, dispatchOrder } from './dispatch';
import { markCompleted } from './orders';
import type { Order } from '../types/models';
import type { AuthUser } from '../middleware/auth';

// --- Tipos de la API de Telegram --------------------------------------------

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramSendMessageOptions {
  reply_markup?: {
    inline_keyboard: TelegramInlineButton[][];
  };
  parse_mode?: 'HTML' | 'MarkdownV2';
  disable_web_page_preview?: boolean;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    chat: {
      id: number | string;
      type: string;
    };
    date: number;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      is_bot: boolean;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number | string;
      };
      text?: string;
    };
    data?: string;
  };
}

export interface TelegramSupportSession {
  chatId: string;
  state?: 'awaiting_order_query' | 'awaiting_support_message' | null;
  lastOrderId?: string | null;
  lastOrderCode?: string | null;
  lastClientRetryAt?: number | null;
  updatedAt?: unknown;
}

// --- Configuración y Token --------------------------------------------------

/** Resuelve el token del bot de soporte directamente desde Secret Manager (o env en tests). */
export function resolveSupportBotToken(): string {
  const token = telegramSupportBotToken();
  return token && token.includes(':') ? token : '';
}

/** Verifica si un chat ID corresponde al administrador autorizado. */
export async function isTelegramAdmin(chatId: number | string): Promise<boolean> {
  const idStr = String(chatId).trim();
  if (!idStr) return false;

  const envAdmin = process.env.ADMIN_TELEGRAM_CHAT_ID?.trim();
  if (envAdmin && envAdmin === idStr) return true;

  try {
    const config = await getConfig();
    const configAdmin = config.alerts?.telegramChatId?.trim();
    if (configAdmin && configAdmin === idStr) return true;
  } catch {
    // ignorar
  }
  return false;
}

// --- Métodos de Telegram Bot API --------------------------------------------

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  options?: TelegramSendMessageOptions
): Promise<boolean> {
  const token = await resolveSupportBotToken();
  if (!token) {
    log.warn('Telegram Support Bot: Token no configurado');
    return false;
  }

  const res = await fetchJson<{ ok?: boolean; description?: string }>(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        chat_id: chatId,
        text,
        parse_mode: options?.parse_mode ?? 'HTML',
        disable_web_page_preview: options?.disable_web_page_preview ?? true,
        reply_markup: options?.reply_markup,
      },
      timeoutMs: 10_000,
      retries: 1,
    }
  );

  if (!res.ok || res.data?.ok === false) {
    log.warn('Telegram Support Bot: Falló sendMessage', {
      chatId,
      status: res.status,
      desc: res.data?.description,
    });
    return false;
  }
  return true;
}

export async function editTelegramMessage(
  chatId: number | string,
  messageId: number,
  text: string,
  options?: TelegramSendMessageOptions
): Promise<boolean> {
  const token = await resolveSupportBotToken();
  if (!token) return false;

  const res = await fetchJson<{ ok?: boolean; description?: string }>(
    `https://api.telegram.org/bot${token}/editMessageText`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: options?.parse_mode ?? 'HTML',
        disable_web_page_preview: options?.disable_web_page_preview ?? true,
        reply_markup: options?.reply_markup,
      },
      timeoutMs: 10_000,
      retries: 1,
    }
  );
  return Boolean(res.ok && res.data?.ok !== false);
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false
): Promise<boolean> {
  const token = await resolveSupportBotToken();
  if (!token) return false;

  const res = await fetchJson<{ ok?: boolean }>(
    `https://api.telegram.org/bot${token}/answerCallbackQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      },
      timeoutMs: 8_000,
      retries: 1,
    }
  );
  return Boolean(res.ok && res.data?.ok !== false);
}

// --- Manejo de Sesiones -----------------------------------------------------

const sessionsCollection = () => db.collection('telegramSupportSessions');

async function getSession(chatId: string): Promise<TelegramSupportSession> {
  try {
    const snap = await sessionsCollection().doc(chatId).get();
    if (snap.exists) {
      return snap.data() as TelegramSupportSession;
    }
  } catch (err) {
    log.warn('Error leyendo sesión de Telegram Support', { chatId, error: String(err) });
  }
  return { chatId, state: null };
}

async function updateSession(
  chatId: string,
  patch: Partial<TelegramSupportSession>
): Promise<void> {
  try {
    await sessionsCollection().doc(chatId).set(
      {
        ...patch,
        chatId,
        updatedAt: now(),
      },
      { merge: true }
    );
  } catch (err) {
    log.warn('Error actualizando sesión de Telegram Support', { chatId, error: String(err) });
  }
}

// --- Utilidades de Formato --------------------------------------------------

function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getOrderStatusDisplay(status: string, estado?: string | null): { label: string; emoji: string } {
  switch (status) {
    case 'completed':
      return { label: 'Completada / Entregada', emoji: '✅' };
    case 'dispatching':
      return { label: 'Enviando recarga al juego', emoji: '⚡' };
    case 'in_review':
      return { label: 'En revisión (atención en progreso)', emoji: '⏳' };
    case 'awaiting_manual':
      return { label: 'En espera de entrega manual', emoji: '🕒' };
    case 'pending':
      return { label: 'Pendiente de pago / verificación', emoji: '💳' };
    case 'failed':
      return { label: 'Fallida / Requiere revisión', emoji: '❌' };
    case 'cancelled':
      return { label: 'Cancelada', emoji: '🚫' };
    case 'refunded':
      return { label: 'Reembolsada a Billetera', emoji: '↩️' };
    default:
      return { label: estado || status, emoji: 'ℹ️' };
  }
}

// --- Búsqueda y Consulta de Órdenes -----------------------------------------

export async function findOrder(query: string): Promise<Order | null> {
  const clean = query.trim();
  if (!clean) return null;
  const upper = clean.toUpperCase();
  const digitsOnly = clean.replace(/\D/g, '');

  // 1. ID exacto de documento
  try {
    const directSnap = await orders().doc(clean).get();
    if (directSnap.exists) {
      return { id: directSnap.id, ...directSnap.data() } as Order;
    }
  } catch {
    // Continuar
  }

  // 2. Por código de orden estándar (RF-XXXXXX)
  try {
    const byCode = await orders().where('code', '==', upper).limit(1).get();
    if (!byCode.empty) {
      const doc = byCode.docs[0];
      return { id: doc.id, ...doc.data() } as Order;
    }
  } catch {
    // Continuar
  }

  // 3. Por código de orden WhatsApp (WA-XXXXXX)
  try {
    const byDisplayId = await orders().where('displayId', '==', upper).limit(1).get();
    if (!byDisplayId.empty) {
      const doc = byDisplayId.docs[0];
      return { id: doc.id, ...doc.data() } as Order;
    }
  } catch {
    // Continuar
  }

  // 4. Por referencia de pago bancaria (mínimo 4 dígitos)
  if (digitsOnly.length >= 4) {
    try {
      const prefSnap = await paymentRefs().doc(digitsOnly).get();
      if (prefSnap.exists) {
        const pdata = prefSnap.data() as { orderId?: string };
        if (pdata?.orderId) {
          const oSnap = await orders().doc(pdata.orderId).get();
          if (oSnap.exists) {
            return { id: oSnap.id, ...oSnap.data() } as Order;
          }
        }
      }
    } catch {
      // Continuar
    }

    try {
      const byRef = await orders().where('payment.reference', '==', digitsOnly).limit(1).get();
      if (!byRef.empty) {
        const doc = byRef.docs[0];
        return { id: doc.id, ...doc.data() } as Order;
      }
    } catch {
      // Continuar
    }

    try {
      const byRefWa = await orders().where('paymentDetails.reference', '==', digitsOnly).limit(1).get();
      if (!byRefWa.empty) {
        const doc = byRefWa.docs[0];
        return { id: doc.id, ...doc.data() } as Order;
      }
    } catch {
      // Continuar
    }
  }

  return null;
}

// --- Vistas de Mensaje y Teclados -------------------------------------------

function buildMainMenuKeyboard(): { inline_keyboard: TelegramInlineButton[][] } {
  return {
    inline_keyboard: [
      [{ text: '📦 Consultar Estado de Orden', callback_data: 'menu_order_status' }],
      [{ text: '💳 Métodos de Pago / Dudas Frecuentes', callback_data: 'menu_faqs' }],
      [{ text: '👨‍💻 Hablar con Soporte Humano', callback_data: 'menu_support' }],
    ],
  };
}

function buildFaqsMenuKeyboard(): { inline_keyboard: TelegramInlineButton[][] } {
  return {
    inline_keyboard: [
      [{ text: '📲 Cómo pagar por Pago Móvil', callback_data: 'faq_pagomovil' }],
      [{ text: '🪙 Qué son las RefillCoins y Excedentes', callback_data: 'faq_refillcoins' }],
      [{ text: '⏱️ Tiempos de entrega', callback_data: 'faq_delivery' }],
      [{ text: '⬅️ Volver al Menú Principal', callback_data: 'main_menu' }],
    ],
  };
}

/** Ficha pública para Clientes: privacidad estricta. */
function renderCustomerOrderView(order: Order): {
  text: string;
  keyboard: { inline_keyboard: TelegramInlineButton[][] };
} {
  const statusInfo = getOrderStatusDisplay(order.status, (order as { estado?: string }).estado);
  const orderCode = order.code || (order as { displayId?: string }).displayId || order.id;
  const totalBs = order.pricing?.totalBs ?? (order as { totalBs?: number }).totalBs;
  const totalUsd = order.pricing?.totalUsd ?? (order as { totalUsd?: number }).totalUsd ?? 0;

  const text = [
    `📦 <b>Detalle de tu Orden</b>`,
    ``,
    `<b>Código:</b> <code>${escapeHtml(orderCode)}</code>`,
    `<b>Juego:</b> ${escapeHtml(order.gameName || 'Recarga de Juego')}`,
    `<b>Producto:</b> ${escapeHtml(order.productName || 'Diamantes / Paquete')}`,
    `<b>ID de Jugador:</b> <code>${escapeHtml(order.playerId || 'N/A')}</code>${order.playerId2 ? ` (Zona: <code>${escapeHtml(order.playerId2)}</code>)` : ''}`,
    `<b>Monto:</b> ${totalBs ? `${totalBs.toLocaleString('es-VE')} Bs` : ''} ($${totalUsd.toFixed(2)})`,
    `<b>Estado:</b> ${statusInfo.emoji} <b>${escapeHtml(statusInfo.label)}</b>`,
  ].join('\n');

  const buttons: TelegramInlineButton[][] = [];

  // Si falló o está en revisión, permitir solicitar reintento
  if (['failed', 'in_review'].includes(order.status)) {
    buttons.push([
      { text: '🔄 Solicitar Reintento', callback_data: `cli_retry_${order.id}` },
    ]);
  }

  buttons.push([
    { text: '👨‍💻 Hablar con Soporte', callback_data: 'menu_support' },
    { text: '⬅️ Menú Principal', callback_data: 'main_menu' },
  ]);

  return { text, keyboard: { inline_keyboard: buttons } };
}

/** Ficha técnica para Administradores: información completa y control. */
function renderAdminOrderView(order: Order): {
  text: string;
  keyboard: { inline_keyboard: TelegramInlineButton[][] };
} {
  const orderCode = order.code || (order as { displayId?: string }).displayId || order.id;
  const totalBs = order.pricing?.totalBs ?? (order as { totalBs?: number }).totalBs;
  const totalUsd = order.pricing?.totalUsd ?? (order as { totalUsd?: number }).totalUsd ?? 0;
  const customerName = order.user?.displayName || (order as { userName?: string; customerName?: string }).userName || (order as { customerName?: string }).customerName || 'Sin nombre';
  const customerContact = order.user?.email || (order as { userEmail?: string; customerEmail?: string }).userEmail || order.contactPhone || (order as { userPhone?: string }).userPhone || 'N/A';
  const reference = order.payment?.reference || (order as { paymentDetails?: { reference?: string } }).paymentDetails?.reference || 'N/A';
  const paymentMethod = order.payment?.method || (order as { paymentDetails?: { method?: string } }).paymentDetails?.method || 'Pago Móvil';
  const provider = order.provider || (order as { dispatchProvider?: string }).dispatchProvider || 'inefable';

  // Resumen de llamadas al proveedor
  const calls = order.dispatch?.calls || (order as { dispatchCalls?: Array<{ packageId?: string | number; status?: string; providerOrderId?: string | number }> }).dispatchCalls || [];
  const callsText = calls.length > 0
    ? calls.map((c: any, i: number) => `  #${i + 1} pkg ${c.packageId || 'N/A'}: ${c.status || 'desconocido'} (ID: ${c.providerOrderId || 'N/A'})`).join('\n')
    : '  Sin registros de llamada.';

  const lastError = order.dispatch?.lastError || (order as { dispatchError?: string }).dispatchError;

  const text = [
    `🛡️ <b>Ficha de Orden (Panel Admin)</b>`,
    ``,
    `<b>Código:</b> <code>${escapeHtml(orderCode)}</code> (Doc: <code>${escapeHtml(order.id)}</code>)`,
    `<b>Cliente:</b> ${escapeHtml(customerName)}`,
    `<b>Contacto:</b> ${escapeHtml(customerContact)}`,
    `<b>Juego:</b> ${escapeHtml(order.gameName || 'N/A')} · <b>Producto:</b> ${escapeHtml(order.productName || 'N/A')}`,
    `<b>ID Jugador:</b> <code>${escapeHtml(order.playerId || 'N/A')}</code>${order.playerId2 ? ` (Zona: <code>${escapeHtml(order.playerId2)}</code>)` : ''}`,
    `<b>Monto:</b> ${totalBs ? `${totalBs.toLocaleString('es-VE')} Bs` : ''} ($${totalUsd.toFixed(2)})`,
    `<b>Pago:</b> Ref <code>${escapeHtml(reference)}</code> (${escapeHtml(paymentMethod)})`,
    `<b>Estado:</b> <b>${escapeHtml(order.status)}</b> (${escapeHtml((order as { estado?: string }).estado || 'N/A')})`,
    `<b>Proveedor:</b> ${escapeHtml(provider)}`,
    ``,
    `<b>Subórdenes / Llamadas:</b>\n${callsText}`,
    lastError ? `\n⚠️ <b>Último error:</b> <code>${escapeHtml(lastError)}</code>` : '',
  ].filter(Boolean).join('\n');

  const buttons: TelegramInlineButton[][] = [];

  // Botones de acción admin según estado
  if (['in_review', 'failed', 'awaiting_manual', 'pending', 'dispatching'].includes(order.status)) {
    buttons.push([
      { text: '🔄 Reintentar Despacho API', callback_data: `adm_retry_${order.id}` },
    ]);
    buttons.push([
      { text: '✅ Marcar Completada Manual', callback_data: `adm_comp_${order.id}` },
    ]);
  }

  buttons.push([
    { text: '🔍 Sincronizar Proveedor', callback_data: `adm_sync_${order.id}` },
  ]);

  buttons.push([
    { text: '⬅️ Menú Principal', callback_data: 'main_menu' },
  ]);

  return { text, keyboard: { inline_keyboard: buttons } };
}

// --- Procesador Principal de Webhook ----------------------------------------

export async function handleTelegramSupportWebhook(
  body: TelegramUpdate,
  urlToken?: string
): Promise<void> {
  if (!body) return;

  // Validación opcional si la URL configurada incluye token
  if (urlToken) {
    const expectedToken = await resolveSupportBotToken();
    if (expectedToken && urlToken !== expectedToken) {
      log.warn('Webhook de Telegram Support recibido con token inválido en URL');
      return;
    }
  }

  // 1. Mensajes de texto entrantes
  if (body.message?.text) {
    await handleMessage(body.message);
    return;
  }

  // 2. Clics en botones interactivos (Callback Queries)
  if (body.callback_query) {
    await handleCallbackQuery(body.callback_query);
    return;
  }
}

// --- Manejador de Mensajes de Texto -----------------------------------------

async function handleMessage(message: NonNullable<TelegramUpdate['message']>): Promise<void> {
  const chatId = String(message.chat.id);
  const rawText = message.text?.trim() || '';
  const session = await getSession(chatId);
  const isAdmin = await isTelegramAdmin(chatId);

  // Comando /start o reinicio
  if (rawText === '/start' || rawText === '/menu' || rawText.toLowerCase() === 'menu') {
    await updateSession(chatId, { state: null });
    const config = await getConfig();
    const welcome = [
      `👋 <b>¡Bienvenido al Asistente de ${escapeHtml(config.storeName)}!</b>`,
      ``,
      `Aquí puedes consultar el estado de tus compras en tiempo real, ver guías de pago y contactar a nuestro equipo de soporte humano.`,
      isAdmin ? `\n🛡️ <i>Modo Administrador Activo: Tienes acceso a controles rápidos de despacho.</i>` : '',
      `\nSelecciona una opción para continuar:`,
    ].filter(Boolean).join('\n');

    await sendTelegramMessage(chatId, welcome, {
      reply_markup: buildMainMenuKeyboard(),
    });
    return;
  }

  // Si está esperando redactar un caso para Soporte Humano
  if (session.state === 'awaiting_support_message') {
    await handleSupportEscalation(message, session);
    return;
  }

  // Si está en estado de consultar orden O si el mensaje parece un código/referencia
  const isOrderQueryState = session.state === 'awaiting_order_query';
  const looksLikeOrderCode = /^(rf-|wa-|wa_)/i.test(rawText) || /^\d{4,20}$/.test(rawText);

  if (isOrderQueryState || looksLikeOrderCode || rawText.startsWith('/orden')) {
    const searchTerm = rawText.replace(/^\/orden\s*/i, '').trim();
    if (!searchTerm) {
      await sendTelegramMessage(
        chatId,
        '⚠️ Por favor introduce el código de orden (ej. <code>RF-8K3M2Q</code>) o la referencia de tu pago:',
        { reply_markup: buildMainMenuKeyboard() }
      );
      return;
    }

    await sendTelegramMessage(chatId, `🔍 Buscando información de <code>${escapeHtml(searchTerm)}</code>...`);

    let order = await findOrder(searchTerm);
    if (!order) {
      await updateSession(chatId, { state: null });
      await sendTelegramMessage(
        chatId,
        `❌ No encontramos ninguna orden con el código o referencia <code>${escapeHtml(searchTerm)}</code>.\n\nVerifica que los datos sean correctos o comunícate con un asesor.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📦 Intentar otra búsqueda', callback_data: 'menu_order_status' }],
              [{ text: '👨‍💻 Hablar con Soporte Humano', callback_data: 'menu_support' }],
              [{ text: '⬅️ Menú Principal', callback_data: 'main_menu' }],
            ],
          },
        }
      );
      return;
    }

    // Si la orden está en proceso, consultar en vivo al proveedor
    if (['dispatching', 'in_review'].includes(order.status)) {
      try {
        await checkOrderProviderStatus(order.id, isAdmin ? 'telegram_admin' : 'telegram_user');
        const refreshed = await orders().doc(order.id).get();
        if (refreshed.exists) {
          order = { id: refreshed.id, ...refreshed.data() } as Order;
        }
      } catch (err) {
        log.warn('Error al sincronizar con proveedor en consulta de Telegram', {
          orderId: order.id,
          error: String(err),
        });
      }
    }

    // Guardar en la sesión la última orden consultada
    await updateSession(chatId, {
      state: null,
      lastOrderId: order.id,
      lastOrderCode: order.code || (order as { displayId?: string }).displayId || order.id,
    });

    if (isAdmin) {
      const view = renderAdminOrderView(order);
      await sendTelegramMessage(chatId, view.text, { reply_markup: view.keyboard });
    } else {
      const view = renderCustomerOrderView(order);
      await sendTelegramMessage(chatId, view.text, { reply_markup: view.keyboard });
    }
    return;
  }

  // Mensaje general no reconocido
  await sendTelegramMessage(
    chatId,
    `Hola, para ayudarte por favor selecciona una de las opciones del menú:`,
    { reply_markup: buildMainMenuKeyboard() }
  );
}

// --- Manejador de Botones (Callback Queries) --------------------------------

async function handleCallbackQuery(
  cb: NonNullable<TelegramUpdate['callback_query']>
): Promise<void> {
  const callbackId = cb.id;
  const data = cb.data || '';
  const chatId = String(cb.message?.chat.id || cb.from.id);
  const messageId = cb.message?.message_id;
  const isAdmin = await isTelegramAdmin(chatId);

  // 1. Menú Principal
  if (data === 'main_menu') {
    await updateSession(chatId, { state: null });
    await answerCallbackQuery(callbackId);
    const config = await getConfig();
    const welcome = [
      `👋 <b>Asistente de ${escapeHtml(config.storeName)}</b>`,
      ``,
      `Selecciona la opción que deseas consultar:`,
    ].join('\n');

    if (messageId) {
      await editTelegramMessage(chatId, messageId, welcome, {
        reply_markup: buildMainMenuKeyboard(),
      });
    } else {
      await sendTelegramMessage(chatId, welcome, {
        reply_markup: buildMainMenuKeyboard(),
      });
    }
    return;
  }

  // 2. Solicitar consulta de orden
  if (data === 'menu_order_status') {
    await updateSession(chatId, { state: 'awaiting_order_query' });
    await answerCallbackQuery(callbackId);
    const promptText = [
      `📦 <b>Consultar Estado de Orden</b>`,
      ``,
      `Por favor, escribe el <b>código de tu orden</b> (ej. <code>RF-8K3M2Q</code> o <code>WA-123456</code>) o los <b>dígitos de la referencia</b> de tu Pago Móvil:`,
    ].join('\n');

    await sendTelegramMessage(chatId, promptText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Cancelar y Volver', callback_data: 'main_menu' }],
        ],
      },
    });
    return;
  }

  // 3. Menú de Dudas Frecuentes
  if (data === 'menu_faqs') {
    await updateSession(chatId, { state: null });
    await answerCallbackQuery(callbackId);
    const faqsText = [
      `💳 <b>Métodos de Pago y Dudas Frecuentes</b>`,
      ``,
      `Elige el tema sobre el cual deseas información:`,
    ].join('\n');

    if (messageId) {
      await editTelegramMessage(chatId, messageId, faqsText, {
        reply_markup: buildFaqsMenuKeyboard(),
      });
    } else {
      await sendTelegramMessage(chatId, faqsText, {
        reply_markup: buildFaqsMenuKeyboard(),
      });
    }
    return;
  }

  // 3.1 FAQ: Pago Móvil
  if (data === 'faq_pagomovil') {
    await answerCallbackQuery(callbackId);
    const config = await getConfig();
    const bank = config.bank;
    const text = [
      `📲 <b>Cómo pagar por Pago Móvil</b>`,
      ``,
      `Realiza tu pago móvil por el monto exacto en Bolívares a los siguientes datos:`,
      `• <b>Banco:</b> ${escapeHtml(bank.name)} (${escapeHtml(bank.code)})`,
      `• <b>Teléfono:</b> <code>${escapeHtml(bank.phone)}</code>`,
      `• <b>Cédula/RIF:</b> <code>${escapeHtml(bank.idNumber)}</code>`,
      `• <b>Titular:</b> ${escapeHtml(bank.holder)}`,
      ``,
      `⚡ <b>Verificación Automática:</b> Al pagar, introduce los últimos dígitos de la referencia bancaria en nuestra web o en este bot y el sistema acreditará y despachará tu recarga automáticamente en segundos.`,
    ].join('\n');

    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Volver a Dudas Frecuentes', callback_data: 'menu_faqs' }],
        [{ text: '⬅️ Menú Principal', callback_data: 'main_menu' }],
      ],
    };

    if (messageId) {
      await editTelegramMessage(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await sendTelegramMessage(chatId, text, { reply_markup: keyboard });
    }
    return;
  }

  // 3.2 FAQ: RefillCoins y Excedentes
  if (data === 'faq_refillcoins') {
    await answerCallbackQuery(callbackId);
    const text = [
      `🪙 <b>Qué son las RefillCoins y Abono de Excedentes</b>`,
      ``,
      `• <b>RefillCoins:</b> Es saldo a favor en dólares dentro de tu billetera en Refill Store ($1 USD = 1 RefillCoin) que puedes usar para pagar cualquier recarga sin comisiones.`,
      ``,
      `• <b>Abono Automático de Excedentes:</b> Si al transferir por Pago Móvil envías dinero de más, ¡no te preocupes! El sistema nunca rechaza el pago ni pierdes tu dinero: procesa tu recarga de inmediato y calcula la diferencia en dólares, acreditándola de forma 100% automática a tu billetera para tu próxima compra.`,
    ].join('\n');

    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Volver a Dudas Frecuentes', callback_data: 'menu_faqs' }],
        [{ text: '⬅️ Menú Principal', callback_data: 'main_menu' }],
      ],
    };

    if (messageId) {
      await editTelegramMessage(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await sendTelegramMessage(chatId, text, { reply_markup: keyboard });
    }
    return;
  }

  // 3.3 FAQ: Tiempos de entrega
  if (data === 'faq_delivery') {
    await answerCallbackQuery(callbackId);
    const text = [
      `⏱️ <b>Tiempos de Entrega</b>`,
      ``,
      `• <b>Recargas Automáticas (Free Fire y juegos por ID):</b> Entrega instantánea 24/7 (1 a 3 minutos promedio).`,
      `• <b>Productos Manuales (Roblox y servicios de operador):</b> Son gestionados por nuestros asesores en cola de atención rápida.`,
      `• <b>¿Qué ocurre si una orden demora?</b> Si el proveedor del juego entra en mantenimiento o cola larga, la orden entra en revisión protegida. Nuestro sistema reintenta la entrega o un asesor la completa manualmente sin riesgo de extravío.`,
    ].join('\n');

    const keyboard = {
      inline_keyboard: [
        [{ text: '⬅️ Volver a Dudas Frecuentes', callback_data: 'menu_faqs' }],
        [{ text: '⬅️ Menú Principal', callback_data: 'main_menu' }],
      ],
    };

    if (messageId) {
      await editTelegramMessage(chatId, messageId, text, { reply_markup: keyboard });
    } else {
      await sendTelegramMessage(chatId, text, { reply_markup: keyboard });
    }
    return;
  }

  // 4. Solicitar hablar con Soporte Humano
  if (data === 'menu_support') {
    await updateSession(chatId, { state: 'awaiting_support_message' });
    await answerCallbackQuery(callbackId);
    const promptText = [
      `👨‍💻 <b>Atención con Soporte Humano</b>`,
      ``,
      `Por favor, escribe en un mensaje tu consulta o explica brevemente lo ocurrido con tu recarga.`,
      `Un asesor de nuestro equipo recibirá tu caso al instante con tus datos y te responderá en breve.`,
    ].join('\n');

    await sendTelegramMessage(chatId, promptText, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Cancelar y Volver', callback_data: 'main_menu' }],
        ],
      },
    });
    return;
  }

  // 5. Reintento de Cliente (Rate-limited)
  if (data.startsWith('cli_retry_')) {
    const orderId = data.replace('cli_retry_', '').trim();
    const session = await getSession(chatId);

    // Rate-limit de 5 minutos entre reintentos por cliente
    const nowMs = Date.now();
    const lastRetry = session.lastClientRetryAt || 0;
    if (nowMs - lastRetry < 5 * 60_000) {
      const waitMinutes = Math.ceil((5 * 60_000 - (nowMs - lastRetry)) / 60_000);
      await answerCallbackQuery(
        callbackId,
        `⏳ Ya solicitaste un reintento hace poco. Por favor espera ${waitMinutes} min o comunícate con soporte.`,
        true
      );
      return;
    }

    await answerCallbackQuery(callbackId, '🔄 Ejecutando reintento de despacho...');
    await updateSession(chatId, { lastClientRetryAt: nowMs });

    try {
      await dispatchOrder(orderId, { isRetry: true, actorUid: 'telegram_client' });
      const snap = await orders().doc(orderId).get();
      const freshOrder = snap.exists ? ({ id: snap.id, ...snap.data() } as Order) : null;

      if (freshOrder && freshOrder.status === 'completed') {
        await sendTelegramMessage(
          chatId,
          `🎉 ¡Buenas noticias! Tu recarga de <b>${escapeHtml(freshOrder.productName || 'Juego')}</b> ha sido completada exitosamente.`,
          { reply_markup: buildMainMenuKeyboard() }
        );
      } else {
        await sendTelegramMessage(
          chatId,
          `⚠️ El reintento no pudo entregarse de forma automática en este momento y fue asignado a revisión de soporte. Un asesor atenderá tu caso.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '👨‍💻 Hablar con Soporte Humano', callback_data: 'menu_support' }],
                [{ text: '⬅️ Menú Principal', callback_data: 'main_menu' }],
              ],
            },
          }
        );
      }
    } catch (err) {
      log.error('Error en reintento de cliente vía Telegram', { orderId, error: String(err) });
      await sendTelegramMessage(chatId, '❌ Ocurrió un inconveniente al reintentar. Por favor contacta a soporte.', {
        reply_markup: buildMainMenuKeyboard(),
      });
    }
    return;
  }

  // 6. ACCIONES EXCLUSIVAS DE ADMINISTRADOR
  if (data.startsWith('adm_')) {
    if (!isAdmin) {
      await answerCallbackQuery(callbackId, '⛔ Acción exclusiva de Administrador.', true);
      return;
    }

    // 6.1 Reintento manual por Admin
    if (data.startsWith('adm_retry_')) {
      const orderId = data.replace('adm_retry_', '').trim();
      await answerCallbackQuery(callbackId, '🔄 Reintentando despacho en proveedor...');
      try {
        const outcome = await dispatchOrder(orderId, { isRetry: true, actorUid: 'telegram_admin' });
        const snap = await orders().doc(orderId).get();
        if (snap.exists) {
          const freshOrder = { id: snap.id, ...snap.data() } as Order;
          const view = renderAdminOrderView(freshOrder);
          await sendTelegramMessage(chatId, `🔄 Resultado del reintento: <b>${escapeHtml(outcome.status)}</b>\n\n${view.text}`, {
            reply_markup: view.keyboard,
          });
        }
      } catch (err) {
        await sendTelegramMessage(chatId, `❌ Error al reintentar despacho: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // 6.2 Marcar como completada manual por Admin
    if (data.startsWith('adm_comp_')) {
      const orderId = data.replace('adm_comp_', '').trim();
      await answerCallbackQuery(callbackId, '✅ Marcando orden como completada...');
      try {
        const syntheticAdmin: AuthUser = {
          uid: 'telegram_admin',
          email: 'admin@refillstore.com',
          emailVerified: true,
          displayName: 'Admin Telegram',
          photoURL: null,
          role: 'admin',
          isAdmin: true,
          isStaff: true,
          authTime: Math.floor(Date.now() / 1000),
        };

        const completed = await markCompleted(syntheticAdmin, orderId, 'Completada vía Telegram Admin Bot');
        const view = renderAdminOrderView(completed);
        await sendTelegramMessage(chatId, `✅ <b>Orden marcada como COMPLETADA con éxito.</b>\n\n${view.text}`, {
          reply_markup: view.keyboard,
        });
      } catch (err) {
        await sendTelegramMessage(chatId, `❌ Error al completar orden: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // 6.3 Sincronizar estado con proveedor en vivo
    if (data.startsWith('adm_sync_')) {
      const orderId = data.replace('adm_sync_', '').trim();
      await answerCallbackQuery(callbackId, '🔍 Sincronizando con proveedor en vivo...');
      try {
        const syncResult = await checkOrderProviderStatus(orderId, 'telegram_admin');
        const snap = await orders().doc(orderId).get();
        if (snap.exists) {
          const freshOrder = { id: snap.id, ...snap.data() } as Order;
          const view = renderAdminOrderView(freshOrder);
          await sendTelegramMessage(
            chatId,
            `🔍 <b>Resultado de Sincronización:</b>\n• Estado: <b>${escapeHtml(syncResult.orderStatus)}</b>\n• Resumen: ${escapeHtml(syncResult.summary)}\n\n${view.text}`,
            { reply_markup: view.keyboard }
          );
        }
      } catch (err) {
        await sendTelegramMessage(chatId, `❌ Error al sincronizar con proveedor: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
  }

  // Callback no reconocido
  await answerCallbackQuery(callbackId);
}

// --- Escalamiento a Soporte Humano ------------------------------------------

async function handleSupportEscalation(
  message: NonNullable<TelegramUpdate['message']>,
  session: TelegramSupportSession
): Promise<void> {
  const chatId = String(message.chat.id);
  const text = message.text?.trim() || '';
  const from = message.from;

  const config = await getConfig();
  const adminChatId = config.alerts?.telegramChatId?.trim() || process.env.ADMIN_TELEGRAM_CHAT_ID?.trim();

  // Nombre y enlace al chat del cliente
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || 'Cliente Telegram';
  const username = from?.username ? `@${from.username}` : 'Sin @username';
  const chatUrl = from?.username
    ? `https://t.me/${from.username}`
    : `tg://user?id=${from?.id || chatId}`;

  // Si había una orden asociada previamente en la sesión
  let lastOrder: Order | null = null;
  if (session.lastOrderId) {
    try {
      const snap = await orders().doc(session.lastOrderId).get();
      if (snap.exists) {
        lastOrder = { id: snap.id, ...snap.data() } as Order;
      }
    } catch {
      // Ignorar si no carga
    }
  }

  // Notificar al administrador si está configurado
  if (adminChatId) {
    const adminAlertText = [
      `🚨 <b>NUEVA SOLICITUD DE SOPORTE HUMANO</b>`,
      ``,
      `👤 <b>Cliente:</b> ${escapeHtml(fromName)} (${escapeHtml(username)})`,
      `🆔 <b>Telegram ID:</b> <code>${escapeHtml(String(from?.id || chatId))}</code>`,
      lastOrder ? `📦 <b>Orden asociada:</b> <code>${escapeHtml(lastOrder.code || lastOrder.id)}</code> (${escapeHtml(lastOrder.status)})` : '',
      ``,
      `💬 <b>Mensaje del cliente:</b>`,
      `<i>"${escapeHtml(text)}"</i>`,
    ].filter(Boolean).join('\n');

    const adminButtons: TelegramInlineButton[][] = [
      [{ text: '💬 Abrir Chat con Cliente', url: chatUrl }],
    ];

    // Si la orden asociada no está completada, anexar botones de control en la misma alerta
    if (lastOrder && ['in_review', 'failed', 'awaiting_manual', 'pending', 'dispatching'].includes(lastOrder.status)) {
      adminButtons.push([
        { text: '🔄 Reintentar Despacho', callback_data: `adm_retry_${lastOrder.id}` },
        { text: '✅ Marcar Completada', callback_data: `adm_comp_${lastOrder.id}` },
      ]);
      adminButtons.push([
        { text: '🔍 Sincronizar Proveedor', callback_data: `adm_sync_${lastOrder.id}` },
      ]);
    }

    await sendTelegramMessage(adminChatId, adminAlertText, {
      reply_markup: { inline_keyboard: adminButtons },
    });
  } else {
    log.warn('Soporte Humano: No hay telegramChatId configurado en alerts para notificar al admin');
  }

  // Limpiar estado de la sesión
  await updateSession(chatId, { state: null });

  // Responder al cliente confirmándole la recepción
  const confirmationText = [
    `✅ <b>¡Tu mensaje ha sido enviado a nuestro equipo!</b>`,
    ``,
    `Un asesor humano ha recibido tu notificación con tus datos y se comunicará contigo a la brevedad.`,
    ``,
    `Si deseas realizar otra consulta, puedes volver al menú principal.`,
  ].join('\n');

  await sendTelegramMessage(chatId, confirmationText, {
    reply_markup: buildMainMenuKeyboard(),
  });
}
