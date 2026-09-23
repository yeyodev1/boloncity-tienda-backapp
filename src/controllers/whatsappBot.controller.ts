import axios from "axios";
import crypto from "crypto";
import { Request, Response } from "express";
import { Branch } from "../models/Branch";
import { Counter } from "../models/Counter";
import { Order } from "../models/Order";
import { Product } from "../models/Product";
import { extractIva, getActivePromo, getOrCreateSettings, promoDiscountCents } from "../models/Setting";
import { WhatsAppSession } from "../models/WhatsAppSession";
import { env, getFrontendUrl } from "../config/env";
import { bookPickerForOrder, reportPurchaseToMeta, sendOrderToRunfood } from "./order.controller";
import { getBranchAvailability, getBranchPayphoneStoreId, isBranchOpenAt, pickerEnabledBranchFilter, validateScheduledTime } from "../services/branchOperational.service";
import { quoteDelivery } from "../services/deliveryQuote.service";
import { calculateEarnedPoints } from "../services/points.service";
import { sendEmail } from "../services/resend.service";
import { getOrderDetailUrl, getOrderStatusEmailHtml } from "../services/email-templates";
import { distanceKm } from "../utils/haversine";
import { parseMapsUrl, resolveMapsCoordinates } from "../utils/parseMapsUrl";
import { normalizePhone } from "../utils/phone";
import { isAvailableAt } from "../utils/productAvailability";
import { loadCatalog, searchCatalog } from "../services/whatsappBot/catalog";
import { aiChooseOption, aiExtract } from "../services/whatsappBot/extractor";
import { claimsPaid, classifyConfirmReply, extractMapsUrl, extractOrderNumber } from "../services/whatsappBot/intents";
import { BotDeps, BotState, BuilderBotRoute, classifyRoute, createInitialState, handleTurn, LastOrder, LocationQuote, nextStep, OpeningWindow, PaymentSettlement, publicRoute, TurnResult } from "../services/whatsappBot/router";
import { settleCardPaymentByOrderNumber } from "../services/cardPaymentSettlement.service";

/** Las pruebas verifican con esto que ninguna ruta interna se escape hacia BuilderBot. */
export const botResponseRoute = publicRoute;

/**
 * Endpoints que llama BuilderBot. Toda la lógica de conversación vive en
 * services/whatsappBot/router.ts; aquí solo se carga/guarda la sesión y se
 * conectan las dependencias reales (Mongo, Picker, PayPhone, Gemini).
 *
 * Todas las rutas responden HTTP 200 aunque falle algo: BuilderBot trata un 4xx/5xx
 * como error del nodo y el cliente se queda sin respuesta.
 */

const SUPPORT_PHONE = "+593 99 315 7333";
/** Sucursales que se cotizan por delivery en un mensaje. Cada cotización puede tardar hasta 8 s en Picker. */
const MAX_BRANCHES_TO_QUOTE = 3;
/** Además de las más cercanas se cotizan hasta 2 sucursales ABIERTAS, para poder ofrecer una alternativa. */
const MAX_OPEN_BRANCHES_TO_QUOTE = 2;

/** Una variable de BuilderBot que no se reemplazó llega literal: "{body}", "{from}", "{name}", "{latitude}". */
const PLACEHOLDER = /^\{\s*[\w.\-]+\s*\}$/;

/** Texto limpio de un campo del body: "" si viene vacío o es una variable sin reemplazar. */
function clean(value: unknown) {
  if (value == null || typeof value === "object") return "";
  const text = String(value).trim();
  return PLACEHOLDER.test(text) ? "" : text;
}

/**
 * Teléfono en E.164 ("+593991234567"). WhatsApp puede mandar el JID completo: "593991234567:12@s.whatsapp.net"
 * (el ":12" es el dispositivo).
 *
 * "…@lid" NO es un teléfono: es el id de privacidad de WhatsApp (el cliente oculta su número). Se guarda como
 * "lid:<dígitos>" para que su sesión sea siempre la misma, pero no se usa como teléfono del cliente
 * (customerPhone de la orden queda vacío y no se buscan pedidos anteriores por ese id). Ver ROUTER.md.
 */
export function toE164(value: unknown) {
  const text = clean(value);
  if (/^lid:\d+$/.test(text)) return text;
  if (/@lid\b/i.test(text)) {
    const lid = text.replace(/[:@].*$/, "").replace(/\D/g, "");
    if (!lid) return "";
    console.warn(`[whatsapp-bot] llegó un JID @lid (${lid}) en vez de un teléfono: se usa lid:${lid} como sesión, sin teléfono del cliente`);
    return `lid:${lid}`;
  }
  const raw = text.replace(/[:@].*$/, "");
  return normalizePhone(raw)?.e164 || raw.replace(/[^0-9+]/g, "");
}

/** El id "lid:…" no es un teléfono: no va como customerPhone ni sirve para buscar pedidos. */
const isLid = (phone: string) => phone.startsWith("lid:");

/**
 * Fuera de producción, BOT_TEST_PHONE reemplaza el teléfono de TODOS los mensajes. Sirve para probar por
 * Telegram, donde `{from}` es el id del chat y no un teléfono. Quitarla al conectar WhatsApp.
 */
function testPhone() {
  return env.APP_ENV !== "production" ? toE164(process.env.BOT_TEST_PHONE) : "";
}

/** Teléfono del cliente: BuilderBot lo puede mandar como `phone` o `from`, en el body o en la URL. */
function readPhone(body: any) {
  return testPhone() || toE164(clean(body?.phone) || clean(body?.from) || clean(body?.telefono));
}

/** "reiniciatodo" (con o sin espacio, tildes o mayúsculas) borra la conversación para probar desde cero. */
function isResetKeyword(message: string) {
  return message.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "") === "reiniciatodo";
}

const RESET_REPLY = "Listo, reinicié todo 🔄 Empezamos de cero, dime qué se te antoja";

/** Las órdenes viejas guardaron el teléfono en formatos distintos: se buscan todos. */
function phoneVariants(value: unknown) {
  const phone = normalizePhone(value);
  if (!phone) return [String(value || "")];
  return [phone.e164, `${phone.code}${phone.number}`, `0${phone.number}`, phone.number, `+${phone.code} ${phone.number}`, `+${phone.code} 0${phone.number}`];
}

/** Fuera de producción, BOT_FORCE_OPEN=1 simula el local abierto para probar el flujo completo de noche. */
function forceOpen() {
  return process.env.BOT_FORCE_OPEN === "1" && env.APP_ENV !== "production";
}

function isOpen(branch: any) {
  return forceOpen() || isBranchOpenAt(branch);
}

function appendHistory(session: any, role: "user" | "assistant", content: string) {
  if (!content.trim()) return;
  session.history = [...(session.history || []), { role, content: content.trim().slice(0, 2000), createdAt: new Date() }].slice(-30);
}

/**
 * Mensaje del cliente. BuilderBot manda los eventos sin texto como "_event_location__<uuid>",
 * "_event_media__…", "_event_voice_note__…": no son texto del cliente (antes "_event_location__…" quedaba
 * guardado como dirección de entrega).
 */
function readMessage(body: any) {
  const text = rawText(body);
  return /^_event_\w*__/i.test(text) ? "" : text.slice(0, 1500);
}

/** Texto crudo del mensaje: el campo del body o, si BuilderBot solo manda `{history}`, lo último que dijo el cliente. */
function rawText(body: any) {
  return [body?.rawMessage, body?.rawMess, body?.body, body?.message, body?.mensaje].map(clean).find(Boolean) || latestUserMessage(body?.history);
}

const ASSISTANT_ROLES = /^(assistant|model|bot|system|asistente|ia|ai)$/i;
const ROLE_LINE = /^\s*(user|usuario|cliente|human|humano|customer|assistant|asistente|model|bot|system|ia|ai)\s*:\s*(.*)$/i;

function historyContent(value: any): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(historyContent).filter(Boolean).join("\n").trim();
  for (const key of ["text", "content", "message", "body", "value"]) {
    if (typeof value?.[key] === "string") return value[key].trim();
  }
  return "";
}

function historyArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  for (const key of ["messages", "history", "conversation", "data"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

/**
 * Último mensaje del CLIENTE dentro de `{history}` (flow tipo Sorbito: el nodo HTTP manda solo history + from).
 * Acepta un arreglo de mensajes ({ role, content }), ese arreglo como JSON en texto, o texto con líneas
 * "user: …" / "assistant: …". Texto sin roles: se toma la última línea.
 */
export function latestUserMessage(history: unknown): string {
  if (history == null) return "";
  let value: any = history;
  if (typeof value === "string") {
    const text = clean(value);
    if (!text) return "";
    try {
      value = JSON.parse(text);
    } catch {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.some((line) => ROLE_LINE.test(line))) {
        let last = "";
        let current: { assistant: boolean; parts: string[] } | null = null;
        for (const line of lines) {
          const match = line.match(ROLE_LINE);
          if (match) {
            if (current && !current.assistant) last = current.parts.join("\n");
            current = { assistant: ASSISTANT_ROLES.test(match[1]), parts: [match[2]] };
          } else if (current) current.parts.push(line);
        }
        if (current && !current.assistant) last = current.parts.join("\n");
        return last.trim();
      }
      // Varias líneas sin decir quién habló: no se puede saber cuál es del cliente y cuál del bot (la
      // última línea llegó a ser "human", de un nodo Texto de BuilderBot, y derivaba a soporte).
      // Mejor no adivinar: el flow debe mandar también rawMessage = {body}.
      if (lines.length > 1) {
        console.warn(`[whatsapp-bot] {history} llegó sin roles y con ${lines.length} líneas: agrega rawMessage={body} al nodo HTTP. Muestra: ${text.slice(-200)}`);
        return "";
      }
      return lines[0] || "";
    }
  }
  const items = historyArray(value);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const role = String(item?.role ?? item?.sender ?? item?.type ?? "user");
    if (ASSISTANT_ROLES.test(role)) continue;
    const content = historyContent(item?.content ?? item?.parts ?? item?.text ?? item?.body ?? item);
    if (content) return content;
  }
  return "";
}

function readEvent(body: any): "location" | "media" | null {
  const text = rawText(body);
  const match = text.match(/^_event_(\w*?)__/i);
  if (!match) return null;
  return /location|ubicacion/i.test(match[1]) ? "location" : "media";
}

function toCoordinate(value: unknown) {
  if (typeof value === "number") return value;
  const text = clean(value).replace(/\s+/g, "");
  if (!text) return NaN;
  // "-2,1577677": coma decimal.
  return Number(/^-?\d+,\d+$/.test(text) ? text.replace(",", ".") : text);
}

function validCoords(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
}

/** "-2.1577677,-79.8947611" suelto, o un link de Waze (…?ll=-2.15,-79.89). */
function coordsFromText(value: unknown): { lat: number; lng: number } | null {
  const text = clean(value);
  if (!text) return null;
  const match =
    text.match(/[?&]ll=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i) ||
    text.match(/^\(?\s*(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})\s*\)?$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return validCoords(lat, lng) ? { lat, lng } : null;
}

function readLocation(body: any, message = ""): { lat: number; lng: number } | null {
  for (const source of [body?.location, body?.metadata?.location, body]) {
    if (!source) continue;
    if (typeof source === "string") {
      const coords = coordsFromText(source);
      if (coords) return coords;
      continue;
    }
    const lat = toCoordinate(source.latitude ?? source.lat ?? source.latitud);
    const lng = toCoordinate(source.longitude ?? source.longitud ?? source.lng ?? source.long);
    if (validCoords(lat, lng)) return { lat, lng };
  }
  return coordsFromText(body?.mapsUrl) || coordsFromText(message);
}

// ─── Dependencias reales del router ──────────────────────────────────────────

async function findLastOrder(phone: string, options: { includeUnpaid?: boolean } = {}): Promise<LastOrder | null> {
  if (isLid(phone)) return null;
  const session: any = await WhatsAppSession.findOne({ phone }).select("resetAt").lean();
  const order: any = await Order.findOne({
    customerPhone: { $in: phoneVariants(phone) },
    ...(session?.resetAt ? { createdAt: { $gt: session.resetAt } } : {}),
    status: { $ne: "cancelled" },
    // Una tarjeta que nunca se pagó no es "lo de la última vez"… salvo que el cliente pida repetirlo.
    ...(options.includeUnpaid ? {} : { $nor: [{ status: "pending", paymentMethod: "card" }] }),
    "items.0": { $exists: true },
  })
    .sort({ createdAt: -1 })
    .populate("branch", "name")
    .lean();
  if (!order) return null;
  return {
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    items: order.items.map((item: any) => ({ productId: String(item.product), name: item.name, quantity: item.quantity })),
    customerName: order.customerName || undefined,
    customerEmail: order.customerEmail || undefined,
    deliveryType: order.deliveryType,
    deliveryAddress: order.deliveryAddress || undefined,
    deliveryCoordinates: order.deliveryCoordinates || null,
    deliveryGoogleMapsUrl: order.deliveryGoogleMapsUrl || undefined,
    branchId: order.branch?._id ? String(order.branch._id) : undefined,
    branchName: order.branch?.name,
  };
}

function activeBranchesQuery() {
  return Branch.find({ isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter() });
}

/**
 * Sucursal que atiende una ubicación. Gana la MÁS CERCANA que cubra la dirección, esté ABIERTA O CERRADA
 * (pedido del dueño: "debería atenderme el Boloncity del Centro"). El estado abierto/cerrado NO decide quién
 * gana; se devuelve para que el bot ofrezca programar el pedido o cambiar a una sucursal abierta.
 *
 * Se cotizan las 3 más cercanas (gana una de ellas) más hasta 2 ABIERTAS más cercanas, para poder ofrecer la
 * alternativa "que me lo mande la otra". `preferBranchId` fuerza a esa sucursal si cubre: es la que el cliente
 * eligió a mano, y así una recotización (por cambio de pago) no lo devuelve a la cerrada.
 */
async function quoteBotLocation(coords: { lat: number; lng: number }, paymentMethod?: "card" | "cash", preferBranchId?: string): Promise<LocationQuote> {
  const branches = await activeBranchesQuery().select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  const ranked = branches
    .filter((branch) => branch.coordinates?.lat != null && branch.coordinates?.lng != null)
    .map((branch) => ({ branch, distance: distanceKm(coords, { lat: branch.coordinates!.lat, lng: branch.coordinates!.lng }), open: isOpen(branch) }))
    .sort((a, b) => a.distance - b.distance);

  const candidates = ranked.slice(0, MAX_BRANCHES_TO_QUOTE);
  // Además, las abiertas más cercanas: si la que gana está cerrada hay que poder ofrecer una que atienda ya.
  for (const item of ranked) {
    if (candidates.length >= MAX_BRANCHES_TO_QUOTE + MAX_OPEN_BRANCHES_TO_QUOTE) break;
    if (item.open && !candidates.includes(item)) candidates.push(item);
  }
  const preferred = preferBranchId ? ranked.find((item) => String(item.branch._id) === preferBranchId) : undefined;
  if (preferred && !candidates.includes(preferred)) candidates.push(preferred);

  const settings = await getOrCreateSettings();
  let lastReason = "Uy, hasta esa dirección todavía no llegamos con delivery 😔";
  // Se cotizan en paralelo (cada una puede tardar hasta 8 s en Picker).
  const quotes = await Promise.all(
    candidates.map(({ branch }) =>
      quoteDelivery({ branch, lat: coords.lat, lng: coords.lng, paymentMethod: paymentMethod === "cash" ? "CASH" : "CARD" }).catch((error) => ({
        covered: false as const,
        reason: error instanceof Error ? error.message : "",
        deliveryFee: 0,
        distance: 0,
      }))
    )
  );
  const covered = candidates
    .map((candidate, index) => ({ ...candidate, quote: quotes[index] as any }))
    .filter((item) => {
      if (item.quote.covered) return true;
      lastReason = item.quote.reason || lastReason;
      return false;
    });
  // Un delivery jamás sale gratis (misma regla que createOrder).
  const feeOf = (quote: any) => (quote.deliveryFee > 0 ? quote.deliveryFee : (settings.deliveryPricePerKm || 150) / 100);

  // `covered` ya viene ordenado por distancia: la primera es la más cercana que cubre.
  const winner = (preferBranchId && covered.find((item) => String(item.branch._id) === preferBranchId)) || covered[0];
  if (!winner) return { covered: false as const, reason: lastReason };

  const alternative = covered.find((item) => item.open && String(item.branch._id) !== String(winner.branch._id));
  const availability = getBranchAvailability(winner.branch);
  return {
    covered: true as const,
    branchId: String(winner.branch._id),
    branchName: winner.branch.name,
    deliveryFee: feeOf(winner.quote),
    distance: Math.round(winner.quote.distance * 10) / 10,
    open: winner.open,
    nextOpening: toOpeningWindow(availability.nextOpening, winner.branch.timezone),
    openAlternative: alternative
      ? {
          branchId: String(alternative.branch._id),
          branchName: alternative.branch.name,
          deliveryFee: feeOf(alternative.quote),
          distance: Math.round(alternative.quote.distance * 10) / 10,
        }
      : null,
  };
}

/** Próxima apertura en el formato que usa el router (con la etiqueta en palabras ya resuelta). */
function toOpeningWindow(nextOpening: { date: string; opensAt: string; closesAt: string; at: string } | null, timezone?: string): OpeningWindow | null {
  if (!nextOpening) return null;
  return { at: nextOpening.at, opensAt: nextOpening.opensAt, closesAt: nextOpening.closesAt, label: describeOpeningDay(nextOpening.at, timezone) };
}

async function branchStatus(branchId: string) {
  const branch = await Branch.findById(branchId);
  if (!branch || !branch.isActive) return { open: false, message: "Uy, ese local no está disponible ahorita 😔 Escribe *otro local* para elegir otro, o *delivery* y te lo llevamos" };
  if (isOpen(branch)) return { open: true, branchName: branch.name };
  const availability = getBranchAvailability(branch);
  const nextOpening = toOpeningWindow(availability.nextOpening, branch.timezone);
  return {
    open: false,
    branchName: branch.name,
    nextOpening,
    // El router arma la oferta completa (programar / otra sucursal abierta); este mensaje es el respaldo.
    message: nextOpening
      ? `${branch.name} está cerrada ahorita 😴 Atiende de ${nextOpening.opensAt} a ${nextOpening.closesAt}, y vuelve a abrir ${nextOpening.label} a las ${nextOpening.opensAt}`
      : `${branch.name} no tiene horario de atención por ahora 😔 Prueba con otro local o escríbenos en un rato`,
  };
}

/** "hoy", "mañana lunes 14" o "el miércoles 16", en la hora del local. */
function describeOpeningDay(at: string, timezone = "America/Guayaquil") {
  const dayKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
  const opening = new Date(at);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const label = new Intl.DateTimeFormat("es-EC", { timeZone: timezone, weekday: "long", day: "numeric" }).format(opening);
  if (dayKey(opening) === dayKey(today)) return "hoy";
  if (dayKey(opening) === dayKey(tomorrow)) return `mañana ${label}`;
  return `el ${label}`;
}

async function quoteState(state: BotState) {
  if (!state.cart.length) return null;
  const products = new Map((await loadCatalog(state.branchId)).map((product) => [product.productId, product]));
  const lines = state.cart
    .filter((item) => products.has(item.productId))
    .map((item) => ({ name: products.get(item.productId)!.name, quantity: item.quantity, unitPrice: products.get(item.productId)!.price }));
  if (!lines.length) return null;
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const promo = getActivePromo(await getOrCreateSettings());
  const promoAmount = promoDiscountCents(Math.round(subtotal * 100), promo.percent) / 100;
  const deliveryFee = state.deliveryType === "delivery" ? Number(state.deliveryFee) || 0 : 0;
  return { lines, subtotal, promoLabel: promo.label, promoAmount, deliveryFee, total: Math.max(0, subtotal + deliveryFee - promoAmount) };
}

/**
 * Crea la orden con las mismas reglas que POST /api/orders (createOrder): precio de la
 * sucursal, disponibilidad, cobertura, horario, promo, IVA, puntos, Picker CASH,
 * RunFood, Meta y correo. Si algo no cuadra, lanza con un mensaje para el cliente.
 */
async function createBotOrder(state: BotState) {
  const branch = state.branchId
    ? await Branch.findOne({ _id: state.branchId, isActive: true, isArchived: { $ne: true } }).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey")
    : null;
  if (!branch) throw new Error("No pude asignarle un local a tu pedido 🙏 Dime de nuevo si lo quieres por delivery o para retirar");

  // PEDIDO PROGRAMADO: mismas reglas que POST /api/orders (createOrder) — fecha válida, estrictamente futura
  // y dentro del horario de ESA sucursal en su timezone. Con un pedido programado el local puede estar cerrado:
  // justamente por eso se programó.
  const scheduledFor = state.scheduledFor ? new Date(state.scheduledFor) : null;
  if (scheduledFor) {
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
      throw new Error("Esa hora ya pasó 🙈 Dime de nuevo para cuándo lo quieres y lo programamos");
    }
    const scheduledValidation = validateScheduledTime(branch, scheduledFor);
    if (!scheduledValidation.valid) throw new Error(scheduledValidation.message || `${branch.name} no atiende a esa hora 🙏`);
  } else if (!isOpen(branch)) {
    throw new Error(`Uy, ${branch.name} acaba de cerrar 😴 Te esperamos apenas abramos`);
  }

  const isDelivery = state.deliveryType === "delivery";
  let deliveryCostCents = 0;
  let deliveryDistance = 0;
  if (isDelivery) {
    if (!state.deliveryCoordinates) throw new Error("Me falta tu ubicación para el delivery 📍 Mándamela desde el clip 📎 de WhatsApp");
    const quote = await quoteDelivery({ branch, lat: state.deliveryCoordinates.lat, lng: state.deliveryCoordinates.lng, paymentMethod: state.paymentMethod === "cash" ? "CASH" : "CARD" });
    if (!quote.covered) throw new Error(quote.reason || "Uy, hasta esa dirección todavía no llegamos con delivery 😔");
    deliveryDistance = quote.distance;
    deliveryCostCents = Math.round(quote.deliveryFee * 100);
    if (deliveryCostCents <= 0) deliveryCostCents = (await getOrCreateSettings()).deliveryPricePerKm || 150;
  }

  const branchId = String(branch._id);
  const products = await Product.find({ _id: { $in: state.cart.map((item) => item.productId) } });
  const unavailable: string[] = [];
  const orderItems = state.cart
    .map((item) => {
      const product = products.find((current) => String(current._id) === item.productId);
      if (!product || !isAvailableAt(product, branchId)) {
        unavailable.push(item.name);
        return null;
      }
      const branchPrice = product.branchPrices?.find((price: any) => String(price.branch) === branchId);
      return {
        product: product._id,
        name: product.name,
        price: branchPrice?.price ?? product.price,
        quantity: item.quantity,
        image: product.images[0]?.url || "",
        pointsValue: product.pointsValue || 0,
      };
    })
    .filter(Boolean) as Array<{ product: any; name: string; price: number; quantity: number; image: string; pointsValue: number }>;
  if (unavailable.length) throw new Error(`Se nos acabó: ${unavailable.join(", ")} 😕 Dime si lo cambio por otra cosa`);
  if (!orderItems.length) throw new Error("Tu pedido está vacío 🙂 Dime qué se te antoja y lo armamos");

  const settings = await getOrCreateSettings();
  const subtotalCents = Math.round(orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100);
  const promo = getActivePromo(settings);
  const promoCents = promoDiscountCents(subtotalCents, promo.percent);
  const taxCents = settings.pricesIncludeIva
    ? orderItems.reduce((sum, item) => {
        const product = products.find((current) => String(current._id) === String(item.product));
        if (!product?.hasIva) return sum;
        return sum + extractIva(Math.round(item.price * item.quantity * 100), product.ivaRate || settings.ivaRate).tax;
      }, 0)
    : 0;
  const pointsEarned = calculateEarnedPoints(Math.max(0, subtotalCents - promoCents), orderItems, settings);
  const counter = await Counter.findByIdAndUpdate({ _id: "orderNumber" }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const docNumber = String(state.billingDocNumber || "").replace(/\D+/g, "");

  const order = await Order.create({
    orderNumber: `ORD-${String(counter.seq).padStart(5, "0")}`,
    items: orderItems,
    subtotal: subtotalCents,
    tax: taxCents,
    total: Math.max(0, subtotalCents + deliveryCostCents - promoCents),
    pointsEarned,
    promo: promoCents > 0 ? { percent: promo.percent, label: promo.label, amount: promoCents } : null,
    paymentMethod: state.paymentMethod,
    deliveryType: isDelivery ? "delivery" : "pickup",
    deliveryCost: deliveryCostCents,
    deliveryDistance,
    deliveryAddress: isDelivery ? state.deliveryAddress || "" : "",
    deliveryGoogleMapsUrl: isDelivery ? state.deliveryGoogleMapsUrl || "" : "",
    deliveryCoordinates: isDelivery ? state.deliveryCoordinates : null,
    status: "pending",
    customerEmail: String(state.customerEmail || "").toLowerCase(),
    customerName: state.customerName || "",
    customerPhone: isLid(state.phone) ? "" : toE164(state.phone),
    notes: state.notes || "",
    branch: branch._id,
    ...(scheduledFor ? { scheduledFor } : {}),
    ...(state.billingPreference === "invoice" && docNumber
      ? { billing: { docType: docNumber.length === 13 ? "ruc" : "cedula", name: state.billingName || state.customerName, docNumber, email: state.customerEmail || "", address: state.deliveryAddress || "" } }
      : {}),
    source: "whatsapp",
    audit: [{ action: "created", details: `Pedido creado desde WhatsApp · Sucursal: ${branch.name}`, toValue: "pending", timestamp: new Date() }],
    payphone: { clientTransactionId: `BOL-${Date.now()}`, storeId: getBranchPayphoneStoreId(branch.payphone) },
  });

  // Efectivo: exactamente lo que hace createOrder. Tarjeta: todo esto ocurre en confirmOrder al pagar;
  // aquí solo se manda el correo con el link de pago (por si pierde el mensaje de WhatsApp).
  if (order.paymentMethod === "card") {
    const html = getOrderStatusEmailHtml({
      orderNumber: order.orderNumber,
      customerName: order.customerName || "Cliente",
      status: order.status,
      statusText: scheduledFor ? `Pedido programado para ${longScheduledLabel(scheduledFor)} — falta el pago` : "Recibimos tu pedido — falta el pago",
      description: scheduledFor
        ? "Tu pedido quedó programado. La cocina lo prepara a esa hora, apenas se confirme el pago con tarjeta."
        : "Tu pedido quedó registrado. La cocina lo empieza apenas se confirme el pago con tarjeta.",
      detailUrl: botPaymentLink(order),
      ctaLabel: "Pagar mi pedido",
      items: order.items || [],
      total: order.total,
    });
    await sendEmail(order.customerEmail, `Boloncity: completa el pago de tu pedido ${order.orderNumber}`, html).catch(() => {});
  }
  if (order.paymentMethod === "cash") {
    // Igual que la web (order.controller.ts): un pedido PROGRAMADO no se despacha ahora. La reserva de Picker
    // entra cuando el cajero lo pasa a "Listas para recolección" y la comanda RunFood cuando lo pasa a
    // "En preparación". Meta sí se reporta: en efectivo la venta ya está hecha. Ver docs/whatsapp-bot/ROUTER.md.
    if (!scheduledFor) {
      if (isDelivery) await bookPickerForOrder(order, "CASH");
      await sendOrderToRunfood(order);
    }
    await reportPurchaseToMeta(order);
    const html = getOrderStatusEmailHtml({
      orderNumber: order.orderNumber,
      customerName: order.customerName || "Cliente",
      status: order.status,
      statusText: scheduledFor
        ? `Pedido programado para ${longScheduledLabel(scheduledFor)}`
        : `Recibimos tu pedido — pagas en efectivo al ${isDelivery ? "recibirlo" : "retirarlo en el local"}`,
      detailUrl: getOrderDetailUrl(order),
      items: order.items || [],
      total: order.total,
    });
    await sendEmail(order.customerEmail, `Boloncity: recibimos tu pedido ${order.orderNumber}`, html).catch(() => {});
  }
  return order;
}

/** Fecha larga en es-EC para el correo, EXACTAMENTE como la arma el checkout web (order.controller.ts). */
function longScheduledLabel(date: Date) {
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function botPaymentLink(order: { orderNumber: string; customerEmail?: string }) {
  return `${getFrontendUrl()}/pago/${order.orderNumber}?email=${encodeURIComponent(order.customerEmail || "")}`;
}

async function createOrderWithLock(state: BotState) {
  const phone = toE164(state.phone);
  const now = new Date();
  // Candado atómico de 45 s: si BuilderBot reintenta el "confirmo" mientras se crea la orden, el segundo no crea otra.
  const locked: any = await WhatsAppSession.findOneAndUpdate(
    { phone, $or: [{ checkoutLockUntil: null }, { checkoutLockUntil: { $lt: now } }] },
    { $set: { checkoutLockUntil: new Date(now.getTime() + 45_000) } },
    { new: true }
  ).lean();
  if (!locked) return { ok: false as const, message: "Ya estoy creando tu pedido, dame unos segunditos 🙏" };
  // Otra request ya creó la orden de este resumen: se devuelve la misma, nunca una segunda.
  const saved: any = locked.state;
  if (saved?.stage === "ordered" && saved.lastOrderNumber) {
    await WhatsAppSession.updateOne({ phone }, { $set: { checkoutLockUntil: null } });
    const existing: any = await Order.findOne({ orderNumber: saved.lastOrderNumber }).select("total").lean();
    return { ok: true as const, orderNumber: saved.lastOrderNumber as string, total: (existing?.total || 0) / 100, paymentLink: saved.lastPaymentLink || undefined };
  }
  let created: { orderNumber: string; paymentLink?: string } | null = null;
  try {
    const order = await createBotOrder(state);
    const paymentLink = order.paymentMethod === "card" ? botPaymentLink(order) : undefined;
    created = { orderNumber: order.orderNumber, paymentLink };
    return { ok: true as const, orderNumber: order.orderNumber, total: order.total / 100, paymentLink };
  } catch (error) {
    console.error("[whatsapp-bot] no se pudo crear la orden", error instanceof Error ? error.message : error);
    return { ok: false as const, message: error instanceof Error && error.message ? error.message : "No pude crear tu pedido 🙏 ¿Lo intentamos de nuevo?" };
  } finally {
    // La orden creada se anota en la sesión en el MISMO update que suelta el candado: aunque el guardado del
    // turno fallara después, ningún "confirmo" posterior crea otra orden para este resumen.
    await WhatsAppSession.updateOne(
      { phone },
      {
        $set: {
          checkoutLockUntil: null,
          ...(created
            ? { "state.stage": "ordered", "state.lastOrderNumber": created.orderNumber, "state.lastPaymentLink": created.paymentLink || null }
            : {}),
        },
      }
    );
  }
}

/**
 * "PAGADO" DEL CLIENTE → estado real del pago.
 *
 * Llama al caso de uso compartido (cardPaymentSettlement.service.ts), que consulta PayPhone por el
 * clientTransactionId, ejecuta la fase de confirmación obligatoria y, si está cobrado, cierra el
 * pedido por el MISMO camino que el regreso del navegador (settleApprovedCardOrder): pagada, cocina
 * (RunFood), Picker con CARD, Meta, puntos y correo. Idempotente.
 */
async function settleBotPayment(orderNumber: string): Promise<PaymentSettlement> {
  const result = await settleCardPaymentByOrderNumber(orderNumber);
  const order: any = result.order;
  console.log(`[whatsapp-bot] pagado ${orderNumber} → ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`);
  return {
    outcome: result.outcome,
    total: order ? order.total / 100 : undefined,
    // El seguimiento en vivo existe recién cuando Picker acepta la reserva (delivery inmediato).
    trackingUrl: order?.picker?.smrURL || undefined,
    paymentLink: order && order.paymentMethod === "card" ? botPaymentLink(order) : undefined,
    deliveryType: order?.deliveryType,
    branchName: order?.branch?.name || undefined,
  };
}

/** Dependencias reales. `overrides` permite probar en vivo sin crear órdenes (src/scripts/liveWhatsappBot.ts). */
export function buildDeps(overrides: Partial<BotDeps> = {}): BotDeps {
  return {
    ...defaultDeps(),
    ...overrides,
  };
}

function defaultDeps(): BotDeps {
  return {
    search: searchCatalog,
    catalog: loadCatalog,
    lastOrder: findLastOrder,
    resolveMapsUrl: async (url) => parseMapsUrl(url) || (await resolveMapsCoordinates(url, undefined, env.GOOGLE_MAPS_API_KEY)),
    quoteLocation: quoteBotLocation,
    pickupBranches: async (near?: { lat: number; lng: number }) => {
      const list = (await activeBranchesQuery().sort({ name: 1 })).map((branch) => ({
        branchId: String(branch._id),
        name: branch.name,
        address: branch.address || undefined,
        // El bot marca cuáles están abiertos y ofrece programar en los cerrados.
        open: isOpen(branch),
        nextOpening: toOpeningWindow(getBranchAvailability(branch).nextOpening, branch.timezone),
        distanceKm:
          near && branch.coordinates?.lat != null && branch.coordinates?.lng != null
            ? distanceKm(near, { lat: branch.coordinates.lat, lng: branch.coordinates.lng })
            : undefined,
      }));
      // Con una ubicación, primero las más cercanas: así el bot puede decir cuál local le queda mejor.
      return near ? [...list].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)) : list;
    },
    branchStatus,
    quote: quoteState,
    createOrder: createOrderWithLock,
    settlePayment: settleBotPayment,
    trackOrder: async (phone, message) => (await trackOrderForPhone(phone, message)).message,
    activePromo: async () => {
      // La promo sale de la configuración del negocio, nunca de la IA.
      const settings = await getOrCreateSettings();
      const promo = getActivePromo(settings);
      return promo.active ? promo.label : "";
    },
    extract: aiExtract,
    chooseOption: aiChooseOption,
    menuUrl: `${getFrontendUrl()}/catalogo`,
    supportPhone: SUPPORT_PHONE,
  };
}

// ─── Turno de conversación ───────────────────────────────────────────────────

const TURN_LOCK_MS = 30_000;
const TURN_WAIT_MS = 25_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Toma el candado del teléfono (y crea la sesión si no existe) de forma atómica. Si otro mensaje del mismo
 * cliente se está procesando, espera a que termine: así dos burbujas seguidas se procesan en orden y ninguna
 * se pierde (antes una fallaba con E11000 o VersionError y el cliente veía "Tuve un problema").
 */
async function acquireTurnLock(phone: string): Promise<any | null> {
  const deadline = Date.now() + TURN_WAIT_MS;
  for (;;) {
    const now = new Date();
    try {
      const session = await WhatsAppSession.findOneAndUpdate(
        { phone, $or: [{ turnLockUntil: null }, { turnLockUntil: { $lt: now } }] },
        { $set: { turnLockUntil: new Date(now.getTime() + TURN_LOCK_MS) } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      if (session) return session;
    } catch (error: any) {
      // E11000: la sesión existe y tiene el candado tomado (el upsert intentó crear otra). Se espera.
      if (error?.code !== 11000) throw error;
    }
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

type TurnOutcome = TurnResult & { duplicated?: boolean };

/**
 * Identidad de la pregunta que el bot tiene abierta: paso + elección pendiente + cola de productos.
 * Dos mensajes iguales seguidos solo son un reintento si responden a la MISMA pregunta.
 */
export function pendingKey(state: any) {
  const identity = JSON.stringify([state?.pendingChoice || null, state?.choiceQueue || []]);
  return `${state?.stage || "idle"}|${crypto.createHash("sha1").update(identity).digest("hex").slice(0, 12)}`;
}

/**
 * ¿El mismo mensaje es un reintento del turno anterior? Sí si llegó mientras se procesaba, o en menos de 5 s sin
 * que cambie la pregunta pendiente. Excepción: si ese turno CREÓ la orden, la clave cambia (confirm → ordered) pero
 * repetir el "sí" en 5 s sigue siendo el mismo envío (doble toque o reintento de BuilderBot).
 */
export function isRetry(input: { arrivedAt: number; lastAt: number; now: number; currentKey: string; keyBefore?: string | null; createdOrder: boolean; endpoint?: string; endpointBefore?: string }) {
  if (input.arrivedAt <= input.lastAt) return true;
  const elapsed = input.now - input.lastAt;
  // Un flow de BuilderBot con DOS nodos HTTP manda el MISMO mensaje a DOS endpoints distintos con segundos de
  // diferencia (visto en producción: /assistant y /brain). Es una sola burbuja del cliente: misma respuesta, y no
  // se avanza dos veces el pedido. Un mensaje repetido por el MISMO endpoint sí puede ser una burbuja nueva.
  if (isOtherHttpNode({ endpoint: input.endpoint, endpointBefore: input.endpointBefore, lastAt: input.lastAt, now: input.now })) return true;
  if (elapsed >= 5000) return false;
  return input.currentKey === input.keyBefore || input.createdOrder;
}

/** Ventana en la que el mismo texto por OTRO endpoint es el mismo mensaje (dos nodos HTTP, no dos burbujas). */
const OTHER_NODE_MS = 20000;

/**
 * Los DOS nodos HTTP que el flow dispara con la MISMA burbuja de texto. Solo entre ellos puede haber un turno
 * duplicado por "otro nodo". /location (el pin) y /catalog (el menú) son pasos legítimos del mismo flow: traen
 * contenido propio que NADIE más va a mandar, y descartarlos dejaba al cliente atascado pidiéndole el pin una y
 * otra vez (el pin llega en segundos, siempre dentro de la ventana).
 */
const TEXT_TWIN_ENDPOINTS = new Set(["brain", "assistant"]);

/** Huella de un mensaje sin texto: el nodo que solo manda `{history}` a veces no trae nada legible. */
const EMPTY_TURN_HASH = crypto.createHash("sha1").update("|||").digest("hex");

/**
 * ¿Este turno llegó por OTRO nodo HTTP del flow, a segundos del turno anterior del MISMO teléfono, con el MISMO
 * mensaje?
 *
 * El flow del dueño tiene dos nodos HTTP (/assistant y /brain) y cada burbuja del cliente dispara los dos: uno
 * manda `rawMessage={body}` y el otro solo `history={history}`. Es la misma burbuja cuando el texto derivado
 * coincide, o cuando el nodo de `{history}` no trajo texto legible (hash vacío): ahí no hay nada nuevo que
 * procesar. Si el texto es OTRO, es la burbuja SIGUIENTE (el orden entre los dos nodos varía) y hay que
 * procesarla: devolverle la respuesta del turno anterior hacía que el cliente viera repetida la pregunta vieja.
 */
export function isOtherHttpNode(input: { endpoint?: string; endpointBefore?: string | null; lastAt: number; now: number; hash?: string; hashBefore?: string | null }) {
  if (!input.endpoint || !input.endpointBefore || input.endpoint === input.endpointBefore) return false;
  if (!TEXT_TWIN_ENDPOINTS.has(input.endpoint) || !TEXT_TWIN_ENDPOINTS.has(input.endpointBefore)) return false;
  if (input.now - input.lastAt >= OTHER_NODE_MS) return false;
  if (!input.hash || !input.hashBefore) return true;
  return input.hash === input.hashBefore || input.hash === EMPTY_TURN_HASH;
}

/** Huella del mensaje (texto + ubicación + evento) para reconocer un reintento de BuilderBot. */
export function turnHash(message: string, location: { lat: number; lng: number } | null, event: string | null) {
  return crypto.createHash("sha1").update(`${message}|${location?.lat ?? ""}|${location?.lng ?? ""}|${event || ""}`).digest("hex");
}

/**
 * Decisión de duplicado de runTurn, sin Mongo: recibe la sesión tal como está guardada y dice si el mensaje es un
 * reintento del turno anterior (misma respuesta completa, R0:duplicado). La usan runTurn y las pruebas.
 */
export function isDuplicateTurn(session: any, hash: string, arrivedAt: number, now: number, endpoint?: string) {
  if (!session || !session.lastReply) return false;
  const lastAt = session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0;
  // El otro nodo HTTP del flow: misma burbuja aunque el texto derivado no coincida (ver isOtherHttpNode).
  if (isOtherHttpNode({ endpoint, endpointBefore: session.lastEndpoint, lastAt, now, hash, hashBefore: session.lastMessageHash })) return true;
  if (session.lastMessageHash !== hash) return false;
  const createdOrder = session.state?.stage === "ordered" && Boolean(session.lastResponse?.orderNumber);
  return isRetry({
    arrivedAt, lastAt, now, currentKey: pendingKey(session.state), keyBefore: session.lastStageBefore, createdOrder,
    endpoint, endpointBefore: session.lastEndpoint,
  });
}

/** Lo que runTurn guarda de un turno para poder reconocer su reintento (ver isDuplicateTurn). */
export function turnRecord(previous: BotState, result: TurnResult, hash: string, now: Date, endpoint?: string) {
  return {
    lastEndpoint: endpoint || "",
    state: JSON.parse(JSON.stringify(result.state)),
    lastMessageHash: hash,
    lastMessageAt: now,
    lastReply: result.reply,
    lastStageBefore: pendingKey(previous),
    lastResponse: { route: result.route, intent: result.intent, orderNumber: result.orderNumber || "", paymentLink: result.paymentLink || "" },
  };
}

interface TurnOptions {
  /** Flow de ubicación: si no llegan coordenadas legibles, se responde "No pude leer tu ubicación". */
  expectLocation?: boolean;
  /** Endpoint que atendió el mensaje: si el mismo texto llega por otro, es un flow con dos nodos HTTP. */
  endpoint?: string;
}

/** Cuánto espera un nodo sin texto a que el otro nodo del flow conteste la misma burbuja. */
const SIBLING_WAIT_MS = 22000;

/**
 * Espera a que el OTRO nodo HTTP del flow termine de atender esta burbuja y devuelve su respuesta tal cual. Así
 * el cliente ve la respuesta de verdad aunque BuilderBot envíe la del nodo que llegó sin texto.
 */
async function waitForSiblingReply(phone: string, arrivedAt: number): Promise<TurnOutcome | null> {
  const deadline = Date.now() + SIBLING_WAIT_MS;
  for (;;) {
    const session: any = await WhatsAppSession.findOne({ phone }).lean();
    const lastAt = session?.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0;
    if (session?.lastReply && lastAt >= arrivedAt) {
      console.warn(`[whatsapp-bot] ⚠️ el flow tiene DOS nodos HTTP: este llegó sin texto para ${phone} y se devuelve la respuesta del otro. DEJA UN SOLO NODO HTTP`);
      const state = { ...createInitialState(phone), ...(session.state || {}) } as BotState;
      const last: any = session.lastResponse || {};
      return {
        state,
        reply: session.lastReply,
        route: last.route || "conversation",
        intent: last.intent || state.lastIntent || "conversar",
        step: state.stage,
        decision: "R0:eco_otro_nodo",
        orderNumber: last.orderNumber || undefined,
        paymentLink: last.paymentLink || undefined,
        duplicated: true,
      };
    }
    if (Date.now() > deadline) return null;
    await sleep(400);
  }
}

async function runTurn(body: any, options: TurnOptions = {}): Promise<TurnOutcome | null> {
  const phone = readPhone(body);
  if (!phone) {
    console.warn("[whatsapp-bot] llegó un mensaje sin teléfono válido. Revisa que el nodo HTTP mande phone = {from}", JSON.stringify(body).slice(0, 300));
    return null;
  }
  const arrivedAt = Date.now();
  const message = readMessage(body);
  const event = readEvent(body);
  const location = readLocation(body, message);
  const locationInvalid = !location && Boolean(options.expectLocation || event === "location") && !extractMapsUrl(message);

  if (isResetKeyword(message)) {
    // Reemplaza la sesión entera (carrito, paso, historial, candados) y marca desde cuándo ignorar pedidos viejos.
    await WhatsAppSession.replaceOne({ phone }, { phone, history: [], state: null, resetAt: new Date() }, { upsert: true });
    console.log(`[whatsapp-bot] ${phone} reiniciatodo → sesión borrada`);
    const state = createInitialState(phone);
    return { state, reply: RESET_REPLY, route: "conversation", intent: "conversar", step: state.stage, decision: "R0:reinicio" };
  }

  // El nodo que solo manda {history} a veces llega SIN texto legible, y a veces llega ANTES que el nodo que sí
  // trae el mensaje. Si contesta él, el cliente ve una respuesta genérica en lugar de la real (pasó en vivo: el
  // pin de ubicación se quedó sin respuesta). En ese caso se espera la respuesta del otro nodo y se devuelve ESA.
  if (!message && !location && !event && options.endpoint && TEXT_TWIN_ENDPOINTS.has(options.endpoint)) {
    const fresh = await waitForSiblingReply(phone, arrivedAt);
    if (fresh) return fresh;
  }

  const session = await acquireTurnLock(phone);
  if (!session) {
    const state = createInitialState(phone);
    return { state, reply: "Estoy terminando de procesar tu mensaje anterior. Dame unos segundos 🙏", route: "conversation", intent: "conversar", step: state.stage, decision: "R0:ocupado" };
  }

  let released = false;
  try {
    // BuilderBot reintenta cuando una respuesta tarda: el mismo mensaje recibe la misma respuesta completa si
    // (a) llegó mientras se procesaba ese mismo mensaje, o (b) llegó en menos de 5 s y el turno anterior no
    // cambió la pregunta pendiente. Un "1" que responde OTRA pregunta es una respuesta nueva: "¿cuál tigrillo?" → "1"
    // y luego "¿cuál cola?" → "1" tienen el mismo paso ("choosing") pero distinta pregunta (ver pendingKey).
    const hash = turnHash(message, location, event);
    if (isDuplicateTurn(session, hash, arrivedAt, Date.now(), options.endpoint)) {
      if (isOtherHttpNode({ endpoint: options.endpoint, endpointBefore: session.lastEndpoint, lastAt: session.lastMessageAt ? new Date(session.lastMessageAt).getTime() : 0, now: Date.now(), hash, hashBefore: session.lastMessageHash })) {
        console.warn(
          `[whatsapp-bot] ⚠️ el flow tiene DOS nodos HTTP: esta misma burbuja de ${phone} ya la atendió /${session.lastEndpoint} y ahora llegó a /${options.endpoint}. ` +
            `Se devuelve la respuesta anterior y NO se vuelve a tocar el pedido. DEJA UN SOLO NODO HTTP en el flow de BuilderBot (recomendado: /api/orders/whatsapp-bot/brain).`
        );
      }
      const state = { ...createInitialState(phone), ...(session.state || {}) } as BotState;
      const last: any = session.lastResponse || {};
      return {
        state,
        reply: session.lastReply,
        route: last.route || "conversation",
        intent: last.intent || state.lastIntent || "conversar",
        step: state.stage,
        decision: "R0:duplicado",
        orderNumber: last.orderNumber || undefined,
        paymentLink: last.paymentLink || undefined,
        duplicated: true,
      };
    }

    const previous = { ...createInitialState(phone), ...(session.state || {}), phone } as BotState;
    const history: Array<{ role: "user" | "assistant"; content: string; createdAt: Date }> = [...(session.history || [])];
    const pushHistory = (role: "user" | "assistant", content: string) => {
      if (content.trim()) history.push({ role, content: content.trim().slice(0, 2000), createdAt: new Date() });
    };
    pushHistory("user", message || (location ? `[ubicación ${location.lat},${location.lng}]` : event ? `[${event}]` : ""));
    const result = await handleTurn(
      previous,
      { message, location, locationInvalid, unsupportedMedia: event === "media", senderName: clean(body?.name) },
      buildDeps()
    );
    result.state.lastIntent = result.intent;
    pushHistory("assistant", result.reply);
    // Guardado con $set (sin versionado): con el candado nadie más escribe esta sesión a la vez.
    await WhatsAppSession.updateOne(
      { phone },
      {
        $set: {
          ...turnRecord(previous, result, hash, new Date(), options.endpoint),
          history: history.slice(-30),
          turnLockUntil: null,
        },
      }
    );
    released = true;
    console.log(`[whatsapp-bot] ${phone} ${result.decision} → paso ${result.step}`);
    return result;
  } finally {
    if (!released) await WhatsAppSession.updateOne({ phone }, { $set: { turnLockUntil: null } }).catch(() => {});
  }
}

/** Nunca se responde en blanco: si un turno no produjo texto, al menos se le pregunta al cliente. */
export const FALLBACK_MESSAGE = "¿Qué te gustaría pedir hoy? 🫓 Escríbeme algo como \"2 bolones mixtos de verde y un café\", o pídeme el *menú* si quieres ver todo";

const NO_PHONE_MESSAGE = `No logré leer tu número de WhatsApp 🙏 Escríbenos al ${SUPPORT_PHONE} y te ayudamos enseguida`;
const ERROR_MESSAGE = "Dame un segundito 🙏 Se me cruzaron los cables con ese mensaje, ¿me lo repites?";

function toBotResponse(result: TurnResult | null) {
  if (!result) {
    // Nunca message vacío: BuilderBot mandaría un mensaje en blanco (o el literal {message}).
    return { success: false, intencion: "conversar", telefonoSoporte: SUPPORT_PHONE, route: "conversation", message: NO_PHONE_MESSAGE, missingData: [], readyToCheckout: false };
  }
  return {
    success: true,
    // Para las Rules de BuilderBot: conversar | menu | dudas | consultar_pedido | orden_creada.
    // "dudas" = el bot no puede resolverlo y hay que derivar al número de soporte.
    intencion: result.intent,
    telefonoSoporte: SUPPORT_PHONE,
    route: publicRoute(result.route),
    // Nunca en blanco: si un turno no produjo texto, igual se le responde algo útil al cliente.
    message: result.reply || FALLBACK_MESSAGE,
    step: result.step,
    decision: result.decision,
    readyToCheckout: result.step === "confirm",
    orderNumber: result.orderNumber || "",
    paymentLink: result.paymentLink || "",
    cart: result.state.cart,
    missingData: [],
    targetEndpoint: "/api/orders/whatsapp-bot/brain",
  };
}

/** Respuesta cuando algo falla: siempre con intención y texto, para que una Rule de BuilderBot la tome. */
function errorResponse(message = ERROR_MESSAGE, extra: Record<string, unknown> = {}) {
  return { success: false, intencion: "conversar", telefonoSoporte: SUPPORT_PHONE, route: "conversation", message, missingData: [], readyToCheckout: false, ...extra };
}

const ROUTE_INTENT: Record<BuilderBotRoute, string> = {
  conversation: "conversar",
  catalog: "menu",
  checkout: "checkout",
  search_order: "consultar_pedido",
  human: "dudas",
};


/**
 * Flow "Bienvenida" de BuilderBot: decide a qué flow va el mensaje (campo `route` para las Rules).
 * Solo lee la sesión: no la modifica, no llama a la IA y no responde texto al cliente.
 */
export async function whatsappBotRouter(req: Request, res: Response) {
  try {
    const body = { ...req.query, ...req.body };
    const phone = readPhone(body);
    const message = readMessage(body);
    const session: any = phone ? await WhatsAppSession.findOne({ phone }).lean() : null;
    const state = session?.state ? ({ ...createInitialState(phone), ...session.state } as BotState) : null;
    // "reiniciatodo" siempre va a la conversación, que es la que borra la sesión.
    const route = isResetKeyword(message) ? "conversation" : classifyRoute(state, message, Boolean(readLocation(body, message)) || readEvent(body) === "location");
    console.log(`[whatsapp-bot] router ${phone} → ${route} (paso ${state?.stage || "nuevo"})`);
    // `message` ya NO va vacío: si el flow lo envía al cliente, este endpoint no debe dejarlo sin respuesta.
    // El flow recomendado (un solo nodo a /brain o /assistant) sigue funcionando igual.
    res.status(200).json({
      success: true,
      route,
      intencion: ROUTE_INTENT[route],
      step: state?.stage || "idle",
      telefonoSoporte: SUPPORT_PHONE,
      message: FALLBACK_MESSAGE,
    });
  } catch (error) {
    console.error("[whatsapp-bot] router falló", error);
    // Ante la duda, a la conversación: ahí el cliente siempre recibe una respuesta.
    res.status(200).json({ success: true, route: "conversation", intencion: "conversar", step: "idle", telefonoSoporte: SUPPORT_PHONE, message: "" });
  }
}

/** Punto de entrada principal: todos los flujos de BuilderBot pueden llamar aquí. */
export async function whatsappBotBrain(req: Request, res: Response) {
  try {
    res.status(200).json(toBotResponse(await runTurn({ ...req.query, ...req.body }, { endpoint: "brain" })));
  } catch (error) {
    console.error("[whatsapp-bot] brain falló", error);
    res.status(200).json(errorResponse());
  }
}

// BuilderBot espera este sobre en el flujo del asistente.
export async function whatsappBotAssistant(req: Request, res: Response) {
  try {
    const result = await runTurn({ ...req.query, ...req.body }, { endpoint: "assistant" });
    res.status(200).json({
      success: Boolean(result),
      // Con teléfono pero sin texto (el nodo de {history} a veces llega vacío) se pregunta, no se dice
      // "no logré leer tu número": ese no era el problema y confundía al cliente.
      message: result ? result.reply || FALLBACK_MESSAGE : NO_PHONE_MESSAGE,
      intencion: result?.intent || "conversar",
      telefonoSoporte: SUPPORT_PHONE,
      _intent: result?.intent || "conversar",
      missingData: [],
    });
  } catch (error) {
    console.error("[whatsapp-bot] assistant falló", error);
    res.status(200).json({ ...errorResponse(), _intent: "conversar" });
  }
}

/** Flujo "Catálogo Productos": sin mensaje se comporta como "menú". */
export async function whatsappBotCatalog(req: Request, res: Response) {
  try {
    const body = { ...req.query, ...req.body };
    if (!readMessage(body)) body.message = "menú";
    const result = await runTurn(body, { endpoint: "catalog" });
    res.status(200).json({ ...toBotResponse(result), _intent: result?.intent || "menu" });
  } catch (error) {
    console.error("[whatsapp-bot] catalog falló", error);
    res.status(200).json({ ...errorResponse(), _intent: "conversar" });
  }
}

/** Flujo "envian ubicacion nativa": lat/lng de WhatsApp, "lat,lng", link de Google Maps o de Waze. */
export async function whatsappBotLocation(req: Request, res: Response) {
  try {
    const body = { ...req.query, ...req.body };
    if (clean(body.mapsUrl) && !readMessage(body)) body.message = String(body.mapsUrl);
    const result = await runTurn(body, { expectLocation: true, endpoint: "location" });
    res.status(200).json({ ...toBotResponse(result), _intent: result?.intent || "conversar" });
  } catch (error) {
    console.error("[whatsapp-bot] location falló", error);
    res.status(200).json(errorResponse("Mmm, no pude leer esa ubicación 🙈 ¿Me la compartes de nuevo desde el clip 📎?"));
  }
}

/**
 * Flujo "checkout link de pago". Idempotente: si la orden ya existe devuelve la misma;
 * si faltan datos responde qué falta; si el resumen ya se mostró, confirma.
 */
export async function whatsappBotCheckout(req: Request, res: Response) {
  try {
    const body = { ...req.query, ...req.body };
    const phone = readPhone(body);
    const base = { intencion: "conversar", telefonoSoporte: SUPPORT_PHONE };
    if (!phone) return res.status(200).json({ ...base, success: false, message: NO_PHONE_MESSAGE });
    const session: any = await WhatsAppSession.findOne({ phone }).lean();
    const state = session?.state as BotState | undefined;
    if (!session || !state) return res.status(200).json({ ...base, success: false, message: "Todavía no tengo tu pedido 🙂 Dime qué se te antoja y lo armamos" });
    const claimedPaid = state.stage === "ordered" && Boolean(state.lastOrderNumber) && claimsPaid(readMessage(body));
    // "pagado" por el flow de checkout de BuilderBot: el corto circuito de abajo respondía "ya está
    // registrado" sin verificar nada. Se deja pasar el turno para que R7:pago_* consulte a PayPhone.
    if (state.stage === "ordered" && state.lastOrderNumber && !claimedPaid) {
      return res.status(200).json({
        ...base,
        intencion: "orden_creada",
        success: true,
        // Con link pendiente se repite la palabra clave: el cliente tiene que saber cómo avisar que pagó.
        message: `Tu pedido ${state.lastOrderNumber} ya está registrado ✅${state.scheduledLabel ? `\n🗓️ Programado para ${state.scheduledLabel}` : ""}${
          state.lastPaymentLink ? `\nPágalo aquí: ${state.lastPaymentLink}\n\nCuando lo hayas pagado, escríbeme *pagado* y verifico el pago ✅` : ""
        }`,
        orderNumber: state.lastOrderNumber,
        paymentLink: state.lastPaymentLink || "",
      });
    }
    if (claimedPaid) {
      const paidTurn = await runTurn({ ...body, phone }, { endpoint: "checkout" });
      return res.status(200).json({ ...toBotResponse(paidTurn), success: Boolean(paidTurn?.orderNumber) });
    }
    if (state.stage !== "confirm") {
      const next = await nextStep({ ...createInitialState(phone), ...state }, buildDeps());
      return res.status(200).json({ ...base, success: false, message: next.question, step: state.stage });
    }
    // Con el mensaje del cliente (rawMessage/message) se procesa ESE mensaje: la conversación solo crea la orden si
    // classifyConfirmReply lo da como "confirm" (la misma función que usan /router y R7). "gracias" vuelve a mostrar
    // el resumen y "sí, pero agrégale un café" aplica el cambio, sin crear la orden. Sin mensaje, se confirma como
    // siempre (idempotente).
    const message = readMessage(body);
    const confirming = !message || classifyConfirmReply(message) === "confirm";
    const result = await runTurn(message ? { ...body, phone } : { phone, message: "confirmo" });
    if (!confirming) console.log(`[whatsapp-bot] checkout ${phone}: "${message.slice(0, 60)}" no confirma → ${result?.decision}`);
    res.status(200).json({ ...toBotResponse(result), success: Boolean(result?.orderNumber) });
  } catch (error) {
    console.error("[whatsapp-bot] checkout falló", error);
    res.status(200).json(errorResponse("Dame un segundito 🙏 No pude crear tu pedido ahorita. Escribe *confirmo* otra vez en un minuto"));
  }
}

// ─── Consulta de pedidos ─────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: "Pedido recibido",
  paid: "Pago confirmado",
  preparing: "En preparación",
  awaiting_pickup: "Listo para recoger",
  ready: "En camino",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

/**
 * Solo pedidos del teléfono que escribe. Antes se aceptaba cualquier correo que el
 * cliente escribiera, y cualquiera podía ver el pedido de otra persona.
 * Si el cliente pidió un número ("orden 17") y no es suyo, se dice eso: nunca se muestra otro pedido.
 */
async function trackOrderForPhone(phone: string, message: string, requested = "") {
  const orderNumber = requested || extractOrderNumber(message);
  if (isLid(phone)) {
    return { success: false, message: `No logro ver tu número de WhatsApp para buscar tus pedidos 🙏 Escríbenos al ${SUPPORT_PHONE} con tu número de pedido` } as { success: boolean; message: string; order?: any; trackingLink?: string };
  }
  const order: any = await Order.findOne({ customerPhone: { $in: phoneVariants(phone) }, ...(orderNumber ? { orderNumber } : {}) })
    .sort({ createdAt: -1 })
    .populate("branch", "name");
  if (!order) {
    return {
      success: false,
      message: orderNumber
        ? `No encuentro el pedido ${orderNumber} con este número 🙈 Si lo hiciste desde otro teléfono, escríbenos al ${SUPPORT_PHONE} y lo buscamos`
        : `No encuentro pedidos con este número 🙈 Si lo hiciste desde otro teléfono, escríbenos al ${SUPPORT_PHONE} y lo buscamos`,
    };
  }
  const trackingLink = order.picker?.smrURL || "";
  const unpaidCard = order.paymentMethod === "card" && order.status === "pending";
  const lines = [
    `*Pedido ${order.orderNumber}*`,
    `Estado: ${STATUS_LABELS[order.status] || order.status}${order.picker?.statusText ? ` · ${order.picker.statusText}` : ""}`,
    `${order.deliveryType === "pickup" ? "Retiro en" : "Sucursal"}: ${order.branch?.name || "Por confirmar"}`,
    order.items.map((item: any) => `${item.quantity} x ${item.name}`).join("\n"),
    `Total: $${(order.total / 100).toFixed(2)} · ${order.paymentMethod === "card" ? "Tarjeta" : "Efectivo"}`,
    unpaidCard ? `Todavía no nos llega el pago 💳 Puedes pagarlo aquí: ${botPaymentLink(order)}` : "",
    trackingLink ? `Sigue a tu motorizado en vivo aquí 🛵\n${trackingLink}` : "",
  ].filter(Boolean);
  return { success: true, message: lines.join("\n"), order, trackingLink };
}

/** En "consultar orden" un número suelto ("17", "#17") o el campo orderNumber es el número del pedido. */
function requestedOrderNumber(body: any, message: string) {
  return extractOrderNumber(clean(body?.orderNumber), { allowBare: true }) || extractOrderNumber(message, { allowBare: true });
}

export async function whatsappBotTrackOrder(req: Request, res: Response) {
  try {
    const body = { ...req.query, ...req.body };
    const phone = readPhone(body);
    if (!phone) return res.status(200).json({ success: false, route: "search_order", intencion: "consultar_pedido", message: NO_PHONE_MESSAGE });
    const message = readMessage(body);
    const result = await trackOrderForPhone(phone, message, requestedOrderNumber(body, message));
    res.status(200).json({
      success: result.success,
      route: "search_order",
      intencion: "consultar_pedido",
      message: result.message,
      orderNumber: result.order?.orderNumber || "",
      status: result.order?.status || "",
      trackingLink: result.trackingLink || "",
    });
  } catch (error) {
    console.error("[whatsapp-bot] track falló", axios.isAxiosError(error) ? error.message : error);
    res.status(200).json({ success: false, route: "search_order", intencion: "consultar_pedido", message: `Dame un segundito 🙏 No pude consultar tu pedido ahorita. Inténtalo en un minuto o escríbenos al ${SUPPORT_PHONE}` });
  }
}

// Compatibilidad con el flujo "consultar orden" de BuilderBot que llama /search-order.
export async function whatsappBotSearchOrder(req: Request, res: Response) {
  try {
    const body = { ...req.query, ...req.body };
    const phone = readPhone(body);
    const message = readMessage(body);
    const result = phone ? await trackOrderForPhone(phone, message, requestedOrderNumber(body, message)) : null;
    res.status(200).json({
      success: Boolean(result?.success),
      message: result?.message || NO_PHONE_MESSAGE,
      intencion: "consultar_pedido",
      telefonoSoporte: SUPPORT_PHONE,
      _intent: "consultar_pedido",
      missingData: [],
      orderNumber: result?.order?.orderNumber || "",
      trackingLink: result?.trackingLink || "",
    });
  } catch (error) {
    console.error("[whatsapp-bot] search-order falló", error);
    res.status(200).json({
      success: false,
      message: `Dame un segundito 🙏 No pude consultar tu pedido ahorita. Inténtalo en un minuto o escríbenos al ${SUPPORT_PHONE}`,
      intencion: "consultar_pedido",
      telefonoSoporte: SUPPORT_PHONE,
      _intent: "consultar_pedido",
      missingData: [],
    });
  }
}
