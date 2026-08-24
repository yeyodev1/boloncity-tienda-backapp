import axios from "axios";
import { Request, Response } from "express";
import { Types } from "mongoose";
import { Branch } from "../models/Branch";
import { Counter } from "../models/Counter";
import { Order } from "../models/Order";
import { Product } from "../models/Product";
import { getActivePromo, getOrCreateSettings, promoDiscountCents, Setting } from "../models/Setting";
import { WhatsAppSession } from "../models/WhatsAppSession";
import { env, getFrontendUrl } from "../config/env";
import { createPickerBooking, preCheckout } from "../services/pickerexpress.service";
import { pickerStatusFields } from "./order.controller";
import { getBranchPayphoneStoreId, getPickerStoreApiKey, pickerEnabledBranchFilter } from "../services/branchOperational.service";
import { distanceKm } from "../utils/haversine";
import { parseMapsUrl, resolveMapsCoordinates } from "../utils/parseMapsUrl";

type PaymentMethod = "card" | "cash";
type BotData = Record<string, unknown>;

function normalizePhone(value: unknown) {
  return String(value || "").replace(/[^0-9+]/g, "");
}

function latestHistoryMessage(history: unknown) {
  if (Array.isArray(history)) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (String(entry?.role || entry?.sender || "").toLowerCase() === "assistant") continue;
      const content = entry?.content || entry?.text || entry?.message || "";
      if (typeof content === "string" && content.trim()) return content.trim();
    }
  }
  return "";
}

function externalHistoryText(history: unknown) {
  if (typeof history === "string") return history.slice(-8000);
  if (Array.isArray(history)) {
    return history
      .slice(-25)
      .map((entry) => `${String(entry?.role || entry?.sender || "cliente")}: ${String(entry?.content || entry?.text || entry?.message || "")}`)
      .filter(Boolean)
      .join("\n")
      .slice(-8000);
  }
  return "";
}

function appendHistory(session: any, role: "user" | "assistant", content: string) {
  if (!content.trim()) return;
  session.history = [...(session.history || []), { role, content: content.trim(), createdAt: new Date() }].slice(-30);
}

function textHistory(session: any) {
  return (session.history || []).map((entry: any) => `${entry.role === "assistant" ? "Asistente" : "Cliente"}: ${entry.content}`).join("\n").slice(-12000);
}

async function findNearestBranch(lat: number, lng: number) {
  const branches = await Branch.find({ isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter() }).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  return branches
    .filter((branch) => branch.coordinates?.lat != null && branch.coordinates?.lng != null)
    .map((branch) => ({ branch, distance: distanceKm({ lat, lng }, { lat: branch.coordinates!.lat, lng: branch.coordinates!.lng }) }))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

async function quoteDelivery(lat: number, lng: number) {
  const nearest = await findNearestBranch(lat, lng);
  if (!nearest) throw new Error("No hay sucursales disponibles para delivery");
  let deliveryFee = 0;
  const branchKey = getPickerStoreApiKey(nearest.branch.pickerStore);
  if (branchKey) {
    try {
      deliveryFee = (await preCheckout({ branchKey, latitude: lat, longitude: lng })).deliveryFee;
    } catch {
      const settings = await Setting.findOne();
      deliveryFee = Math.round(nearest.distance * ((settings?.deliveryPricePerKm ?? 150) / 100) * 100) / 100;
    }
  }
  return { ...nearest, deliveryFee };
}

async function resolveBotItems(rawItems: unknown, branchId: string) {
  const requests = Array.isArray(rawItems) ? rawItems : [];
  if (!requests.length) return [];
  const products = await Product.find({ isAvailable: true });
  return requests.map((raw: any) => {
    const id = String(raw.productId || raw.product || "");
    const name = String(raw.name || raw.productName || "").toLowerCase();
    const product = (Types.ObjectId.isValid(id) ? products.find((item) => String(item._id) === id) : undefined) || products.find((item) => item.name.toLowerCase().includes(name) || name.includes(item.name.toLowerCase()));
    if (!product) return null;
    const price = product.branchPrices.find((item: any) => String(item.branch) === branchId)?.price ?? product.price;
    return { product: product._id, name: product.name, price, quantity: Math.max(1, Math.min(Number(raw.quantity || raw.qty) || 1, 50)), image: product.images[0]?.url || "", pointsValue: product.pointsValue || 0 };
  }).filter(Boolean);
}

async function buildCatalog(branchId?: string) {
  const products = await Product.find({ isAvailable: true }).sort({ sortOrder: 1, name: 1 });
  return products
    .filter((product) => product.sellWithoutStock || product.stock > 0)
    .map((product) => ({
      productId: String(product._id),
      name: product.name,
      price: product.branchPrices.find((item: any) => String(item.branch) === branchId)?.price ?? product.price,
      available: product.sellWithoutStock ? "disponible" : `${product.stock} disponibles`,
    }));
}

function catalogFallback(products: Awaited<ReturnType<typeof buildCatalog>>) {
  const recommendations = products.slice(0, 3);
  if (!recommendations.length) return "En este momento no tenemos productos disponibles ☕";
  return `Ya tenemos tu ubicación y calculamos el delivery\n\n${recommendations.map((product) => `${product.name} por $${product.price.toFixed(2)}`).join("\n")}\n\nIndícame cuál te gustaría pedir ☕`;
}

function collectMissing(data: any, invoiceRequired = false) {
  const missing: string[] = [];
  if (!data.customerName) missing.push("nombre");
  if (!data.customerEmail) missing.push("correo");
  if (!data.items?.length) missing.push("productos");
  if (!data.deliveryAddress) missing.push("dirección");
  if (!data.deliveryCoordinates?.lat || !data.deliveryCoordinates?.lng) missing.push("ubicación o enlace de Google Maps");
  if (!data.paymentMethod) missing.push("método de pago");
  if (!data.billingPreference) missing.push("preferencia de facturación");
  if (data.billingPreference === "invoice" || invoiceRequired) {
    if (!data.billingName) missing.push("nombre de facturación");
    if (!data.billingDocNumber) missing.push("cédula o RUC");
    if (!data.billingEmail) missing.push("correo de facturación");
    if (!data.billingAddress) missing.push("dirección de facturación");
  }
  return missing;
}

async function requiresInvoice(data: any) {
  const quote = await getSessionQuote(data);
  return (quote?.total || 0) > 50;
}

async function callGemini(message: string, history: string, branchId?: string, cartContext: unknown = []) {
  if (!env.GEMINI_API_KEY) return null;
  const catalog = await buildCatalog(branchId);
  const prompt = `Eres el asistente de ventas de Boloncity. Responde solo JSON válido con reply, data e intent. data puede contener customerName, customerEmail, deliveryAddress, paymentMethod (card|cash), billingPreference (final_consumer|invoice), billingName, billingDocNumber, billingEmail, billingAddress, items [{productId,quantity}].

FLUJO OBLIGATORIO:
1. La ubicación ya fue validada antes de llegar aquí. No la vuelvas a pedir salvo que el cliente quiera cambiarla.
2. Muestra o recomienda únicamente productos del CATÁLOGO REAL.
3. Recopila productos, nombre, correo, dirección, método de pago y preferencia de facturación.
4. Boloncity acepta exclusivamente tarjeta mediante PayPhone o efectivo al recibir. Nunca ofrezcas ni aceptes transferencias.
5. Pregunta siempre si desea consumidor final o factura. Si el pedido supera $50, los datos de factura son obligatorios: nombre, cédula/RUC, correo y dirección de facturación.
6. Cuando estén todos los datos, muestra un resumen y pide confirmación explícita. Nunca digas que la orden ya fue creada.
7. Si el cliente agrega, quita, cambia cantidad o cambia producto, data.items DEBE contener el carrito completo final, no solo el último cambio
8. Si el cliente cambia ubicación, la sucursal y el delivery los recalcula el backend; confirma el cambio sin inventar costo

ESTILO OBLIGATORIO PARA reply:
- Conversación humana, cálida y breve, usando el nombre del cliente cuando ya exista sin repetirlo artificialmente
- Usa el historial completo y nunca reinicies la conversación
- No uses respuestas prefabricadas ni tono robótico
- Boloncity es el nombre del negocio, NUNCA es el nombre del cliente. Nunca saludes al cliente como "Hola Boloncity" ni le atribuyas ese nombre
- Si no conoces el nombre del cliente, no inventes uno ni uses el nombre del negocio como saludo
- Cada reply debe ser una oración completa y clara, nunca una frase truncada o incompleta
- Ignora cualquier respuesta anterior del asistente que tenga disculpas, confusión o texto incompleto. No la repitas ni la menciones
- No pidas disculpas por defecto. Solo reconoce un error si el cliente actual describe uno concreto, y continúa de inmediato con una solución clara
- Para una solicitud inicial de pedido sin ubicación, explica claramente que necesitas su ubicación actual o enlace de Google Maps para calcular el delivery y mostrar productos
- No pongas emojis, signos de admiración, signos de interrogación ni puntuación al inicio
- Usa máximo un emoji natural al final
- Nunca termines reply con punto

CATÁLOGO REAL:
${JSON.stringify(catalog)}

CARRITO ACTUAL:
${JSON.stringify(cartContext)}

Mantén el historial y no inventes productos, precios, sucursales, pagos ni ubicaciones.

Historial:
${history}

Último mensaje: ${message}`;
  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 700 },
    }, { timeout: 25000 });
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (error) {
    console.error("[whatsapp-bot] Gemini failed", error instanceof Error ? error.message : error);
    return null;
  }
}

function mergeData(target: BotData, incoming: any) {
  if (!incoming || typeof incoming !== "object") return;
  for (const key of ["customerName", "customerEmail", "deliveryAddress", "paymentMethod", "billingName", "billingDocNumber", "billingEmail", "billingAddress"] as const) {
    if (typeof incoming[key] === "string" && incoming[key].trim()) target[key] = incoming[key].trim();
  }
  const billingPreference = String(incoming.billingPreference || "").toLowerCase();
  if (/final|consumidor/.test(billingPreference)) target.billingPreference = "final_consumer";
  if (/factura|invoice/.test(billingPreference)) target.billingPreference = "invoice";
  if (Array.isArray(incoming.items) && incoming.items.length) {
    target.items = incoming.items.map((item: any) => ({
      product: item.product || undefined,
      productId: item.productId || item.product || "",
      name: item.name || item.productName || "",
      quantity: Math.max(1, Math.min(Number(item.quantity || item.qty) || 1, 50)),
    }));
  }
}

function normalizeReply(value: unknown) {
  let reply = String(value || "").trim().replace(/^[\s¡!¿?.,:;]+/, "").replace(/[.]+$/g, "").trim();
  if (reply && !/[\p{Extended_Pictographic}]$/u.test(reply)) reply = `${reply} ☕`;
  return reply;
}

function replyLooksIncomplete(reply: string) {
  const text = reply.replace(/[\p{Extended_Pictographic}\s]+$/u, "").trim().toLowerCase();
  return /\b(?:para|por|con|de|del|la|el|los|las|tu|tus|mi|que|y|o|a|en|un|una)$/i.test(text) || /disculpa|confusi[oó]n|hola\s+boloncity|boloncity,\s+para\s+ayudarte/i.test(text);
}

function replyMissesRequiredContext(reply: string, context: string) {
  const normalizedReply = reply.toLowerCase();
  const normalizedContext = context.toLowerCase();
  const locationRequired = normalizedContext.includes("ubicación") || normalizedContext.includes("google maps");
  return locationRequired && !/(ubicaci[oó]n|google\s+maps|enlace\s+de\s+maps)/i.test(normalizedReply);
}

function locationRequiredMessage() {
  return "Comparte tu ubicación actual o un enlace de Google Maps para calcular el delivery y mostrarte los productos disponibles ☕";
}

async function callNaturalReply(context: string, history: string) {
  if (!env.GEMINI_API_KEY) return "";
  try {
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
      systemInstruction: { parts: [{ text: "Eres un asistente de ventas humano y cálido de Boloncity. Nunca llames Boloncity al cliente. Nunca respondas con disculpas genéricas, referencias a confusiones previas ni frases incompletas. Ignora mensajes defectuosos del asistente en el historial" }] },
      contents: [{ role: "user", parts: [{ text: `Redacta solo el mensaje final de WhatsApp para el cliente de Boloncity usando este historial y contexto\n\nHistorial\n${history}\n\nContexto verificado\n${context}\n\nReglas: Boloncity es el negocio, nunca el nombre del cliente; usa el nombre solo si está confirmado; humano, cálido, breve y completo; no reinicies; no uses emojis ni signos al inicio; usa máximo un emoji al final; no termines con punto; no inventes datos` }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 350 },
    }, { timeout: 25000 });
    let reply = normalizeReply(response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join(""));
    const locationRequired = context.toLowerCase().includes("ubicación") || context.toLowerCase().includes("google maps");
    if (replyLooksIncomplete(reply) || replyMissesRequiredContext(reply, context)) {
      const repair = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
        systemInstruction: { parts: [{ text: "Nunca uses disculpas genéricas ni menciones confusiones. Boloncity es el negocio y nunca el nombre del cliente" }] },
        contents: [{ role: "user", parts: [{ text: `La siguiente respuesta es inválida o quedó incompleta: "${reply}". Reescríbela como una sola respuesta completa, humana y breve para el cliente usando este contexto: ${context}. Si falta ubicación, la respuesta DEBE decir explícitamente "ubicación actual" o "enlace de Google Maps" para calcular delivery y mostrar productos. No uses puntuación al inicio, termina sin punto y con un emoji al final` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 350 },
      }, { timeout: 25000 });
      reply = normalizeReply(repair.data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join(""));
    }
    // Location is a hard business prerequisite; never send an incomplete AI sentence for it.
    if (locationRequired && (replyLooksIncomplete(reply) || replyMissesRequiredContext(reply, context))) {
      return locationRequiredMessage();
    }
    return reply;
  } catch (error) {
    console.error("[whatsapp-bot] Natural reply failed", error instanceof Error ? error.message : error);
    return "";
  }
}

async function setSessionLocation(session: any, coords: { lat: number; lng: number }, mapsUrl = "") {
  const quote = await quoteDelivery(coords.lat, coords.lng);
  session.data.deliveryType = "delivery";
  session.data.deliveryCoordinates = coords;
  session.data.deliveryGoogleMapsUrl = mapsUrl || `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
  session.data.branch = quote.branch._id;
  session.data.deliveryFee = quote.deliveryFee;
  session.data.deliveryDistance = Math.round(quote.distance * 10) / 10;
  return quote;
}

async function getSessionQuote(data: any) {
  if (!data.branch || !Array.isArray(data.items) || !data.items.length) return null;
  const items = await resolveBotItems(data.items, String(data.branch));
  if (!items.length) return null;
  const subtotal = items.reduce((total: number, item: any) => total + item.price * item.quantity, 0);
  const deliveryFee = Number(data.deliveryFee) || 0;
  const promo = getActivePromo(await getOrCreateSettings());
  const promoAmount = promoDiscountCents(Math.round(subtotal * 100), promo.percent) / 100;
  return { items, subtotal, deliveryFee, promo, promoAmount, total: Math.max(0, subtotal + deliveryFee - promoAmount) };
}

function formatOrderSummary(quote: NonNullable<Awaited<ReturnType<typeof getSessionQuote>>>) {
  const items = quote.items.map((item: any) => `${item.quantity} x ${item.name} $${(item.price * item.quantity).toFixed(2)}`).join("\n");
  const promoLine = quote.promoAmount > 0 ? `\n${quote.promo.label}: -$${quote.promoAmount.toFixed(2)}` : "";
  return `Resumen de tu pedido\n\n${items}\n\nSubtotal $${quote.subtotal.toFixed(2)}${promoLine}\nDelivery $${quote.deliveryFee.toFixed(2)}\nTotal $${quote.total.toFixed(2)}\n\nEscribe confirmo para crear tu orden o dime qué deseas cambiar ☕`;
}

function isCheckoutConfirmation(message: string) {
  return /\b(confirmo|confirmar|sí\s+confirmo|si\s+confirmo|quiero\s+pagar|pagar\s+ahora|dale|listo|proceder)\b/i.test(message);
}

function isTrackingRequest(message: string) {
  return /\b(mi\s+pedido|estado\s+(?:de\s+)?(?:mi\s+)?pedido|rastrear|seguimiento|tracking|d[oó]nde\s+(?:va|est[aá])\s+(?:mi\s+)?pedido|consultar\s+(?:mi\s+)?pedido|orden\s+ORD-)\b/i.test(message);
}

function extractEmail(text: unknown) {
  return String(text || "").match(/[a-z0-9._+-]+@[a-z0-9-]+\.[a-z0-9.-]+/i)?.[0]?.toLowerCase() || "";
}

function needsHumanSupport(text: unknown) {
  const normalized = String(text || "").toLowerCase();
  const urgent = /urgente|desesperad|nadie\s+(?:me\s+)?responde|quiero\s+hablar\s+con|humano|asesor|soporte|reclamo|queja|estafa|p[eé]simo/.test(normalized);
  const deliveryProblem = /no\s+(?:llega|ha\s+llegado)|demora|retras|horas|d[ií]as|cancelad/.test(normalized);
  return urgent || deliveryProblem;
}

export async function whatsappBotBrain(req: Request, res: Response) {
  const phone = normalizePhone(req.body.phone);
  const message = String(req.body.rawMessage || req.body.rawMess || req.body.body || req.body.message || "").trim();
  if (!phone || !message) return res.status(200).json({ success: false, route: "conversation", message: "", missingData: [], readyToCheckout: false });
  if (isTrackingRequest(message)) {
    const orderNumber = message.match(/\bORD-\d+\b/i)?.[0]?.toUpperCase() || "";
    const email = extractEmail(`${message}\n${req.body.history || ""}`);
    const reply = await callNaturalReply("El cliente quiere consultar una orden. Indícale que revisarás el estado con los datos de su conversación", String(req.body.history || ""));
    res.json({
      success: true,
      route: "tracking",
      targetEndpoint: "/api/orders/whatsapp-bot/track",
      message: reply,
      orderNumber,
      email,
      readyToCheckout: false,
    });
    return;
  }
  const session = await WhatsAppSession.findOne({ phone }) || new WhatsAppSession({ phone, history: [], data: { deliveryType: "delivery" } });
  const senderName = String(req.body.name || "").trim();
  if (senderName && senderName.toLowerCase() !== "boloncity" && !session.data.customerName) {
    session.data.customerName = senderName;
  }
  const hadLocation = Boolean(session.data.deliveryCoordinates?.lat && session.data.deliveryCoordinates?.lng);
  appendHistory(session, "user", message);
  const providedLocation = req.body.location || req.body.metadata?.location;
  const lat = Number(providedLocation?.latitude ?? providedLocation?.lat);
  const lng = Number(providedLocation?.longitude ?? providedLocation?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) await setSessionLocation(session, { lat, lng });
  const mapsMatch = message.match(/https?:\/\/\S+/i);
  if (mapsMatch) {
    const coords = await resolveMapsCoordinates(mapsMatch[0], undefined, env.GOOGLE_MAPS_API_KEY);
    if (coords) {
      await setSessionLocation(session, coords, mapsMatch[0]);
    }
  }
  if (!session.data.deliveryCoordinates?.lat || !session.data.deliveryCoordinates?.lng) {
    const reply = await callNaturalReply("Aún no hay ubicación válida. Pide al cliente que comparta su ubicación actual o un enlace de Google Maps para calcular delivery y asignar sucursal antes de mostrar productos", textHistory(session));
    appendHistory(session, "assistant", reply);
    await session.save();
    res.json({ success: true, route: "conversation", targetEndpoint: "/api/orders/whatsapp-bot/brain", message: reply, missingData: ["ubicación o enlace de Google Maps"], readyToCheckout: false, data: session.data });
    return;
  }
  if (!hadLocation) {
    const products = await buildCatalog(String(session.data.branch || ""));
    const generatedReply = await callNaturalReply(
      `La ubicación del cliente ya fue validada y el delivery está calculado. Recomienda exactamente estos 2 o 3 productos reales sin listar más: ${JSON.stringify(products.slice(0, 3))}. Pregunta cuál desea pedir`,
      textHistory(session)
    );
    const reply = /\$\d/.test(generatedReply) ? generatedReply : catalogFallback(products);
    appendHistory(session, "assistant", reply);
    await session.save();
    res.json({ success: true, route: "catalog", targetEndpoint: "/api/orders/whatsapp-bot/brain", message: reply, missingData: ["nombre", "correo", "productos", "dirección", "método de pago"], readyToCheckout: false, data: session.data });
    return;
  }
  const result = await callGemini(message, textHistory(session), String(session.data.branch || ""), session.data.items || []);
  mergeData(session.data as BotData, result?.data);
  const invoiceRequired = await requiresInvoice(session.data);
  const missing = collectMissing(session.data, invoiceRequired);
  const quote = await getSessionQuote(session.data);
  const reply = missing.length === 0 && quote && !isCheckoutConfirmation(message)
    ? formatOrderSummary(quote)
    : normalizeReply(result?.reply);
  const lowerMessage = message.toLowerCase();
  const route = missing.length === 0 && isCheckoutConfirmation(message)
    ? "checkout"
    : /\b(cat[aá]logo|productos|men[uú]|qu[eé]\s+venden)\b/i.test(lowerMessage) ? "catalog"
    : "conversation";
  appendHistory(session, "assistant", reply);
  await session.save();
  res.json({
    success: true,
    route,
    targetEndpoint: route === "checkout" ? "/api/orders/whatsapp-bot/checkout" : "/api/orders/whatsapp-bot/brain",
    message: reply,
    missingData: missing,
    invoiceRequired,
    quote,
    readyToCheckout: missing.length === 0 && isCheckoutConfirmation(message),
    data: session.data,
  });
}

// BuilderBot expects this legacy response envelope instead of the router payload.
export async function whatsappBotAssistant(req: Request, res: Response) {
  const rawMessage = String(req.body?.rawMessage || req.body?.rawMess || req.body?.body || req.body?.message || latestHistoryMessage(req.body?.history) || "").trim();
  const forwarded = Object.create(req) as Request;
  forwarded.body = { ...req.body, rawMessage };
  let statusCode = 200;
  let payload: any = null;
  const capture = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
  } as unknown as Response;

  await whatsappBotBrain(forwarded, capture);
  if (!payload) {
    res.status(200).json({ success: false, message: "", _intent: "chat", missingData: [] });
    return;
  }

  res.status(200).json({
    success: payload.success !== false,
    message: payload.message || "",
    _intent: payload.route === "conversation" ? "chat" : payload.route || "chat",
    missingData: payload.missingData || [],
  });
}

export async function whatsappBotCatalog(req: Request, res: Response) {
  const phone = normalizePhone(req.body?.phone || req.query.phone);
  const rawMessage = String(req.body?.rawMessage || req.body?.message || latestHistoryMessage(req.body?.history) || "").trim();
  const externalHistory = externalHistoryText(req.body?.history || req.query.history);
  const session = phone ? await WhatsAppSession.findOne({ phone }) : null;
  const history = `${textHistory(session || { history: [] })}\n${externalHistory}`.trim().slice(-12000);

  if (!session?.data.deliveryCoordinates?.lat || !session.data.deliveryCoordinates?.lng) {
    const message = await callNaturalReply("Aún no hay ubicación validada. Explica que antes de recomendar productos el cliente debe compartir ubicación o enlace de Google Maps para calcular delivery y asignar sucursal", history);
    return res.status(200).json({ success: false, message, _intent: "catalog", missingData: ["ubicación o enlace de Google Maps"] });
  }

  const result = await callGemini(
    `${rawMessage || "El cliente pidió recomendaciones"}. Recomienda exactamente 2 o 3 productos del catálogo real, según el historial y lo que busca el cliente. Incluye nombre y precio, no muestres el menú completo, no inventes productos y pregunta cuál desea pedir`,
    history,
    String(session.data.branch || "")
  );
  const message = normalizeReply(result?.reply);
  appendHistory(session, "assistant", message);
  await session.save();
  res.status(200).json({ success: Boolean(message), message, _intent: "catalog", missingData: [] });
}

export async function whatsappBotLocation(req: Request, res: Response) {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(200).json({ success: false, route: "conversation", message: "" });
  const session = await WhatsAppSession.findOne({ phone }) || new WhatsAppSession({ phone, history: [], data: { deliveryType: "delivery" } });
  const senderName = String(req.body.name || "").trim();
  if (senderName && senderName.toLowerCase() !== "boloncity" && !session.data.customerName) {
    session.data.customerName = senderName;
  }
  const mapsUrl = String(req.body.mapsUrl || "").trim();
  let coords = parseMapsUrl(mapsUrl);
  if (!coords && mapsUrl) coords = await resolveMapsCoordinates(mapsUrl, undefined, env.GOOGLE_MAPS_API_KEY);
  const lat = Number(req.body.latitude ?? req.body.lat);
  const lng = Number(req.body.longitude ?? req.body.longitud ?? req.body.lng);
  if (!coords && Number.isFinite(lat) && Number.isFinite(lng)) coords = { lat, lng };
  if (!coords) return res.status(200).json({ success: false, route: "conversation", message: "" });
  const quote = await setSessionLocation(session, coords, mapsUrl);
  const history = `${textHistory(session)}\n${externalHistoryText(req.body.history)}`.trim().slice(-12000);
  const products = await buildCatalog(String(quote.branch._id));
  const generatedMessage = await callNaturalReply(
    `El cliente compartió su ubicación actual. Ya asignamos la sucursal ${quote.branch.name} y calculamos delivery de $${quote.deliveryFee.toFixed(2)}. Recomienda exactamente estos 2 o 3 productos reales con precio: ${JSON.stringify(products.slice(0, 3))}. Pregunta cuál desea pedir`,
    history
  );
  const message = /\$\d/.test(generatedMessage) ? generatedMessage : catalogFallback(products);
  appendHistory(session, "assistant", message);
  await session.save();
  res.status(200).json({
    success: true,
    route: "catalog",
    _intent: "catalog",
    message,
    missingData: ["nombre", "correo", "productos", "dirección", "método de pago", "preferencia de facturación"],
    coordinates: coords,
    branch: { id: quote.branch._id, name: quote.branch.name },
    deliveryFee: quote.deliveryFee,
    distance: Math.round(quote.distance * 10) / 10,
    products: products.slice(0, 3),
  });
}

async function createBotOrder(session: any) {
  const data = session.data as any;
  const invoiceRequired = await requiresInvoice(data);
  const missing = collectMissing(data, invoiceRequired);
  if (missing.length) throw new Error(`Faltan datos: ${missing.join(", ")}`);
  let branch: any = null;
  let deliveryFee = 0;
  let distance = 0;
  if (data.deliveryType === "delivery") {
    const quote = await quoteDelivery(data.deliveryCoordinates.lat, data.deliveryCoordinates.lng);
    branch = quote.branch;
    deliveryFee = quote.deliveryFee;
    distance = quote.distance;
  } else if (data.branch) {
    branch = await Branch.findById(data.branch).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  }
  if (!branch) throw new Error("No se pudo asignar una sucursal");
  const items = await resolveBotItems(data.items, String(branch._id));
  if (!items.length) throw new Error("No hay productos válidos disponibles");
  const subtotal = items.reduce((sum: number, item: any) => sum + item.price * item.quantity, 0);
  // La promo global del catálogo también aplica al pedido por WhatsApp (solo productos).
  const botPromo = getActivePromo(await getOrCreateSettings());
  const botPromoCents = promoDiscountCents(Math.round(subtotal * 100), botPromo.percent);
  const counter = await Counter.findByIdAndUpdate({ _id: "orderNumber" }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  const order = await Order.create({
    orderNumber: `ORD-${String(counter.seq).padStart(5, "0")}`,
    items,
    subtotal: Math.round(subtotal * 100),
    tax: 0,
    promo: botPromoCents > 0 ? { percent: botPromo.percent, label: botPromo.label, amount: botPromoCents } : null,
    total: Math.max(0, Math.round((subtotal + deliveryFee) * 100) - botPromoCents),
    paymentMethod: data.paymentMethod as PaymentMethod,
    deliveryType: data.deliveryType,
    deliveryCost: Math.round(deliveryFee * 100),
    deliveryDistance: distance,
    deliveryAddress: data.deliveryAddress || "",
    deliveryGoogleMapsUrl: data.deliveryGoogleMapsUrl || "",
    deliveryCoordinates: data.deliveryCoordinates || null,
    status: "pending",
    customerEmail: data.customerEmail,
    customerName: data.customerName,
    customerPhone: session.phone,
    branch: branch._id,
    ...(data.billingPreference === "invoice" || invoiceRequired ? {
      billing: {
        docType: "invoice",
        name: data.billingName,
        docNumber: data.billingDocNumber,
        email: data.billingEmail,
        address: data.billingAddress,
      },
    } : {}),
    source: "whatsapp",
    audit: [{ action: "created", details: "Pedido creado desde WhatsApp", toValue: "pending", timestamp: new Date() }],
    payphone: { clientTransactionId: `BOL-${Date.now()}`, storeId: getBranchPayphoneStoreId(branch.payphone) },
  });
  if (data.paymentMethod === "cash" && data.deliveryType === "delivery") {
    const branchKey = getPickerStoreApiKey(branch.pickerStore);
    if (!branchKey) throw new Error("La sucursal no tiene Picker configurado");
    const [firstName, ...lastName] = String(order.customerName || "Cliente").split(" ");
    const booking = await createPickerBooking({ branchKey, latitude: data.deliveryCoordinates.lat, longitude: data.deliveryCoordinates.lng, address: order.deliveryAddress, reference: order.deliveryGoogleMapsUrl, customerName: firstName, customerLastName: lastName.join(" ") || "Cliente", customerEmail: order.customerEmail, customerPhone: order.customerPhone || "", customerCountryCode: "593", orderAmount: subtotal, businessDeliveryFee: deliveryFee, paymentMethod: "CASH", externalBookingId: order.orderNumber, cookTime: Math.max(0, Math.round(Number(branch.cookTimeMinutes) || 0)) * 60_000 });
    order.picker = { bookingId: booking._id, bookingNumericId: booking.bookingNumericId, ...pickerStatusFields(booking), smrURL: booking.smrURL, bookingDetailUrl: booking.bookingDetailUrl, createdAt: new Date(), deliveryFee: booking.deliveryFee || 0 };
    order.audit.push({ action: "note_added", details: `Picker booking #${booking.bookingNumericId} creado para efectivo`, timestamp: new Date() });
    await order.save();
  }
  return order;
}

export async function whatsappBotCheckout(req: Request, res: Response) {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(200).json({ success: false, message: "", missingData: ["teléfono"] });
    const session = await WhatsAppSession.findOne({ phone });
    if (!session) return res.status(200).json({ success: false, message: "", missingData: ["conversación activa"] });
    mergeData(session.data as BotData, req.body.data);
    const order = await createBotOrder(session);
    await WhatsAppSession.deleteOne({ _id: session._id });
    const paymentLink = order.paymentMethod === "card" ? `${getFrontendUrl()}/pago/${order.orderNumber}?email=${encodeURIComponent(order.customerEmail)}` : "";
    res.status(200).json({ success: true, order, paymentLink, trackingLink: order.picker?.smrURL || "" });
  } catch (error) {
    console.error("[whatsapp-bot] Checkout failed", error instanceof Error ? error.message : error);
    res.status(200).json({ success: false, message: "", missingData: [] });
  }
}

export async function whatsappBotTrackOrder(req: Request, res: Response) {
  const orderNumber = String(req.query.orderNumber || req.body?.orderNumber || "").trim();
  const phone = normalizePhone(req.query.phone || req.body?.phone);
  const history = String(req.query.history || req.body?.history || "");
  const email = String(req.query.email || req.body?.email || extractEmail(history)).trim().toLowerCase();
  const context = `${req.body?.rawMessage || req.body?.message || ""}\n${history}`;
  const escalated = needsHumanSupport(context);
  if (!phone && !email) return res.status(200).json({ success: false, route: "tracking", message: "" });
  const query: Record<string, unknown> = { ...(orderNumber ? { orderNumber } : {}) };
  if (email) query.customerEmail = email;
  else query.customerPhone = phone;
  const order = await Order.findOne(query)
    .sort({ createdAt: -1 })
    .populate("branch", "name");
  if (!order) {
    const message = await callNaturalReply(
      escalated
        ? "No hay pedido encontrado. El cliente parece urgente o necesita soporte. Indica que este número es exclusivo para ventas y lo atiende una IA, y que para que un asesor tome su caso rápido debe escribir al +593 99 315 7333"
        : "No hay pedido encontrado. Pide el correo usado en la compra o el número de orden, sin inventar datos",
      context
    );
    return res.status(200).json({ success: false, route: "tracking", escalated, message });
  }
  const statusLabels: Record<string, string> = {
    pending: "Pedido recibido",
    paid: "Pago confirmado",
    preparing: "En preparación",
    awaiting_pickup: "Listo para recoger",
    ready: "En camino",
    delivered: "Entregado",
    cancelled: "Cancelado",
  };
  const paymentLabels: Record<PaymentMethod, string> = { card: "Tarjeta PayPhone", cash: "Efectivo" };
  const date = (value?: Date) => value ? new Intl.DateTimeFormat("es-EC", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Guayaquil" }).format(value) : "Por confirmar";
  const total = (order.total / 100).toFixed(2);
  const items = order.items.map((item: { quantity: number; name: string }) => `• ${item.quantity} x ${item.name}`).join("\n");
  const trackingLink = order.picker?.smrURL || "";
  const pickerStatus = order.picker?.statusText || "";
  const facts = [
    `Pedido: ${order.orderNumber}`,
    `Estado: ${statusLabels[order.status] || order.status}${pickerStatus ? `, ${pickerStatus}` : ""}`,
    `Sucursal: ${(order.branch as any)?.name || "Por confirmar"}`,
    `Productos: ${items}`,
    `Total: $${total}`,
    `Pago: ${paymentLabels[order.paymentMethod as PaymentMethod] || order.paymentMethod}`,
    `Creado: ${date(order.createdAt)}`,
    order.scheduledFor ? `Programado: ${date(order.scheduledFor)}` : "",
    trackingLink ? `Link de seguimiento Picker: ${trackingLink}` : "",
    escalated ? "El cliente parece urgente o necesita soporte. Indica que este número es exclusivo para ventas y lo atiende una IA, y que para que un asesor tome su caso rápido debe escribir al +593 99 315 7333" : "",
  ].filter(Boolean).join("\n");
  const message = await callNaturalReply(`Redacta una actualización clara usando únicamente estos datos verificados\n${facts}`, context);
  res.json({ success: true, route: "tracking", escalated, message, orderNumber: order.orderNumber, status: order.status, paymentMethod: order.paymentMethod, paymentVerified: order.status !== "pending" || order.paymentMethod === "cash", trackingLink, pickerStatus, createdAt: order.createdAt, scheduledFor: order.scheduledFor || null, total: order.total, items: order.items });
}

// Compatibility endpoint for existing BuilderBot flows that still call /search-order.
export async function whatsappBotSearchOrder(req: Request, res: Response) {
  let payload: any = null;
  const capture = {
    status() {
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    },
  } as unknown as Response;

  await whatsappBotTrackOrder(req, capture);
  res.status(200).json({
    success: payload?.success === true,
    message: payload?.message || "",
    _intent: "tracking",
    missingData: payload?.missingData || [],
    trackingLink: payload?.trackingLink || "",
  });
}
