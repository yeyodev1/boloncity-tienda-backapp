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
import { getBranchAvailability, getBranchPayphoneStoreId, isBranchOpenAt, pickerEnabledBranchFilter } from "../services/branchOperational.service";
import { quoteDelivery } from "../services/deliveryQuote.service";
import { calculateEarnedPoints } from "../services/points.service";
import { sendEmail } from "../services/resend.service";
import { getOrderStatusEmailHtml } from "../services/email-templates";
import { distanceKm } from "../utils/haversine";
import { parseMapsUrl, resolveMapsCoordinates } from "../utils/parseMapsUrl";
import { normalizePhone } from "../utils/phone";
import { isAvailableAt } from "../utils/productAvailability";
import { loadCatalog, searchCatalog } from "../services/whatsappBot/catalog";
import { aiExtract } from "../services/whatsappBot/extractor";
import { extractOrderNumber } from "../services/whatsappBot/intents";
import { BotDeps, BotState, BuilderBotRoute, classifyRoute, createInitialState, handleTurn, LastOrder, nextStep, TurnResult } from "../services/whatsappBot/router";

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

function toE164(value: unknown) {
  return normalizePhone(value)?.e164 || String(value || "").replace(/[^0-9+]/g, "");
}

/** Las órdenes viejas guardaron el teléfono en formatos distintos: se buscan todos. */
function phoneVariants(value: unknown) {
  const phone = normalizePhone(value);
  if (!phone) return [String(value || "")];
  return [phone.e164, `${phone.code}${phone.number}`, `0${phone.number}`, phone.number, `+${phone.code} ${phone.number}`];
}

function appendHistory(session: any, role: "user" | "assistant", content: string) {
  if (!content.trim()) return;
  session.history = [...(session.history || []), { role, content: content.trim().slice(0, 2000), createdAt: new Date() }].slice(-30);
}

function readMessage(body: any) {
  return String(body?.rawMessage || body?.rawMess || body?.body || body?.message || "").trim();
}

function readLocation(body: any): { lat: number; lng: number } | null {
  const source = body?.location || body?.metadata?.location || body;
  const lat = Number(source?.latitude ?? source?.lat);
  const lng = Number(source?.longitude ?? source?.longitud ?? source?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
}

// ─── Dependencias reales del router ──────────────────────────────────────────

async function findLastOrder(phone: string): Promise<LastOrder | null> {
  const order: any = await Order.findOne({
    customerPhone: { $in: phoneVariants(phone) },
    status: { $ne: "cancelled" },
    // Una tarjeta que nunca se pagó no es "lo de la última vez".
    $nor: [{ status: "pending", paymentMethod: "card" }],
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

/** Igual que el checkout web (delivery.controller.ts): de la sucursal más cercana hacia afuera, la primera que cubre el punto. */
async function quoteBotLocation(coords: { lat: number; lng: number }, paymentMethod?: "card" | "cash") {
  const branches = await activeBranchesQuery().select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  const candidates = branches
    .filter((branch) => branch.coordinates?.lat != null && branch.coordinates?.lng != null)
    .map((branch) => ({ branch, distance: distanceKm(coords, { lat: branch.coordinates!.lat, lng: branch.coordinates!.lng }) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_BRANCHES_TO_QUOTE);
  const settings = await getOrCreateSettings();
  let lastReason = "Todavía no llegamos a esa dirección con delivery";
  for (const { branch } of candidates) {
    const quote = await quoteDelivery({ branch, lat: coords.lat, lng: coords.lng, paymentMethod: paymentMethod === "cash" ? "CASH" : "CARD" });
    if (!quote.covered) {
      lastReason = quote.reason || lastReason;
      continue;
    }
    // Un delivery jamás sale gratis (misma regla que createOrder).
    const deliveryFee = quote.deliveryFee > 0 ? quote.deliveryFee : (settings.deliveryPricePerKm || 150) / 100;
    return { covered: true as const, branchId: String(branch._id), branchName: branch.name, deliveryFee, distance: Math.round(quote.distance * 10) / 10 };
  }
  return { covered: false as const, reason: lastReason };
}

async function branchStatus(branchId: string) {
  const branch = await Branch.findById(branchId);
  if (!branch || !branch.isActive) return { open: false, message: "Esa sucursal no está disponible. Elige otra o cambia a delivery" };
  if (isBranchOpenAt(branch)) return { open: true };
  const availability = getBranchAvailability(branch);
  return {
    open: false,
    message: availability.nextOpening
      ? `${branch.name} está cerrada en este momento. Abre ${describeOpeningDay(availability.nextOpening.at, branch.timezone)} a las ${availability.nextOpening.opensAt}. Escríbenos desde esa hora y te tomamos el pedido`
      : `${branch.name} no tiene horario de atención configurado`,
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
  if (!branch) throw new Error("No pudimos asignar una sucursal a tu pedido");
  if (!isBranchOpenAt(branch)) throw new Error(`${branch.name} está cerrada en este momento`);

  const isDelivery = state.deliveryType === "delivery";
  let deliveryCostCents = 0;
  let deliveryDistance = 0;
  if (isDelivery) {
    if (!state.deliveryCoordinates) throw new Error("Falta tu ubicación para el delivery");
    const quote = await quoteDelivery({ branch, lat: state.deliveryCoordinates.lat, lng: state.deliveryCoordinates.lng, paymentMethod: state.paymentMethod === "cash" ? "CASH" : "CARD" });
    if (!quote.covered) throw new Error(quote.reason || "Todavía no llegamos a esa dirección con delivery");
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
  if (unavailable.length) throw new Error(`Ya no está disponible: ${unavailable.join(", ")}. Dime si lo cambio por otra cosa`);
  if (!orderItems.length) throw new Error("Tu pedido está vacío");

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
    customerPhone: toE164(state.phone),
    notes: state.notes || "",
    branch: branch._id,
    ...(state.billingPreference === "invoice" && docNumber
      ? { billing: { docType: docNumber.length === 13 ? "ruc" : "cedula", name: state.billingName || state.customerName, docNumber, email: state.customerEmail || "", address: state.deliveryAddress || "" } }
      : {}),
    source: "whatsapp",
    audit: [{ action: "created", details: `Pedido creado desde WhatsApp · Sucursal: ${branch.name}`, toValue: "pending", timestamp: new Date() }],
    payphone: { clientTransactionId: `BOL-${Date.now()}`, storeId: getBranchPayphoneStoreId(branch.payphone) },
  });

  // Efectivo: exactamente lo que hace createOrder. Tarjeta: todo esto ocurre en confirmOrder al pagar.
  if (order.paymentMethod === "cash") {
    if (isDelivery) await bookPickerForOrder(order, "CASH");
    await sendOrderToRunfood(order);
    await reportPurchaseToMeta(order);
    const html = getOrderStatusEmailHtml({
      orderNumber: order.orderNumber,
      customerName: order.customerName || "Cliente",
      status: order.status,
      statusText: `Recibimos tu pedido — pagas en efectivo al ${isDelivery ? "recibirlo" : "retirarlo en el local"}`,
      detailUrl: `${getFrontendUrl()}/pedido`,
      items: order.items || [],
      total: order.total,
    });
    await sendEmail(order.customerEmail, `Boloncity: recibimos tu pedido ${order.orderNumber}`, html).catch(() => {});
  }
  return order;
}

async function createOrderWithLock(state: BotState) {
  const phone = toE164(state.phone);
  const now = new Date();
  // Candado atómico de 45 s: si BuilderBot reintenta el "confirmo" mientras se crea la orden, el segundo no crea otra.
  const locked = await WhatsAppSession.findOneAndUpdate(
    { phone, $or: [{ checkoutLockUntil: null }, { checkoutLockUntil: { $lt: now } }] },
    { $set: { checkoutLockUntil: new Date(now.getTime() + 45_000) } }
  );
  if (!locked) return { ok: false as const, message: "Ya estoy creando tu pedido, dame unos segundos" };
  try {
    const order = await createBotOrder(state);
    const paymentLink = order.paymentMethod === "card" ? `${getFrontendUrl()}/pago/${order.orderNumber}?email=${encodeURIComponent(order.customerEmail)}` : undefined;
    return { ok: true as const, orderNumber: order.orderNumber, total: order.total / 100, paymentLink };
  } catch (error) {
    console.error("[whatsapp-bot] no se pudo crear la orden", error instanceof Error ? error.message : error);
    return { ok: false as const, message: error instanceof Error && error.message ? error.message : "No pude crear tu pedido" };
  } finally {
    await WhatsAppSession.updateOne({ phone }, { $set: { checkoutLockUntil: null } });
  }
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
    pickupBranches: async () =>
      (await activeBranchesQuery().sort({ name: 1 })).map((branch) => ({ branchId: String(branch._id), name: branch.name, address: branch.address || undefined })),
    branchStatus,
    quote: quoteState,
    createOrder: createOrderWithLock,
    trackOrder: async (phone, message) => (await trackOrderForPhone(phone, message)).message,
    extract: aiExtract,
    menuUrl: `${getFrontendUrl()}/catalogo`,
    supportPhone: SUPPORT_PHONE,
  };
}

// ─── Turno de conversación ───────────────────────────────────────────────────

async function runTurn(body: any): Promise<(TurnResult & { duplicated?: boolean }) | null> {
  const phone = toE164(body?.phone || body?.from);
  if (!phone) return null;
  const message = readMessage(body);
  const location = readLocation(body);
  const session = (await WhatsAppSession.findOne({ phone })) || new WhatsAppSession({ phone, history: [] });

  // BuilderBot reintenta cuando una respuesta tarda: el mismo mensaje en menos de 5 s recibe la misma respuesta.
  const hash = crypto.createHash("sha1").update(`${message}|${location?.lat ?? ""}|${location?.lng ?? ""}`).digest("hex");
  if (session.lastMessageHash === hash && session.lastMessageAt && Date.now() - session.lastMessageAt.getTime() < 5000 && session.lastReply) {
    const state = { ...createInitialState(phone), ...(session.state || {}) } as BotState;
    return { state, reply: session.lastReply, route: "conversation", intent: state.lastIntent || "conversar", step: state.stage, decision: "R0:duplicado", duplicated: true };
  }

  const previous = { ...createInitialState(phone), ...(session.state || {}), phone } as BotState;
  appendHistory(session, "user", message || (location ? `[ubicación ${location.lat},${location.lng}]` : ""));
  const result = await handleTurn(previous, { message, location, senderName: String(body?.name || "") }, buildDeps());
  result.state.lastIntent = result.intent;
  appendHistory(session, "assistant", result.reply);
  session.state = JSON.parse(JSON.stringify(result.state));
  session.markModified("state");
  session.lastMessageHash = hash;
  session.lastMessageAt = new Date();
  session.lastReply = result.reply;
  await session.save();
  console.log(`[whatsapp-bot] ${phone} ${result.decision} → paso ${result.step}`);
  return result;
}

function toBotResponse(result: TurnResult | null) {
  if (!result) {
    return { success: false, intencion: "dudas", telefonoSoporte: SUPPORT_PHONE, route: "conversation", message: "", missingData: [], readyToCheckout: false };
  }
  return {
    success: true,
    // Para las Rules de BuilderBot: conversar | menu | dudas | consultar_pedido | orden_creada.
    // "dudas" = el bot no puede resolverlo y hay que derivar al número de soporte.
    intencion: result.intent,
    telefonoSoporte: SUPPORT_PHONE,
    route: result.route,
    message: result.reply,
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
    const phone = toE164(body.phone || body.from);
    const session: any = phone ? await WhatsAppSession.findOne({ phone }).lean() : null;
    const state = session?.state ? ({ ...createInitialState(phone), ...session.state } as BotState) : null;
    const route = classifyRoute(state, readMessage(body), Boolean(readLocation(body)));
    console.log(`[whatsapp-bot] router ${phone} → ${route} (paso ${state?.stage || "nuevo"})`);
    res.status(200).json({ success: true, route, intencion: ROUTE_INTENT[route], step: state?.stage || "idle", telefonoSoporte: SUPPORT_PHONE, message: "" });
  } catch (error) {
    console.error("[whatsapp-bot] router falló", error);
    // Ante la duda, a la conversación: ahí el cliente siempre recibe una respuesta.
    res.status(200).json({ success: true, route: "conversation", intencion: "conversar", step: "idle", telefonoSoporte: SUPPORT_PHONE, message: "" });
  }
}

/** Punto de entrada principal: todos los flujos de BuilderBot pueden llamar aquí. */
export async function whatsappBotBrain(req: Request, res: Response) {
  try {
    res.status(200).json(toBotResponse(await runTurn(req.body)));
  } catch (error) {
    console.error("[whatsapp-bot] brain falló", error);
    res.status(200).json({ success: false, route: "conversation", message: "Tuve un problema procesando tu mensaje. ¿Me lo repites?", missingData: [], readyToCheckout: false });
  }
}

// BuilderBot espera este sobre en el flujo del asistente.
export async function whatsappBotAssistant(req: Request, res: Response) {
  try {
    const result = await runTurn(req.body);
    res.status(200).json({
      success: Boolean(result),
      message: result?.reply || "",
      intencion: result?.intent || "dudas",
      telefonoSoporte: SUPPORT_PHONE,
      _intent: result?.intent || "dudas",
      missingData: [],
    });
  } catch (error) {
    console.error("[whatsapp-bot] assistant falló", error);
    res.status(200).json({ success: false, message: "Tuve un problema procesando tu mensaje. ¿Me lo repites?", _intent: "chat", missingData: [] });
  }
}

/** Flujo "Catálogo Productos": sin mensaje se comporta como "menú". */
export async function whatsappBotCatalog(req: Request, res: Response) {
  try {
    const body = { ...req.query, ...req.body };
    if (!readMessage(body)) body.message = "menú";
    const result = await runTurn(body);
    res.status(200).json({ ...toBotResponse(result), _intent: "menu" });
  } catch (error) {
    console.error("[whatsapp-bot] catalog falló", error);
    res.status(200).json({ success: false, message: "", intencion: "dudas", telefonoSoporte: SUPPORT_PHONE, _intent: "dudas", missingData: [] });
  }
}

/** Flujo "envian ubicacion nativa": lat/lng de WhatsApp o mapsUrl. */
export async function whatsappBotLocation(req: Request, res: Response) {
  try {
    const body = { ...req.body };
    if (body.mapsUrl && !readMessage(body)) body.message = String(body.mapsUrl);
    const result = await runTurn(body);
    res.status(200).json({ ...toBotResponse(result), _intent: "conversar" });
  } catch (error) {
    console.error("[whatsapp-bot] location falló", error);
    res.status(200).json({ success: false, route: "location", message: "No pude leer tu ubicación. ¿Me la compartes de nuevo?" });
  }
}

/**
 * Flujo "checkout link de pago". Idempotente: si la orden ya existe devuelve la misma;
 * si faltan datos responde qué falta; si el resumen ya se mostró, confirma.
 */
export async function whatsappBotCheckout(req: Request, res: Response) {
  try {
    const phone = toE164(req.body?.phone);
    const session = phone ? await WhatsAppSession.findOne({ phone }) : null;
    const state = session?.state as BotState | undefined;
    const base = { intencion: "conversar", telefonoSoporte: SUPPORT_PHONE };
    if (!session || !state) return res.status(200).json({ ...base, success: false, message: "Aún no tengo tu pedido. Dime qué te gustaría pedir" });
    if (state.stage === "ordered" && state.lastOrderNumber) {
      return res.status(200).json({
        ...base,
        intencion: "orden_creada",
        success: true,
        message: `Tu pedido ${state.lastOrderNumber} ya está registrado${state.lastPaymentLink ? `\nPágalo aquí: ${state.lastPaymentLink}` : ""}`,
        orderNumber: state.lastOrderNumber,
        paymentLink: state.lastPaymentLink || "",
      });
    }
    if (state.stage !== "confirm") {
      const next = await nextStep({ ...createInitialState(phone), ...state }, buildDeps());
      return res.status(200).json({ ...base, success: false, message: next.question, step: state.stage });
    }
    const result = await runTurn({ phone, message: "confirmo" });
    res.status(200).json({ ...toBotResponse(result), success: result?.decision === "R7:orden_creada" || result?.decision === "R7:ya_confirmado" });
  } catch (error) {
    console.error("[whatsapp-bot] checkout falló", error);
    res.status(200).json({ success: false, intencion: "conversar", telefonoSoporte: SUPPORT_PHONE, message: "No pude crear tu pedido en este momento. Escribe *confirmo* otra vez en un minuto" });
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
 */
async function trackOrderForPhone(phone: string, message: string) {
  const orderNumber = extractOrderNumber(message);
  const order: any = await Order.findOne({ customerPhone: { $in: phoneVariants(phone) }, ...(orderNumber ? { orderNumber } : {}) })
    .sort({ createdAt: -1 })
    .populate("branch", "name");
  if (!order) {
    return {
      success: false,
      message: orderNumber
        ? `No encuentro el pedido ${orderNumber} asociado a este número. Si lo hiciste con otro teléfono, escríbenos al ${SUPPORT_PHONE}`
        : `No encuentro pedidos con este número. Si lo hiciste con otro teléfono, escríbenos al ${SUPPORT_PHONE}`,
    };
  }
  const trackingLink = order.picker?.smrURL || "";
  const unpaidCard = order.paymentMethod === "card" && order.status === "pending";
  const lines = [
    `Pedido ${order.orderNumber}`,
    `Estado: ${STATUS_LABELS[order.status] || order.status}${order.picker?.statusText ? ` · ${order.picker.statusText}` : ""}`,
    `${order.deliveryType === "pickup" ? "Retiro en" : "Sucursal"}: ${order.branch?.name || "Por confirmar"}`,
    order.items.map((item: any) => `${item.quantity} x ${item.name}`).join("\n"),
    `Total: $${(order.total / 100).toFixed(2)} · ${order.paymentMethod === "card" ? "Tarjeta" : "Efectivo"}`,
    unpaidCard ? `Aún no registramos el pago. Puedes pagarlo aquí: ${getFrontendUrl()}/pago/${order.orderNumber}?email=${encodeURIComponent(order.customerEmail)}` : "",
    trackingLink ? `Sigue tu delivery en vivo: ${trackingLink}` : "",
  ].filter(Boolean);
  return { success: true, message: lines.join("\n"), order, trackingLink };
}

export async function whatsappBotTrackOrder(req: Request, res: Response) {
  try {
    const phone = toE164(req.query.phone || req.body?.phone);
    if (!phone) return res.status(200).json({ success: false, route: "tracking", message: "" });
    const message = `${req.query.orderNumber || req.body?.orderNumber || ""} ${readMessage(req.body)}`;
    const result = await trackOrderForPhone(phone, message);
    res.status(200).json({
      success: result.success,
      route: "tracking",
      message: result.message,
      orderNumber: result.order?.orderNumber || "",
      status: result.order?.status || "",
      trackingLink: result.trackingLink || "",
    });
  } catch (error) {
    console.error("[whatsapp-bot] track falló", axios.isAxiosError(error) ? error.message : error);
    res.status(200).json({ success: false, route: "tracking", message: "No pude consultar tu pedido en este momento" });
  }
}

// Compatibilidad con el flujo "consultar orden" de BuilderBot que llama /search-order.
export async function whatsappBotSearchOrder(req: Request, res: Response) {
  try {
    const phone = toE164(req.query.phone || req.body?.phone);
    const result = phone ? await trackOrderForPhone(phone, `${req.query.orderNumber || req.body?.orderNumber || ""} ${readMessage(req.body)}`) : null;
    res.status(200).json({
      success: Boolean(result?.success),
      message: result?.message || "",
      intencion: "consultar_pedido",
      telefonoSoporte: SUPPORT_PHONE,
      _intent: "consultar_pedido",
      missingData: [],
      trackingLink: result?.trackingLink || "",
    });
  } catch (error) {
    console.error("[whatsapp-bot] search-order falló", error);
    res.status(200).json({ success: false, message: "", intencion: "dudas", telefonoSoporte: SUPPORT_PHONE, _intent: "dudas", missingData: [] });
  }
}
