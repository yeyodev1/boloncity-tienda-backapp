function centsToDollars(cents: number): number {
  return cents / 100;
}

interface StatusEmailData {
  orderNumber: string;
  customerName: string;
  status: string;
  statusText: string;
  driverName?: string;
  detailUrl: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
}

const STATUS_EMOJIS: Record<string, string> = {
  pending: "⏳",
  paid: "✓",
  preparing: "👨‍🍳",
  ready: "🛍️",
  delivered: "✓",
  cancelled: "✕",
  ACCEPTED: "🛵",
  READY_FOR_PICKUP: "🔍",
  WAY_TO_DELIVER: "🚚",
  ARRIVED_AT_DELIVERY: "📍",
  COMPLETED: "✅",
  CANCELLED_BY_BUSINESS: "❌",
  PROVIDER_NOT_FOUND: "⚠️",
  ON_HOLD: "⏳",
};

export function getOrderStatusEmailHtml(data: StatusEmailData): string {
  const emoji = STATUS_EMOJIS[data.status] || "📦";
  const itemsHtml = data.items
    .map(
      (item) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #e5e5e5;font-size:14px;color:#111111;">${item.name} <span style="color:#111111;">x${item.quantity}</span></td><td style="padding:8px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-size:14px;color:#111111;">$${(item.price * item.quantity).toFixed(2)}</td></tr>`
    )
    .join("");

  const driverHtml = data.driverName
    ? `<tr><td style="padding:12px 0 4px;font-size:14px;color:#111111;"><strong>Tu delivery</strong></td></tr><tr><td style="padding:0 0 12px;font-size:14px;color:#111111;">${data.driverName}</td></tr>`
    : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111111;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #111111;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#ffffff;border-bottom:1px solid #111111;padding:32px 32px 24px;text-align:center;color:#111111;">
        <div style="font-size:40px;margin-bottom:8px;">${emoji}</div>
        <h1 style="color:#111111;font-size:22px;margin:0 0 4px;letter-spacing:-0.02em;">${data.statusText}</h1>
        <p style="color:#111111;font-size:14px;margin:0;">Pedido <strong style="color:#111111;">${data.orderNumber}</strong></p>
      </td></tr>
      <tr><td style="padding:24px 32px 0;">
        <p style="font-size:15px;margin:0 0 16px;color:#111111;">Hola <strong>${data.customerName}</strong>,</p>
        <p style="font-size:14px;margin:0 0 16px;color:#111111;line-height:1.5;">${getStatusDescription(data.status, data.driverName)}</p>

        ${driverHtml ? `<table width="100%" style="margin-bottom:8px;">${driverHtml}</table>` : ""}

        <table width="100%" style="margin-bottom:8px;">
          <tr><td colspan="2" style="padding:12px 0 4px;border-top:1px solid #111111;font-size:13px;font-weight:700;color:#111111;text-transform:uppercase;letter-spacing:0.05em;">Productos</td></tr>
          ${itemsHtml}
          <tr><td style="padding:12px 0 8px;font-size:15px;font-weight:700;color:#111111;">Total</td><td style="padding:12px 0 8px;text-align:right;font-size:15px;font-weight:700;color:#111111;">$${centsToDollars(data.total).toFixed(2)}</td></tr>
        </table>

        <a href="${data.detailUrl}" target="_blank" style="display:block;text-align:center;background:#ffffff;border:1px solid #111111;color:#111111;text-decoration:none;padding:14px 24px;border-radius:8px;font-size:15px;font-weight:700;margin:16px 0 0;">Ver detalle de mi pedido</a>
      </td></tr>
      <tr><td style="padding:32px;text-align:center;color:#111111;font-size:12px;">
        Boloncity — Todos los derechos reservados.
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

function getStatusDescription(status: string, driverName?: string): string {
  const descriptions: Record<string, string> = {
    pending: "Recibimos tu pedido. Estamos validando el pago para empezar a prepararlo.",
    paid: "Confirmamos tu pago. El local recibirá tu pedido para prepararlo.",
    preparing: "Tu pedido ya está en preparación dentro del local.",
    awaiting_pickup: "Tu pedido ya está preparado y espera la recolección del motorizado o tu retiro en sucursal.",
    ready: "Tu pedido salió del local y está en proceso de entrega.",
    delivered: "Tu pedido fue entregado con éxito. ¡Que lo disfrutes!",
    cancelled: "Tu pedido fue cancelado. Si tienes dudas, contáctanos.",
    ACCEPTED: `Un motorizado${
      driverName ? ` (${driverName})` : ""
    } ha sido asignado y está en camino al local para recoger tu pedido.`,
    READY_FOR_PICKUP: "Estamos buscando un motorizado disponible para tu pedido. Te notificaremos cuando uno sea asignado.",
    WAY_TO_DELIVER: "Tu pedido ya está en camino. El motorizado se dirige a tu dirección de entrega.",
    ARRIVED_AT_DELIVERY: "El motorizado ha llegado a tu dirección. Está listo para entregarte el pedido.",
    COMPLETED: "Tu pedido ha sido entregado con éxito. ¡Que lo disfrutes!",
    CANCELLED_BY_BUSINESS: "Tu pedido ha sido cancelado. Si tienes dudas, contáctanos.",
    PROVIDER_NOT_FOUND: "No encontramos un delivery disponible en este momento. Estamos trabajando para resolverlo.",
    ON_HOLD: "Tu pedido está en preparación. Pronto empezaremos la búsqueda de un motorizado.",
  };
  return descriptions[status] || "Tu pedido está siendo procesado. Te mantendremos informado.";
}
