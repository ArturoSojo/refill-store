/**
 * Piezas puras de la Fase 3: métodos de pago, datos copiables y mensajes según
 * el estado de la orden. No usan React: sólo transforman datos que ya entregan
 * los hooks y la API existentes.
 */
import { describeOrder } from '@/lib/orderItem';
import { formatBs, formatUsd } from '@/lib/format';
import { onlyDigits } from '@/lib/utils';
import type { Order, PaymentInstructions, PublicConfig } from '@/types/models';
import type { ChatCopyField, ChatMessage, ChatOption, ChatPaymentMethod } from './types';

export const PHONE_PATTERN = /^[\d+\s()-]{7,20}$/;

const METHOD_LABEL: Record<ChatPaymentMethod, string> = {
  pagomovil_bdv: '📱 Pago Móvil',
  transfer: '🏦 Transferencia',
  binance_pay: '🪙 Binance Pay',
};

export function methodLabel(method: ChatPaymentMethod): string {
  return METHOD_LABEL[method];
}

/** Métodos configurados en la tienda: Pago Móvil siempre, el resto según el panel. */
export function paymentMethodOptions(
  config: Pick<PublicConfig, 'transfer' | 'binancePay'> | null | undefined
): ChatOption[] {
  const methods: ChatPaymentMethod[] = ['pagomovil_bdv'];
  if (config?.transfer?.enabled) methods.push('transfer');
  if (config?.binancePay?.enabled) methods.push('binance_pay');
  return methods.map((method) => ({ id: `method:${method}`, label: METHOD_LABEL[method] }));
}

/** Mismos datos y mismo orden que `PaymentStep`. */
export function paymentCopyFields(payment: PaymentInstructions): ChatCopyField[] {
  const { bank } = payment;

  if (payment.method === 'binance_pay') {
    return [
      { label: 'Binance Pay ID', value: bank.binancePayId ?? '', emphasis: true },
      {
        label: 'Monto a enviar',
        value: payment.amountUsd.toFixed(2),
        display: `${formatUsd(payment.amountUsd)} USDT`,
        emphasis: true,
      },
    ];
  }

  const isTransfer = payment.method === 'transfer';
  return [
    { label: 'Banco', value: bank.code, display: `${bank.code} · ${bank.name}` },
    {
      label: isTransfer ? 'Cédula / RIF' : 'Cédula',
      value: bank.idNumber.replace(/[^\dVEJGvejg-]/g, ''),
      display: bank.idNumber,
    },
    isTransfer
      ? {
          label: `Cuenta ${bank.accountType === 'ahorro' ? 'de ahorro' : 'corriente'}`,
          value: onlyDigits(bank.accountNumber ?? ''),
          display: bank.accountNumber ?? '',
        }
      : { label: 'Teléfono', value: onlyDigits(bank.phone), display: bank.phone },
    {
      label: 'Monto exacto',
      value: payment.amountBs.toFixed(2),
      display: `${formatBs(payment.amountBs)} Bs`,
      emphasis: true,
    },
  ];
}

/** Reglas de la referencia según el método (Binance acepta letras; el banco sólo dígitos). */
export function referenceRules(payment: PaymentInstructions) {
  const isBinance = payment.method === 'binance_pay';
  const min = payment.referenceMinLength;
  const max = payment.referenceMaxLength;

  return {
    isBinance,
    min,
    max,
    sanitize: (text: string) =>
      (isBinance ? text.toUpperCase().replace(/[^A-Z0-9]/g, '') : onlyDigits(text)).slice(0, max),
    isValid: (reference: string) => reference.length >= min && reference.length <= max,
    invalidMessage: isBinance
      ? `El código debe tener entre ${min} y ${max} caracteres (letras y números).`
      : `La referencia debe tener entre ${min} y ${max} dígitos. Escribe sólo los números.`,
  };
}

type BotMessage = Omit<ChatMessage, 'id' | 'from'>;

/** Mensaje de pago: instrucciones exactas + datos copiables. */
export function paymentInstructionMessages(payment: PaymentInstructions, orderCode: string): BotMessage[] {
  const isBinance = payment.method === 'binance_pay';
  const amount = isBinance ? `${formatUsd(payment.amountUsd)} USDT` : `${formatBs(payment.amountBs)} Bs`;
  const minutes = Math.max(0, Math.round((payment.expiresAt - Date.now()) / 60_000));

  return [
    {
      text: [
        `✅ Orden ${orderCode} creada. La tasa quedó congelada.`,
        `Paga exactamente ${amount} en los próximos ${minutes} min. Toca cualquier dato para copiarlo:`,
      ].join('\n'),
      copyFields: paymentCopyFields(payment),
    },
  ];
}

/** Mensajes según el estado en vivo de la orden. `null` = nada que anunciar. */
export function liveOrderMessages(order: Order, supportUrl?: string): BotMessage[] | null {
  switch (order.status) {
    case 'verifying':
      return [{ text: 'Verificando pago…', progress: true }];

    case 'paid':
    case 'dispatching':
      return [{ text: 'Pago confirmado ✅. Estamos entregando tu recarga…', progress: true }];

    case 'completed': {
      const codes = order.deliveredCodes ?? [];
      return [
        {
          text: [
            '🎉 ¡Recarga entregada!',
            `📦 ${describeOrder(order)}`,
            ...(order.playerId ? [`👤 ID: ${order.playerId}`] : []),
            `💵 Pagado: ${formatBs(order.pricing.totalBs)} Bs`,
            `🧾 Orden: ${order.code}`,
            ...(codes.length > 0 ? ['', 'Tus códigos digitales:'] : []),
          ].join('\n'),
          copyFields: codes.map((code, index) => ({
            label: `Código ${index + 1}`,
            value: code,
            emphasis: true,
          })),
          actions: [{ id: 'menu', label: '🔁 Hacer otra recarga' }],
        },
      ];
    }

    case 'awaiting_manual':
      return [
        {
          text: order.whatsappUrl
            ? 'Pago verificado ✅. Este producto lo activa un asesor: abre WhatsApp, el mensaje ya lleva tus datos.'
            : 'Pago verificado ✅. Este producto lo activa nuestro equipo a mano; te avisaremos por notificación y correo apenas esté listo.',
          actions: [
            ...(order.whatsappUrl ? [{ id: 'wa', label: '💬 Abrir WhatsApp' }] : []),
            { id: 'menu', label: '🔁 Hacer otra recarga' },
          ],
        },
      ];

    case 'failed':
      return [
        {
          text: 'Tu pago está confirmado, pero la entrega falló. El equipo ya lo está revisando.',
          actions: [
            ...(supportUrl ? [{ id: 'support', label: '🛟 Hablar con soporte' }] : []),
            { id: 'menu', label: '🏠 Menú principal' },
          ],
        },
      ];

    case 'payment_rejected':
      return [
        {
          text: 'El banco no pudo confirmar ese pago. Revisa el monto exacto y vuelve a intentarlo.',
          actions: [
            { id: 'retry:ref', label: '🔄 Reintentar referencia' },
            { id: 'cancel:order', label: '✖️ Cancelar orden' },
          ],
        },
      ];

    case 'expired':
    case 'cancelled':
    case 'refunded':
      return [
        {
          text:
            order.status === 'expired'
              ? 'La orden expiró. Crea una nueva para que el monto se calcule con la tasa vigente.'
              : 'La orden ya no está activa.',
          actions: [{ id: 'menu', label: '🔁 Hacer otra recarga' }],
        },
      ];

    default:
      return null;
  }
}
