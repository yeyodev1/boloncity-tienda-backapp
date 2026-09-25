import crypto from "crypto";
import { AbandonedCart } from "../models/AbandonedCart";
import { normalizePhone } from "../utils/phone";
import { isSendablePhone, sendWhatsapp, whatsappChannel } from "./whatsappSender.service";

/**
 * Minutos de silencio tras los cuales un carrito se considera abandonado.
 * Corto de mas y se le escribe a alguien que todavia esta comprando; largo de mas y el antojo
 * ya paso. 45 minutos es el punto medio para comida preparada.
 */
export const MINUTOS_PARA_ABANDONO = Number(process.env.CART_ABANDON_MINUTES || 45);

/** Pasado esto ya no se escribe: un recordatorio de ayer es spam, no una venta. */
export const HORAS_PARA_EXPIRAR = Number(process.env.CART_EXPIRE_HOURS || 24);

/** Un solo mensaje por carrito. Insistir quema el numero y el permiso de Meta. */
export const MAXIMO_MENSAJES = 1;

/** Cuantos se procesan por corrida del cron, para no pasarse del tiempo de la funcion. */
const LOTE = 25;

export function nuevoTokenCarrito() {
  return crypto.randomBytes(16).toString("hex");
}

/** El link que viaja por WhatsApp y devuelve al cliente su carrito armado. */
export function linkDeRecuperacion(token: string) {
  const base = (process.env.PUBLIC_WEB_URL || "https://boloncity.com").replace(/\/+$/, "");
  return `${base}/carrito/recuperar/${token}`;
}

/**
 * El texto del recordatorio. Vive aca y no en el controlador para que sea el MISMO en el cron,
 * en la prueba manual del tablero y en cualquier reenvio futuro.
 */
export function mensajeDeRecuperacion(nombre: string, token: string) {
  const saludo = nombre?.trim() ? `Hola ${nombre.trim().split(" ")[0]} 👋` : "Hola 👋";
  return [
    saludo,
    "",
    "Vimos que dejaste pendiente tu pedido en Boloncity 🫓",
    "Tu carrito todavía te está esperando 🛒",
    "",
    `Sigue tu compra aquí: ${linkDeRecuperacion(token)}`,
  ].join("\n");
}

interface TrackInput {
  sessionId: string;
  items: { product?: string; name?: string; price?: number; quantity?: number; image?: string }[];
  subtotal?: number;
  stage?: "cart" | "checkout" | "contact_ready";
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  branch?: string | null;
  user?: string | null;
}

/**
 * Registra o actualiza el carrito vivo de una sesion.
 *
 * Es un upsert por `sessionId` a proposito: el checkout avisa cada vez que el cliente cambia algo,
 * y sin esto cada tecla habria creado un documento nuevo y las metricas contarian decenas de
 * carritos abandonados por persona.
 *
 * Un carrito ya recuperado NO se reabre: si vuelve a comprar, eso es una venta nueva.
 */
export async function trackCart(input: TrackInput) {
  const sessionId = String(input.sessionId || "").trim();
  if (!sessionId) return null;

  const items = (input.items || [])
    .filter((i) => Number(i.quantity) > 0)
    .map((i) => ({
      product: i.product || null,
      name: String(i.name || ""),
      price: Math.max(0, Math.round(Number(i.price) || 0)),
      quantity: Math.max(1, Math.round(Number(i.quantity) || 1)),
      image: i.image || "",
    }));

  const existente = await AbandonedCart.findOne({ sessionId });
  // Vaciar el carrito no es abandonarlo: es arrepentirse. No debe contar como carrito perdido.
  if (!items.length) {
    if (existente && existente.status === "pending") await AbandonedCart.deleteOne({ _id: existente._id });
    return null;
  }
  if (existente?.status === "recovered") return existente;

  const telefono = normalizePhone(input.customerPhone || "")?.e164 || "";
  const subtotal = Number.isFinite(Number(input.subtotal))
    ? Math.max(0, Math.round(Number(input.subtotal)))
    : items.reduce((s, i) => s + i.price * i.quantity, 0);

  const campos: Record<string, unknown> = {
    items,
    subtotal,
    lastActivityAt: new Date(),
    stage: input.stage || "cart",
  };
  // Los datos de contacto solo se sobrescriben cuando llega algo: si el cliente borra el campo
  // para corregirlo, no se puede perder el telefono que ya habiamos capturado.
  if (input.customerName?.trim()) campos.customerName = input.customerName.trim();
  if (telefono) campos.customerPhone = telefono;
  if (input.customerEmail?.trim()) campos.customerEmail = input.customerEmail.trim().toLowerCase();
  if (input.branch) campos.branch = input.branch;
  if (input.user) campos.user = input.user;

  return AbandonedCart.findOneAndUpdate(
    { sessionId },
    { $set: campos, $setOnInsert: { token: nuevoTokenCarrito(), status: "pending" } },
    { new: true, upsert: true }
  );
}

/**
 * Cierra el carrito cuando el cliente termina comprando.
 *
 * Se llama al crear CUALQUIER pedido, no solo los que vienen del link: un carrito que termino en
 * venta no es un carrito abandonado, aunque el cliente haya vuelto solo. La diferencia queda en
 * `recoveredFromLink`, que es lo que separa la venta que trajo la automatizacion.
 */
export async function marcarCarritoRecuperado(order: {
  _id: unknown;
  orderNumber?: string;
  total?: number;
  customerEmail?: string;
  customerPhone?: string;
}, sessionId?: string) {
  const email = order.customerEmail?.trim().toLowerCase();
  const telefono = normalizePhone(order.customerPhone || "")?.e164;

  const condiciones: Record<string, unknown>[] = [];
  if (sessionId) condiciones.push({ sessionId });
  if (email) condiciones.push({ customerEmail: email });
  if (telefono) condiciones.push({ customerPhone: telefono });
  if (!condiciones.length) return null;

  const carrito = await AbandonedCart.findOne({ $or: condiciones, status: { $ne: "recovered" } }).sort({ lastActivityAt: -1 });
  if (!carrito) return null;

  carrito.set("status", "recovered");
  carrito.set("recoveredOrder", order._id);
  carrito.set("recoveredOrderNumber", order.orderNumber || "");
  carrito.set("recoveredAt", new Date());
  carrito.set("recoveredTotal", Math.max(0, Math.round(Number(order.total) || 0)));
  carrito.set("recoveredFromLink", Boolean(carrito.clickedAt));
  await carrito.save();
  return carrito;
}

/**
 * Manda los recordatorios pendientes. La llama el cron.
 *
 * Reglas duras, porque cada una evita un problema concreto:
 *   - solo carritos con mas de MINUTOS_PARA_ABANDONO de silencio (no molestar a quien compra);
 *   - solo con telefono utilizable (sin eso el mensaje no existe);
 *   - un mensaje por carrito (no acosar, no quemar el numero);
 *   - los que pasaron HORAS_PARA_EXPIRAR se marcan expirados y ya no se tocan.
 */
export async function enviarRecordatoriosPendientes() {
  const ahora = Date.now();
  const corte = new Date(ahora - MINUTOS_PARA_ABANDONO * 60_000);
  const vencimiento = new Date(ahora - HORAS_PARA_EXPIRAR * 3_600_000);

  const expirados = await AbandonedCart.updateMany(
    { status: { $in: ["pending", "unreachable"] }, lastActivityAt: { $lt: vencimiento } },
    { $set: { status: "expired" } }
  );

  const candidatos = await AbandonedCart.find({
    status: "pending",
    lastActivityAt: { $lte: corte, $gte: vencimiento },
    notifyCount: { $lt: MAXIMO_MENSAJES },
  })
    .sort({ lastActivityAt: 1 })
    .limit(LOTE);

  const resumen = { revisados: candidatos.length, enviados: 0, sinTelefono: 0, fallidos: 0, expirados: expirados.modifiedCount, canal: whatsappChannel() };

  for (const carrito of candidatos) {
    if (!isSendablePhone(carrito.customerPhone)) {
      carrito.set("status", "unreachable");
      carrito.set("notifyError", "Sin teléfono utilizable");
      await carrito.save();
      resumen.sinTelefono += 1;
      continue;
    }

    const resultado = await sendWhatsapp({
      phone: carrito.customerPhone,
      message: mensajeDeRecuperacion(carrito.customerName, carrito.token),
      template: process.env.WHATSAPP_CART_TEMPLATE
        ? {
            name: String(process.env.WHATSAPP_CART_TEMPLATE),
            language: process.env.WHATSAPP_CART_TEMPLATE_LANG || "es",
            variables: [carrito.customerName?.trim().split(" ")[0] || "", linkDeRecuperacion(carrito.token)],
          }
        : undefined,
    });

    if (resultado.sent) {
      carrito.set("status", "notified");
      carrito.set("notifiedAt", new Date());
      carrito.set("notifyCount", (carrito.notifyCount || 0) + 1);
      carrito.set("notifyChannel", resultado.channel);
      carrito.set("notifyError", "");
      resumen.enviados += 1;
    } else {
      // Se deja pendiente a proposito: si el canal estaba caido, la proxima corrida reintenta.
      carrito.set("notifyError", resultado.error || "No se pudo enviar");
      resumen.fallidos += 1;
    }
    await carrito.save();
  }

  return resumen;
}

/**
 * Las cinco metricas del embudo, en una sola consulta por rango de fechas.
 * Los importes salen en centavos, como todo el resto del sistema.
 */
export async function metricasDeCarritos(desde?: Date, hasta?: Date) {
  const filtro: Record<string, unknown> = {};
  if (desde || hasta) {
    filtro.createdAt = { ...(desde ? { $gte: desde } : {}), ...(hasta ? { $lte: hasta } : {}) };
  }

  const carritos = await AbandonedCart.find(filtro).select(
    "status customerPhone customerEmail subtotal notifiedAt clickedAt recoveredAt recoveredTotal recoveredFromLink"
  );

  const abandonados = carritos.filter((c) => c.status !== "recovered");
  const conDatos = carritos.filter((c) => Boolean(c.customerPhone || c.customerEmail));
  const mensajes = carritos.filter((c) => Boolean(c.notifiedAt));
  const volvieron = carritos.filter((c) => Boolean(c.clickedAt));
  const recuperados = carritos.filter((c) => c.status === "recovered" && c.recoveredFromLink);

  const valorRecuperado = recuperados.reduce((s, c) => s + (c.recoveredTotal || 0), 0);
  const valorPerdido = abandonados.reduce((s, c) => s + (c.subtotal || 0), 0);

  return {
    carritosAbandonados: abandonados.length,
    conDatosDeContacto: conDatos.length,
    mensajesEnviados: mensajes.length,
    volvieronDesdeElMensaje: volvieron.length,
    ventasRecuperadas: recuperados.length,
    /** Centavos. Solo cuenta lo que paso por el link: es el retorno real de la automatizacion. */
    valorRecuperado,
    /** Centavos en carritos que siguen sin cerrarse. */
    valorPerdido,
    /** De los que recibieron mensaje, cuantos abrieron el link. */
    tasaDeApertura: mensajes.length ? Math.round((volvieron.length / mensajes.length) * 1000) / 10 : 0,
    /** De los que recibieron mensaje, cuantos terminaron comprando. */
    tasaDeRecuperacion: mensajes.length ? Math.round((recuperados.length / mensajes.length) * 1000) / 10 : 0,
    canal: whatsappChannel(),
  };
}
