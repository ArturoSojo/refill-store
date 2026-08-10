/**
 * Plantillas de los correos al cliente.
 *
 * Escritas con tablas y estilos en línea a propósito: los clientes de correo
 * ignoran las hojas de estilo y buena parte no entiende flexbox ni grid. Lo que
 * en la web sería una `div` con clases, aquí tiene que ser una `<table>`.
 *
 * El fondo va claro aunque la tienda sea oscura. Gmail y Outlook reescriben los
 * colores en modo oscuro de formas impredecibles, y un correo que se ve roto es
 * peor que uno sobrio.
 */
import { formatBs, formatUsd } from '../lib/money';
import { describeOrder } from '../lib/orderItem';
import type { AppConfig, Order, PlayerField } from '../types/models';

/** Los tres momentos en que se le escribe al cliente. */
export type EmailKind = 'payment_verified' | 'delivered' | 'dispatch_failed';

const MARCA = '#E2373B';
const TEXTO = '#1F2430';
const SUAVE = '#6B7280';
const BORDE = '#E5E7EB';

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(order: Order): string {
  try {
    return new Intl.DateTimeFormat('es-VE', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'America/Caracas',
    }).format(order.createdAt.toDate());
  } catch {
    return '';
  }
}

/** Fila de la tabla de datos. */
function row(label: string, value: string, opciones: { fuerte?: boolean } = {}): string {
  return `<tr>
    <td style="padding:9px 0;color:${SUAVE};font-size:14px;">${escape(label)}</td>
    <td style="padding:9px 0;text-align:right;font-size:14px;color:${TEXTO};${
      opciones.fuerte ? 'font-weight:700;' : ''
    }">${escape(value)}</td>
  </tr>`;
}

interface Contenido {
  titulo: string;
  cinta: string;
  cintaColor: string;
  mensaje: string;
  asunto: string;
}

function contenidoPara(kind: EmailKind, order: Order): Contenido {
  switch (kind) {
    case 'payment_verified':
      return {
        asunto: `Recibimos tu pago · Orden ${order.code}`,
        titulo: '¡Pago confirmado!',
        cinta: 'PAGO VERIFICADO',
        cintaColor: '#0E7A4E',
        mensaje:
          'Verificamos tu pago con el banco y ya estamos procesando tu recarga. ' +
          'Te avisamos apenas esté acreditada.',
      };
    case 'delivered':
      return {
        asunto: `Tu recarga está lista · Orden ${order.code}`,
        titulo: '¡Tu recarga fue entregada!',
        cinta: 'ENTREGADO',
        cintaColor: '#0E7A4E',
        mensaje:
          `Ya acreditamos ${escapeSafe(describeOrder(order))} en la cuenta ${escapeSafe(order.playerId)}. ` +
          'Entra al juego y revisa; si no lo ves de inmediato, cierra sesión y vuelve a entrar.',
      };
    case 'dispatch_failed':
      return {
        asunto: `Estamos resolviendo tu orden ${order.code}`,
        titulo: 'Estamos resolviendo tu recarga',
        cinta: 'EN REVISIÓN',
        cintaColor: '#B45309',
        mensaje:
          'Tu pago está confirmado, pero la entrega no se completó de forma automática. ' +
          'Nuestro equipo ya fue avisado y lo está resolviendo a mano. No hace falta que ' +
          'pagues de nuevo ni que crees otra orden.',
      };
  }
}

/** Igual que `escape`, pero pensado para incrustar en frases ya construidas. */
function escapeSafe(value: string | null | undefined): string {
  return escape(String(value ?? ''));
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderOrderEmail(
  kind: EmailKind,
  order: Order,
  config: AppConfig,
  playerFields: PlayerField[] = []
): RenderedEmail {
  const c = contenidoPara(kind, order);
  const pricing = order.pricing;

  // Los datos de la cuenta, con la etiqueta real de cada juego. Las contraseñas
  // no viajan por correo aunque el juego las pida.
  const camposJugador = (
    playerFields.length > 0
      ? playerFields
      : [{ key: 'playerId', label: 'ID de jugador', sensitive: false } as PlayerField]
  )
    .filter((field) => !field.sensitive)
    .map((field) => {
      const value =
        order.playerFields?.[field.key] ?? (field.key === 'playerId' ? order.playerId : '');
      return value ? row(field.label, value) : '';
    })
    .join('');

  const descuentos = [
    pricing.discountUsd > 0
      ? row(
          pricing.couponCode ? `Descuento (${pricing.couponCode})` : 'Descuento',
          `− ${formatUsd(pricing.discountUsd)}`
        )
      : '',
    (pricing.walletAppliedUsd ?? 0) > 0
      ? row('Saldo a favor aplicado', `− ${formatUsd(pricing.walletAppliedUsd)}`)
      : '',
  ].join('');

  const totalBs = pricing.totalBs > 0 ? `${formatBs(pricing.totalBs)} Bs` : 'Pagado con saldo';

  const soporte = config.whatsapp?.supportNumber
    ? `https://wa.me/${config.whatsapp.supportNumber.replace(/\D/g, '')}`
    : null;

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <!-- Resumen que algunos clientes muestran junto al asunto en la bandeja. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(c.mensaje.slice(0, 120))}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid ${BORDE};">

        <tr><td style="background:${TEXTO};padding:20px 28px;">
          <span style="color:#FFFFFF;font-size:19px;font-weight:700;">${escape(config.storeName)}</span>
        </td></tr>

        <tr><td style="padding:28px 28px 8px;">
          <span style="display:inline-block;background:${c.cintaColor};color:#FFFFFF;font-size:11px;font-weight:700;letter-spacing:.6px;padding:5px 11px;border-radius:999px;">${escape(c.cinta)}</span>
          <h1 style="margin:14px 0 8px;font-size:22px;color:${TEXTO};">${escape(c.titulo)}</h1>
          <p style="margin:0;font-size:15px;line-height:1.55;color:${SUAVE};">${c.mensaje}</p>
        </td></tr>

        <tr><td style="padding:20px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr><td colspan="2" style="padding-bottom:6px;font-size:12px;font-weight:700;letter-spacing:.5px;color:${SUAVE};border-bottom:1px solid ${BORDE};">DETALLE DE LA COMPRA</td></tr>
            ${row('Orden', order.code, { fuerte: true })}
            ${row('Fecha', formatDate(order))}
            ${row('Juego', order.gameName)}
            ${row('Paquete', describeOrder(order))}
            ${camposJugador}
          </table>
        </td></tr>

        <tr><td style="padding:18px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr><td colspan="2" style="padding-bottom:6px;font-size:12px;font-weight:700;letter-spacing:.5px;color:${SUAVE};border-bottom:1px solid ${BORDE};">PAGO</td></tr>
            ${row('Subtotal', formatUsd(pricing.subtotalUsd))}
            ${descuentos}
            ${order.payment.reference ? row('Referencia', order.payment.reference) : ''}
            ${pricing.totalBs > 0 ? row('Tasa aplicada', `${formatBs(pricing.rate)} Bs / $`) : ''}
            <tr><td colspan="2" style="padding-top:10px;border-top:2px solid ${TEXTO};"></td></tr>
            <tr>
              <td style="padding:10px 0;font-size:15px;font-weight:700;color:${TEXTO};">Total pagado</td>
              <td style="padding:10px 0;text-align:right;">
                <span style="display:block;font-size:20px;font-weight:800;color:${MARCA};">${escape(totalBs)}</span>
                <span style="display:block;font-size:12px;color:${SUAVE};">${escape(formatUsd(pricing.totalUsd))}</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="padding:22px 28px 28px;">
          <p style="margin:0 0 4px;font-size:13px;line-height:1.6;color:${SUAVE};">
            ¿Alguna duda con esta orden? Responde a este correo${
              soporte ? ` o escríbenos por <a href="${soporte}" style="color:${MARCA};">WhatsApp</a>` : ''
            }.
          </p>
          <p style="margin:0;font-size:12px;color:#9CA3AF;">
            Este correo es el comprobante de tu orden ${escape(order.code)}. Consérvalo.
          </p>
        </td></tr>

      </table>
      <p style="max-width:560px;margin:14px auto 0;font-size:11px;color:#9CA3AF;text-align:center;">
        ${escape(config.storeName)} · Recargas para tus juegos
      </p>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    c.titulo,
    '',
    c.mensaje.replace(/<[^>]+>/g, ''),
    '',
    `Orden: ${order.code}`,
    `Fecha: ${formatDate(order)}`,
    `Juego: ${order.gameName}`,
    `Paquete: ${describeOrder(order)}`,
    `Cuenta recargada: ${order.playerId}`,
    order.payment.reference ? `Referencia: ${order.payment.reference}` : '',
    `Total: ${totalBs} (${formatUsd(pricing.totalUsd)})`,
    '',
    `${config.storeName}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { subject: c.asunto, html, text };
}
