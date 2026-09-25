import crypto from "crypto";
import { AbandonedCart } from "../models/AbandonedCart";
import { normalizePhone } from "../utils/phone";
import { getFrontendUrl } from "../config/env";
import { getCartRecoveryEmailHtml } from "./email-templates";
import { sendEmail } from "./resend.service";
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
  // Mismo dominio que el resto de correos: en develop el link tiene que abrir dev.boloncity.com.
  const base = (process.env.PUBLIC_WEB_URL || getFrontendUrl()).replace(/\/+$/, "");
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
      // El carrito de la web va en dolares (4.68): se guarda asi, con dos decimales.
      price: Math.max(0, Math.round((Number(i.price) || 0) * 100) / 100),
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
  // El subtotal si va en centavos, como los pedidos, para que el tablero lo compare con lo vendido.
  const dolares = Number.isFinite(Number(input.subtotal)) && input.subtotal !== undefined
    ? Number(input.subtotal)
    : items.reduce((s, i) => s + i.price * i.quantity, 0);
  const subtotal = Math.max(0, Math.round(dolares * 100));

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

type Carrito = InstanceType<typeof AbandonedCart>;

export interface NotifyResult {
  sent: boolean;
  /** Por donde salio: el canal de WhatsApp o "email". */
  channel: string;
  error?: string;
}

/**
 * Manda el recordatorio de UN carrito: primero WhatsApp y, si no sale (sin canal, sin telefono o
 * rechazado), por correo. Sin respaldo, un cliente que dejo su correo se quedaba sin nada mientras
 * no hubiera proveedor de WhatsApp. La usan el cron y el reenvio manual del tablero, asi los dos
 * mandan exactamente lo mismo.
 */
export async function notificarCarrito(carrito: Carrito): Promise<NotifyResult> {
  const errores: string[] = [];

  if (isSendablePhone(carrito.customerPhone) && whatsappChannel() !== "none") {
    const wa = await sendWhatsapp({
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
    if (wa.sent) return { sent: true, channel: wa.channel };
    errores.push(`WhatsApp: ${wa.error || "no se pudo enviar"}`);
  } else if (isSendablePhone(carrito.customerPhone)) {
    errores.push("WhatsApp: sin canal configurado");
  }

  if (carrito.customerEmail) {
    const html = getCartRecoveryEmailHtml({
      customerName: carrito.customerName,
      items: carrito.items.map((i: { name: string; quantity: number; price: number }) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      subtotal: carrito.subtotal,
      recoveryUrl: linkDeRecuperacion(carrito.token),
    });
    const correo = await sendEmail(carrito.customerEmail, "Boloncity: tu carrito todavía te está esperando 🛒", html);
    if (correo.ok) return { sent: true, channel: "email" };
    errores.push(`Correo: ${correo.error}`);
  }

  return { sent: false, channel: whatsappChannel(), error: errores.join(" · ") || "Sin teléfono ni correo" };
}

/** ¿Hay por donde escribirle? Telefono con canal activo, o correo. */
function esContactable(carrito: Carrito) {
  return Boolean(carrito.customerEmail) || isSendablePhone(carrito.customerPhone);
}

/**
 * Manda los recordatorios pendientes. La llama el cron.
 *
 * Reglas duras, porque cada una evita un problema concreto:
 *   - solo carritos con mas de MINUTOS_PARA_ABANDONO de silencio (no molestar a quien compra);
 *   - solo con telefono o correo (sin eso el mensaje no existe);
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

  const resumen = { revisados: candidatos.length, enviados: 0, porCorreo: 0, sinContacto: 0, fallidos: 0, expirados: expirados.modifiedCount, canal: whatsappChannel() };

  for (const carrito of candidatos) {
    if (!esContactable(carrito)) {
      carrito.set("status", "unreachable");
      carrito.set("notifyError", "Sin teléfono ni correo utilizable");
      await carrito.save();
      resumen.sinContacto += 1;
      continue;
    }

    const resultado = await notificarCarrito(carrito);

    if (resultado.sent) {
      carrito.set("status", "notified");
      carrito.set("notifiedAt", new Date());
      carrito.set("notifyCount", (carrito.notifyCount || 0) + 1);
      carrito.set("notifyChannel", resultado.channel);
      carrito.set("notifyError", "");
      resumen.enviados += 1;
      if (resultado.channel === "email") resumen.porCorreo += 1;
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
    /** El correo es el respaldo: con Resend configurado, los recordatorios salen aunque no haya WhatsApp. */
    correo: Boolean(process.env.RESEND_API_KEY),
  };
}
