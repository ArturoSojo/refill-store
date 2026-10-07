/** Respuestas de autoservicio que no requieren consultar a Gemini ni datos de una cuenta. */
export interface SupportAnswer {
  reply: string;
  needsSupport: boolean;
  action?: 'start_recharge' | 'view_orders';
}

export interface KnownAnswerContext {
  paymentMethods: string[];
  orderExpiryMinutes: number;
  couponsEnabled: boolean;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function answer(reply: string, action?: SupportAnswer['action']): SupportAnswer {
  return { reply, needsSupport: false, ...(action ? { action } : {}) };
}

/**
 * Sólo intercepta intenciones inequívocas. Los problemas con pagos u órdenes
 * llegan al asistente con contexto; nunca se confunden con una compra nueva.
 */
export function answerKnownSupportQuestion(
  rawQuestion: string,
  context: KnownAnswerContext
): SupportAnswer | null {
  const question = normalize(rawQuestion);
  if (!question) return null;

  const hasProblem = /\b(no llego|no llega|no recibi|no aparece|no funciona|no puedo|no me deja|error|fallo|rechazad[ao]|ya pague|pague y|cobro|usad[ao]|duplicad[ao]|equivoque|cancelar mi|reembols[ao]|devolucion)\b/.test(question);

  if (!hasProblem && (
    /^(?:hola |buenas )?(?:quiero|quisiera|necesito|deseo|busco|me gustaria|voy a) (?:hacer |realizar )?(?:una? |mi )?(?:recarga|recargar|comprar|diamantes|monedas|paquete|gift card|tarjeta de regalo|game key)\b/.test(question) ||
    /^(?:como|donde) (?:puedo )?(?:recargar|comprar|hacer una recarga|conseguir diamantes)\b/.test(question) ||
    /^(?:recargar|comprar)(?: (?:ahora|diamantes|un paquete|free fire))?$/.test(question)
  )) {
    return answer(
      '¡Vamos a recargar! Pulsa «Empezar recarga» y te guío para elegir el juego, el paquete y los datos de tu cuenta. También puedes buscar el juego en el catálogo.',
      'start_recharge'
    );
  }

  if (/\b(?:donde|como) (?:puedo )?(?:ver|consultar|consulto|seguir|revisar) (?:mis?|las?)? ?(?:ordenes|pedidos|recargas)\b/.test(question) ||
      /\b(?:donde estan|donde veo) (?:mis?|las?)? ?(?:ordenes|pedidos|compras)\b/.test(question)) {
    return answer('En «Mis órdenes» puedes consultar tus compras y seguir su estado. Si alguna aparece en revisión o el estado no coincide con lo que ocurrió, dime el problema y te indico qué hacer.', 'view_orders');
  }

  if (!hasProblem && (
    /\b(?:que|cuales) (?:son )?(?:los )?metodos? de pago\b/.test(question) ||
    /\b(?:como|con que|donde) (?:puedo )?pagar\b/.test(question) ||
    /\b(?:aceptan|reciben) (?:pago movil|transferencia|binance|saldo)\b/.test(question)
  )) {
    const methods = context.paymentMethods;
    return answer(methods.length
      ? `Puedes pagar con ${methods.join(', ')}. Al crear la orden eliges el método y la página te muestra los datos y el monto correspondiente. Si ese método pide una referencia, regístrala en la misma orden después de pagar.`
      : 'Los métodos disponibles aparecen al crear la orden; elige tu producto para verlos.', 'start_recharge');
  }

  if (/\b(?:donde|como) (?:consigo|veo|encuentro|obtengo|busco) (?:el |la |mi )?(?:numero de )?referencia\b/.test(question) ||
      /\b(?:que es|cual es) (?:el |la )?(?:numero de )?referencia\b/.test(question)) {
    return answer('La referencia aparece en el comprobante o historial de tu banco después del Pago Móvil o la transferencia. Cópiala tal como la pide la orden y verifica el pago allí. No compartas datos bancarios en este chat.');
  }

  if (/\b(?:cuanto (?:tiempo )?(?:dura|tengo|demora)|cuando (?:vence|expira|caduca)|tiempo para pagar)\b/.test(question) &&
      /\b(?:orden|pedido|pagar|pago|referencia|recarga)\b/.test(question)) {
    return answer(`La orden tiene ${context.orderExpiryMinutes} minutos para pagar desde que se crea. Mira el contador de tu orden: si registras un pago parcial con otra referencia, el plazo puede actualizarse allí.`);
  }

  if (/\b(?:como|donde) (?:uso|pongo|aplico|canjeo|ingreso|meto) (?:un |el |mi )?(?:cupon|codigo de descuento)\b/.test(question) ||
      /\b(?:donde va|donde pongo) (?:el |mi )?(?:cupon|codigo)\b/.test(question)) {
    return answer(context.couponsEnabled
      ? 'Escribe tu código en «¿Tienes un código?» antes de elegir el paquete. La tienda comprueba si aplica a ese producto y a tu compra; verás el descuento antes de confirmar la orden.'
      : 'Los cupones no están habilitados ahora mismo. Si vuelven a estar disponibles, aparecerá el campo «¿Tienes un código?» en la compra.');
  }

  if (/\b(?:pago parcial|pagar por partes|pago de menos|pague de menos|pago menos|me falta dinero|pague menos)\b/.test(question) && !hasProblem) {
    return answer('Si pagas menos y el verificador encuentra ese movimiento, se registra como pago parcial en la misma orden. Paga sólo la diferencia y verifica la nueva referencia allí; no crees otra orden. Revisa siempre el importe pendiente que muestra la pantalla.');
  }

  if (/\b(?:pago de mas|pague de mas|pago mas|pague mas|excedente)\b/.test(question) && !hasProblem) {
    return answer('Si el pago verificado cubre el total, la orden puede seguir adelante. El excedente queda registrado para revisión del equipo; no se acredita automáticamente al saldo. Revisa el estado de tu orden para confirmar el resultado.');
  }

  if (/\b(?:como funcionan? los niveles|como subo de nivel|que (?:son|es) (?:los niveles|el descuento por nivel)|descuento por nivel)\b/.test(question) && !hasProblem) {
    return answer('Tu nivel depende de las compras acumuladas. Cada nivel puede tener un descuento diferente, configurado por la tienda; el beneficio que te corresponda se refleja en el precio antes de confirmar la orden. Puedes ver tu nivel en «Cuenta».');
  }

  return null;
}
