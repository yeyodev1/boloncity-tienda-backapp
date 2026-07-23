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
        `<tr><td style="padding:8px 0;border-bottom:1px solid #eef1e6;font-size:14px;">${item.name} <span style="color:#888;">x${item.quantity}</span></td><td style="padding:8px 0;border-bottom:1px solid #eef1e6;text-align:right;font-size:14px;">$${centsToDollars(item.price * item.quantity).toFixed(2)}</td></tr>`
    )
    .join("");

  const driverHtml = data.driverName
    ? `<tr><td style="padding:12px 0 4px;font-size:14px;"><strong>🛵 Tu delivery</strong></td></tr><tr><td style="padding:0 0 12px;font-size:14px;color:#333;">${data.driverName}</td></tr>`
    : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.04);">
      <tr><td style="background:linear-gradient(135deg,#235931,#102719);padding:32px 32px 24px;text-align:center;">
        <div style="font-size:40px;margin-bottom:8px;">${emoji}</div>
        <h1 style="color:#efd537;font-size:22px;margin:0 0 4px;letter-spacing:-0.02em;">${data.statusText}</h1>
        <p style="color:rgba(255,255,255,0.7);font-size:14px;margin:0;">Pedido <strong style="color:#fff;">${data.orderNumber}</strong></p>
      </td></tr>
      <tr><td style="padding:24px 32px 0;">
        <p style="font-size:15px;margin:0 0 16px;color:#333;">Hola <strong>${data.customerName}</strong>,</p>
        <p style="font-size:14px;margin:0 0 16px;color:#555;line-height:1.5;">${getStatusDescription(data.status, data.driverName)}</p>

        ${driverHtml ? `<table width="100%" style="margin-bottom:8px;">${driverHtml}</table>` : ""}

        <table width="100%" style="margin-bottom:8px;">
          <tr><td colspan="2" style="padding:12px 0 4px;border-top:1px solid #eef1e6;font-size:13px;font-weight:700;color:#235931;text-transform:uppercase;letter-spacing:0.05em;">Productos</td></tr>
          ${itemsHtml}
          <tr><td style="padding:12px 0 8px;font-size:15px;font-weight:700;">Total</td><td style="padding:12px 0 8px;text-align:right;font-size:15px;font-weight:700;color:#235931;">$${centsToDollars(data.total).toFixed(2)}</td></tr>
        </table>

        <a href="${data.detailUrl}" target="_blank" style="display:block;text-align:center;background:#235931;color:#fff;text-decoration:none;padding:14px 24px;border-radius:12px;font-size:15px;font-weight:700;margin:16px 0 0;">Ver detalle de mi pedido</a>
      </td></tr>
      <tr><td style="padding:32px;text-align:center;color:#aaa;font-size:12px;">
        Boloncity — Todos los derechos reservados.
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

function getStatusDescription(status: string, driverName?: string): string {
  const descriptions: Record<string, string> = {
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
