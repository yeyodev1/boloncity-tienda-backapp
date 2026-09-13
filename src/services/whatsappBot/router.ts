import { addToCart, CartItem, findInCart, removeFromCart, setCartQuantity } from "./cart";
import { CatalogProduct, listCategories, normalizeText, pickOption, SearchResult, tokenSimilarity, meaningfulTokens } from "./catalog";
import { Extraction, Extractor } from "./extractor";
import {
  detectDeliveryType,
  detectPaymentMethod,
  extractDocNumber,
  extractMapsUrl,
  isNo,
  isYes,
  looksLikeBareName,
  titleCase,
  wantsCart,
  wantsClearCart,
  wantsConfirm,
  wantsHuman,
  wantsMenu,
  wantsReorder,
  wantsTracking,
} from "./intents";

/**
 * ROUTER DEL BOT ("el discriminador").
 *
 * Cada mensaje del cliente pasa por `handleTurn`, que hace SIEMPRE lo mismo:
 *
 *   1. Revisa reglas en un orden fijo (R1…R11). La primera que aplica decide qué
 *      hacer con el mensaje. El orden importa: una ubicación o "quiero hablar con
 *      alguien" gana sobre cualquier otra cosa.
 *   2. Aplica el cambio al estado de la conversación (carrito, datos, entrega, pago).
 *   3. Calcula el SIGUIENTE PASO con `nextStep`: lo primero que falte para cerrar
 *      el pedido, en un orden fijo. El bot siempre termina preguntando eso, así
 *      nunca pierde el hilo de qué está ordenando el cliente.
 *
 * Es puro: no toca Mongo ni HTTP. Todo lo externo llega por `deps`, así se prueba
 * completo sin base de datos (ver src/scripts/testWhatsappBot.ts).
 * La documentación para negocio está en docs/whatsapp-bot/ROUTER.md.
 */

export type Stage =
  | "idle" // carrito vacío, esperando qué quiere pedir
  | "choosing" // el bot mostró opciones y espera que elija
  | "delivery_type" // ¿delivery o retiro?
  | "location" // falta la ubicación del delivery
  | "address" // falta la referencia escrita de la dirección
  | "branch" // falta elegir sucursal para retiro
  | "name"
  | "email"
  | "payment"
  | "invoice_doc"
  | "invoice_name"
  | "confirm" // resumen mostrado, esperando "confirmo"
  | "closed" // la sucursal está cerrada
  | "ordered"; // la orden ya se creó

export interface ProductOption {
  productId: string;
  name: string;
  price: number;
}

export interface BranchOption {
  branchId: string;
  name: string;
  address?: string;
}

export interface LastOrder {
  orderNumber: string;
  createdAt: Date;
  items: CartItem[];
  customerName?: string;
  customerEmail?: string;
  deliveryType?: "delivery" | "pickup";
  deliveryAddress?: string;
  deliveryCoordinates?: { lat: number; lng: number } | null;
  deliveryGoogleMapsUrl?: string;
  branchId?: string;
  branchName?: string;
}

export type PendingChoice =
  | { kind: "product"; query: string; quantity: number; options: ProductOption[] }
  | { kind: "reorder"; order: LastOrder }
  | { kind: "reuse_location"; address: string; coords: { lat: number; lng: number }; mapsUrl: string }
  | { kind: "branch"; options: BranchOption[] };

export interface BotState {
  phone: string;
  stage: Stage;
  cart: CartItem[];
  pendingChoice: PendingChoice | null;
  /** Productos que el cliente pidió en el mismo mensaje y esperan a que se resuelva una elección anterior. */
  choiceQueue: Array<{ query: string; quantity: number }>;
  deliveryType?: "delivery" | "pickup";
  branchId?: string;
  branchName?: string;
  deliveryCoordinates?: { lat: number; lng: number };
  deliveryGoogleMapsUrl?: string;
  deliveryAddress?: string;
  deliveryFee?: number;
  deliveryDistance?: number;
  customerName?: string;
  customerEmail?: string;
  paymentMethod?: "card" | "cash";
  billingPreference?: "final_consumer" | "invoice";
  billingName?: string;
  billingDocNumber?: string;
  notes?: string;
  /** Mensajes seguidos que el bot no entendió. A partir de 2 se deriva a una persona. */
  misunderstood?: number;
  reorderOffered?: boolean;
  reuseLocationOffered?: boolean;
  lastOrderNumber?: string;
  lastPaymentLink?: string;
  /** Última intención enviada a BuilderBot; se reusa si BuilderBot reintenta el mismo mensaje. */
  lastIntent?: Intent;
}

export interface Quote {
  lines: Array<{ name: string; quantity: number; unitPrice: number }>;
  subtotal: number;
  promoLabel?: string;
  promoAmount: number;
  deliveryFee: number;
  total: number;
}

export type LocationQuote =
  | { covered: true; branchId: string; branchName: string; deliveryFee: number; distance: number }
  | { covered: false; reason: string };

export interface BotDeps {
  search(query: string, branchId?: string): Promise<SearchResult>;
  catalog(branchId?: string): Promise<CatalogProduct[]>;
  lastOrder(phone: string): Promise<LastOrder | null>;
  resolveMapsUrl(url: string): Promise<{ lat: number; lng: number } | null>;
  quoteLocation(coords: { lat: number; lng: number }, paymentMethod?: "card" | "cash"): Promise<LocationQuote>;
  pickupBranches(): Promise<BranchOption[]>;
  branchStatus(branchId: string): Promise<{ open: boolean; message?: string }>;
  quote(state: BotState): Promise<Quote | null>;
  createOrder(state: BotState): Promise<{ ok: true; orderNumber: string; total: number; paymentLink?: string } | { ok: false; message: string }>;
  trackOrder(phone: string, message: string): Promise<string>;
  extract: Extractor;
  menuUrl: string;
  supportPhone: string;
}

export interface TurnInput {
  message: string;
  senderName?: string;
  location?: { lat: number; lng: number } | null;
}

export type Route = "conversation" | "catalog" | "choice" | "location" | "checkout" | "tracking" | "human";

/**
 * Intención en una sola palabra, para que BuilderBot enrute con sus Rules.
 * `dudas` = este bot no puede resolverlo: hay que derivar al número de soporte.
 */
export type Intent = "conversar" | "menu" | "dudas" | "consultar_pedido" | "orden_creada";

export interface TurnResult {
  state: BotState;
  reply: string;
  route: Route;
  /** Para las Rules de BuilderBot: conversar | menu | dudas | consultar_pedido | orden_creada. */
  intent: Intent;
  /** Qué espera el bot del próximo mensaje. */
  step: Stage;
  /** Regla que decidió este turno (R1…R11). Sirve para depurar conversaciones reales. */
  decision: string;
  orderNumber?: string;
  paymentLink?: string;
}

export function createInitialState(phone: string): BotState {
  return { phone, stage: "idle", cart: [], pendingChoice: null, choiceQueue: [] };
}

// ─── Formato ──────────────────────────────────────────────────────────────────

export const money = (value: number) => `$${(Math.round(value * 100) / 100).toFixed(2)}`;
const prettyName = (name: string) => titleCase(name);
const cartLine = (item: CartItem) => `${item.quantity} x ${prettyName(item.name)}`;

function optionsList(options: Array<{ name: string; price?: number; address?: string }>) {
  return options
    .map((option, index) => `${index + 1}. ${prettyName(option.name)}${option.price != null ? ` ${money(option.price)}` : ""}${option.address ? ` · ${option.address}` : ""}`)
    .join("\n");
}

function describeLastOrder(order: LastOrder) {
  return order.items.map(cartLine).join("\n");
}

// ─── Reglas ──────────────────────────────────────────────────────────────────

export async function handleTurn(previous: BotState, input: TurnInput, deps: BotDeps): Promise<TurnResult> {
  const state: BotState = { ...previous, cart: [...(previous.cart || [])], choiceQueue: [...(previous.choiceQueue || [])] };
  const message = String(input.message || "").trim();
  const notes: string[] = [];

  if (!state.customerName && input.senderName && !/boloncity/i.test(input.senderName)) {
    state.customerName = titleCase(input.senderName);
  }

  const finish = async (decision: string, route: Route = "conversation", extra: Partial<TurnResult> = {}): Promise<TurnResult> => {
    const next = await nextStep(state, deps);
    const reply = [...notes, next.question].filter(Boolean).join("\n\n");
    const resolvedRoute = next.route || route;
    const intent: Intent = resolvedRoute === "catalog" ? "menu" : "conversar";
    return { state, reply, route: resolvedRoute, intent, step: state.stage, decision, ...extra };
  };

  // Una orden ya creada: si el cliente sigue escribiendo algo que no es consultar, arranca un pedido nuevo.
  // Se conserva quién es (nombre, correo, factura). La entrega se vuelve a preguntar: puede estar en otro
  // lugar; el bot igual ofrece "¿a la misma dirección?" desde su último pedido.
  if (state.stage === "ordered" && message && !wantsTracking(message) && !wantsConfirm(message)) {
    Object.assign(state, {
      stage: "idle",
      cart: [],
      pendingChoice: null,
      choiceQueue: [],
      paymentMethod: undefined,
      lastOrderNumber: undefined,
      lastPaymentLink: undefined,
      notes: undefined,
      reorderOffered: true,
      reuseLocationOffered: false,
      deliveryType: undefined,
      branchId: undefined,
      branchName: undefined,
      deliveryCoordinates: undefined,
      deliveryGoogleMapsUrl: undefined,
      deliveryAddress: undefined,
      deliveryFee: undefined,
      deliveryDistance: undefined,
    });
  }

  // R1 · Ubicación (nativa de WhatsApp o link de Google Maps). Gana sobre todo lo demás.
  const mapsUrl = extractMapsUrl(message);
  if (input.location || mapsUrl) {
    const coords = input.location || (mapsUrl ? await deps.resolveMapsUrl(mapsUrl) : null);
    if (!coords) {
      notes.push("No pude leer esa ubicación. Compárteme tu ubicación desde el clip 📎 de WhatsApp o un enlace de Google Maps");
      return finish("R1:ubicacion_invalida", "location");
    }
    await applyLocation(state, coords, mapsUrl || `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`, deps, notes);
    return finish("R1:ubicacion", "location");
  }

  if (!message) return finish("R0:mensaje_vacio");

  // R2 · Quiere una persona o tiene un reclamo.
  if (wantsHuman(message)) {
    return {
      state,
      reply: `Este número lo atiende un asistente automático para pedidos. Para que una persona revise tu caso escribe al ${deps.supportPhone} y te ayudan enseguida`,
      route: "human",
      intent: "dudas",
      step: state.stage,
      decision: "R2:humano",
    };
  }

  // R3 · Consulta de un pedido ya hecho.
  if (wantsTracking(message) && !(state.stage === "confirm" && wantsCart(message))) {
    return { state, reply: await deps.trackOrder(state.phone, message), route: "tracking", intent: "consultar_pedido", step: state.stage, decision: "R3:consultar_pedido" };
  }

  // R4 · Respuesta a una elección pendiente (opciones de producto, repetir pedido, sucursal, misma dirección).
  if (state.pendingChoice) {
    const resolved = await resolvePendingChoice(state, message, deps, notes);
    if (resolved) {
      await processChoiceQueue(state, deps, notes);
      return finish(`R4:eleccion_${resolved}`);
    }
  }

  // R5 · "Lo mismo de la última vez".
  if (wantsReorder(message) && !state.pendingChoice) {
    const order = await deps.lastOrder(state.phone);
    state.reorderOffered = true;
    if (!order) {
      notes.push("No encuentro pedidos anteriores con este número");
      return finish("R5:repetir_sin_historial");
    }
    state.pendingChoice = { kind: "reorder", order };
    return finish("R5:repetir_pedido", "choice");
  }

  // R6 · Vaciar el carrito / empezar de nuevo.
  if (wantsClearCart(message)) {
    Object.assign(state, { cart: [], pendingChoice: null, choiceQueue: [], stage: "idle" });
    notes.push("Listo, borré tu pedido");
    return finish("R6:vaciar_carrito");
  }

  // R7 · Confirmación del pedido (solo cuenta si el resumen ya se mostró).
  if (wantsConfirm(message) || (state.stage === "confirm" && isYes(message))) {
    if (state.stage === "ordered" && state.lastOrderNumber) {
      notes.push(`Tu pedido ${state.lastOrderNumber} ya está registrado${state.lastPaymentLink ? `\nPuedes pagarlo aquí: ${state.lastPaymentLink}` : ""}`);
      return { state, reply: notes.join("\n\n"), route: "checkout", intent: "orden_creada", step: state.stage, decision: "R7:ya_confirmado", orderNumber: state.lastOrderNumber, paymentLink: state.lastPaymentLink };
    }
    if (state.stage === "confirm") return confirmOrder(state, deps);
    // Dijo "confirmo" antes de tiempo: se le pide lo que falta.
    return finish("R7:confirmo_incompleto");
  }

  // R8 · Ver el carrito.
  if (wantsCart(message) && state.cart.length) {
    notes.push(`Llevas:\n${state.cart.map(cartLine).join("\n")}`);
    return finish("R8:ver_carrito");
  }

  // R9 · Menú / qué tienen.
  if (wantsMenu(message)) {
    await showMenu(state, message, deps, notes);
    return finish("R9:menu", "catalog");
  }

  // R10 · Respuesta corta y directa a la pregunta del paso actual ("1", "efectivo", "Ana Pérez", la cédula).
  if (await applyDirectAnswer(state, message, deps)) return finish("R10:respuesta_al_paso");

  // R10 · Todo lo demás: se extraen datos del mensaje (IA con respaldo de reglas) y se aplican.
  const lastBotQuestion = stageQuestionHint(state);
  const extraction = await deps.extract(message, { lastBotQuestion, cartNames: state.cart.map((item) => item.name) });
  // Mientras se espera la dirección, un texto como "casa verde, junto al parque" NO debe buscarse como producto:
  // solo se agregan productos que coincidan exacto.
  const strict = state.stage === "address";
  let answered = await applyExtraction(state, message, extraction, deps, notes, strict);
  if (!answered && state.stage === "address" && message.length >= 5) {
    state.deliveryAddress = message.slice(0, 200);
    answered = true;
  }
  if (!answered && state.stage === "invoice_doc") {
    notes.push("La cédula debe tener 10 dígitos o el RUC 13");
    answered = true;
  }

  if (!answered && state.pendingChoice) {
    // No eligió ni pidió nada nuevo: se repite la pregunta pendiente.
    return finish("R4:eleccion_repetida", "choice");
  }
  if (!answered) {
    // Con el local cerrado no hay nada que entender: se repite solo el aviso de horario.
    notes.push(state.cart.length && state.stage !== "closed" ? "No te entendí bien" : "");
    state.misunderstood = (state.misunderstood || 0) + 1;
    // Dos mensajes seguidos sin entender: no es un pedido, es una duda. Se deriva a una persona.
    if (state.misunderstood >= 2 && state.stage !== "closed") {
      return {
        state,
        reply: `Creo que necesitas ayuda de una persona. Escríbenos al ${deps.supportPhone} y te atienden enseguida\n\nSi quieres hacer un pedido, dime qué se te antoja y seguimos por aquí`,
        route: "human",
        intent: "dudas",
        step: state.stage,
        decision: "R11:derivado_a_persona",
      };
    }
    return finish("R11:no_entendido");
  }
  state.misunderstood = 0;
  return finish(`R10:${extraction.source}`);
}

/** Pista para la IA de qué respondería el cliente según el paso actual. */
function stageQuestionHint(state: BotState) {
  const hints: Partial<Record<Stage, string>> = {
    delivery_type: "¿Es para delivery o retiras en el local?",
    location: "Compárteme tu ubicación",
    address: "¿Cuál es la dirección o referencia de entrega?",
    name: "¿A nombre de quién va el pedido?",
    email: "¿Cuál es tu correo?",
    payment: "¿Pagas con tarjeta o en efectivo?",
    invoice_doc: "¿Cuál es tu cédula o RUC para la factura?",
    invoice_name: "¿A nombre de quién va la factura?",
    confirm: "Escribe confirmo para enviar el pedido",
  };
  return hints[state.stage] || "¿Qué te gustaría pedir?";
}

// ─── Aplicar cambios ─────────────────────────────────────────────────────────

async function addSearchedItem(state: BotState, query: string, quantity: number, deps: BotDeps, notes: string[], strict = false) {
  // "hola", "ok", "gracias": sin palabras con significado no se busca ni se responde "no tenemos".
  const tokens = meaningfulTokens(query);
  if (!tokens.some((token) => token.length >= 4)) return false;
  const result = await deps.search(query, state.branchId);
  if (strict && result.kind !== "exact") return false;
  if (result.kind === "exact") {
    state.cart = addToCart(state.cart, { productId: result.product.productId, name: result.product.name, quantity });
    notes.push(`Agregué ${quantity} x ${prettyName(result.product.name)} ${money(result.product.price * quantity)}`);
    return true;
  }
  if (result.kind === "ambiguous") {
    state.pendingChoice = { kind: "product", query, quantity, options: result.options.map(toOption) };
    return true;
  }
  if (result.suggestions.length) {
    notes.push(`No encontré "${query}" tal cual`);
    state.pendingChoice = { kind: "product", query, quantity, options: result.suggestions.map(toOption) };
    return true;
  }
  notes.push(`No tenemos "${query}" en el menú`);
  return false;
}

const toOption = (product: CatalogProduct): ProductOption => ({ productId: product.productId, name: product.name, price: product.price });

async function processChoiceQueue(state: BotState, deps: BotDeps, notes: string[]) {
  while (!state.pendingChoice && state.choiceQueue.length) {
    const next = state.choiceQueue.shift()!;
    await addSearchedItem(state, next.query, next.quantity, deps, notes);
  }
}

async function applyExtraction(state: BotState, message: string, extraction: Extraction, deps: BotDeps, notes: string[], strict = false) {
  let changed = false;

  // Transferencia: no se acepta, se ofrece tarjeta o efectivo.
  if (extraction.paymentMethod === "transfer") {
    notes.push("Por WhatsApp no recibimos transferencias. Puedes pagar con tarjeta (te envío un link) o en efectivo");
    state.paymentMethod = undefined;
    changed = true;
  } else if (extraction.paymentMethod) {
    state.paymentMethod = extraction.paymentMethod;
    changed = true;
  }

  if (extraction.deliveryType && extraction.deliveryType !== state.deliveryType) {
    setDeliveryType(state, extraction.deliveryType);
    changed = true;
  }

  if (extraction.customerName) {
    state.customerName = titleCase(extraction.customerName);
    changed = true;
  }
  if (extraction.customerEmail) {
    state.customerEmail = extraction.customerEmail;
    changed = true;
  }
  if (extraction.wantsInvoice === true) {
    state.billingPreference = "invoice";
    changed = true;
  } else if (extraction.wantsInvoice === false) {
    state.billingPreference = "final_consumer";
    changed = true;
  }
  if (state.billingPreference === "invoice" && extraction.billingDocNumber) {
    state.billingDocNumber = extraction.billingDocNumber;
    changed = true;
  }
  if (extraction.billingName && state.billingPreference === "invoice") {
    state.billingName = titleCase(extraction.billingName);
    changed = true;
  }
  if (extraction.notes) {
    state.notes = [state.notes, extraction.notes].filter(Boolean).join(". ");
    changed = true;
  }

  for (const query of extraction.remove) {
    const item = findInCart(state.cart, query);
    if (item) {
      state.cart = removeFromCart(state.cart, item.productId);
      notes.push(`Quité ${prettyName(item.name)}`);
    } else {
      notes.push(`No encontré "${query}" en tu pedido`);
    }
    changed = true;
  }

  for (const change of extraction.setQuantity) {
    const item = findInCart(state.cart, change.query);
    if (item) {
      state.cart = setCartQuantity(state.cart, item.productId, change.quantity);
      notes.push(change.quantity > 0 ? `Ahora son ${change.quantity} x ${prettyName(item.name)}` : `Quité ${prettyName(item.name)}`);
      changed = true;
    } else {
      // No estaba en el carrito: se trata como producto nuevo.
      extraction.items.push({ query: change.query, quantity: change.quantity || 1 });
    }
  }

  // Productos: el primero ambiguo abre una elección y los demás esperan en cola.
  for (const item of extraction.items) {
    if (state.pendingChoice) {
      state.choiceQueue.push(item);
      changed = true;
      continue;
    }
    if (await addSearchedItem(state, item.query, item.quantity, deps, notes, strict)) changed = true;
  }

  // Si el cliente cambió algo que afecta el precio del delivery, se recotiza.
  if (changed && state.deliveryType === "delivery" && state.deliveryCoordinates && extraction.paymentMethod && extraction.paymentMethod !== "transfer") {
    await applyLocation(state, state.deliveryCoordinates, state.deliveryGoogleMapsUrl || "", deps, [], { silent: true });
  }

  return changed;
}

/**
 * Mensaje corto que responde exactamente lo que el bot preguntó. Solo mensajes cortos:
 * "2 humitas para llevar" en el paso de entrega trae productos y va por la extracción completa.
 */
async function applyDirectAnswer(state: BotState, message: string, deps: BotDeps) {
  const text = normalizeText(message);
  const short = text.split(" ").length <= 4;
  switch (state.stage) {
    case "delivery_type": {
      const type = text === "1" ? "delivery" : text === "2" ? "pickup" : short ? detectDeliveryType(message) : null;
      if (!type) return false;
      setDeliveryType(state, type);
      return true;
    }
    case "payment": {
      const method = text === "1" ? "card" : text === "2" ? "cash" : short ? detectPaymentMethod(message) : null;
      if (method !== "card" && method !== "cash") return false;
      state.paymentMethod = method;
      return true;
    }
    case "name": {
      // "Ana Pérez" es un nombre; "humita" también parece uno, por eso se descarta si es un producto.
      if (!looksLikeBareName(message) || (await deps.search(message, state.branchId)).kind === "exact") return false;
      state.customerName = titleCase(message);
      return true;
    }
    case "invoice_doc": {
      const doc = extractDocNumber(message);
      if (!doc) return false;
      state.billingDocNumber = doc;
      return true;
    }
    case "invoice_name":
      if (!looksLikeBareName(message)) return false;
      state.billingName = titleCase(message);
      return true;
    default:
      return false;
  }
}

function setDeliveryType(state: BotState, type: "delivery" | "pickup") {
  state.deliveryType = type;
  // Cambiar de modalidad invalida lo calculado para la otra.
  if (type === "pickup") {
    Object.assign(state, { deliveryCoordinates: undefined, deliveryGoogleMapsUrl: undefined, deliveryFee: undefined, deliveryDistance: undefined, branchId: undefined, branchName: undefined });
  } else {
    Object.assign(state, { branchId: state.deliveryCoordinates ? state.branchId : undefined, branchName: state.deliveryCoordinates ? state.branchName : undefined });
  }
}

async function applyLocation(
  state: BotState,
  coords: { lat: number; lng: number },
  mapsUrl: string,
  deps: BotDeps,
  notes: string[],
  { silent = false }: { silent?: boolean } = {}
) {
  const quote = await deps.quoteLocation(coords, state.paymentMethod);
  if (!quote.covered) {
    Object.assign(state, { deliveryCoordinates: undefined, deliveryGoogleMapsUrl: undefined, deliveryFee: undefined, branchId: undefined, branchName: undefined });
    if (state.deliveryType === "delivery") state.deliveryType = undefined;
    notes.push(`${quote.reason}\nSi quieres, puedes retirarlo en el local`);
    return false;
  }
  const branchChanged = state.branchId !== quote.branchId;
  Object.assign(state, {
    deliveryType: "delivery",
    deliveryCoordinates: coords,
    deliveryGoogleMapsUrl: mapsUrl,
    deliveryFee: quote.deliveryFee,
    deliveryDistance: quote.distance,
    branchId: quote.branchId,
    branchName: quote.branchName,
  });
  if (!silent) notes.push(`Perfecto, te atiende la sucursal ${quote.branchName}. El delivery cuesta ${money(quote.deliveryFee)}`);
  if (branchChanged) await revalidateCartForBranch(state, deps, notes);
  return true;
}

/** Al fijar sucursal, se quitan del carrito los productos que ahí no se venden. */
async function revalidateCartForBranch(state: BotState, deps: BotDeps, notes: string[]) {
  if (!state.branchId || !state.cart.length) return;
  const available = new Set((await deps.catalog(state.branchId)).map((product) => product.productId));
  const missing = state.cart.filter((item) => !available.has(item.productId));
  if (!missing.length) return;
  state.cart = state.cart.filter((item) => available.has(item.productId));
  notes.push(`En ${state.branchName} no hay disponible: ${missing.map((item) => prettyName(item.name)).join(", ")}. Lo quité de tu pedido`);
}

async function resolvePendingChoice(state: BotState, message: string, deps: BotDeps, notes: string[]): Promise<string | null> {
  const choice = state.pendingChoice!;
  switch (choice.kind) {
    case "product": {
      if (isNo(message) || /\b(ninguno|ninguna|ninguno de esos|otro)\b/.test(normalizeText(message))) {
        state.pendingChoice = null;
        notes.push("Dale, no lo agrego");
        return "producto_descartado";
      }
      const picked = pickOption(message, choice.options);
      if (!picked) return null;
      state.pendingChoice = null;
      state.cart = addToCart(state.cart, { productId: picked.productId, name: picked.name, quantity: choice.quantity });
      notes.push(`Agregué ${choice.quantity} x ${prettyName(picked.name)} ${money(picked.price * choice.quantity)}`);
      return "producto";
    }
    case "reorder": {
      if (isNo(message)) {
        state.pendingChoice = null;
        return "repetir_no";
      }
      if (!isYes(message) && !wantsReorder(message)) return null;
      state.pendingChoice = null;
      const available = new Map((await deps.catalog(state.branchId)).map((product) => [product.productId, product]));
      const missing: string[] = [];
      for (const item of choice.order.items) {
        const product = available.get(item.productId);
        if (product) state.cart = addToCart(state.cart, { productId: product.productId, name: product.name, quantity: item.quantity });
        else missing.push(prettyName(item.name));
      }
      state.customerName = state.customerName || choice.order.customerName;
      state.customerEmail = state.customerEmail || choice.order.customerEmail;
      notes.push(
        `Listo, agregué tu pedido anterior:\n${state.cart.map(cartLine).join("\n")}${missing.length ? `\n\nYa no está disponible: ${missing.join(", ")}` : ""}`
      );
      return "repetir_si";
    }
    case "reuse_location": {
      if (isNo(message)) {
        state.pendingChoice = null;
        return "misma_direccion_no";
      }
      if (!isYes(message)) return null;
      state.pendingChoice = null;
      state.deliveryAddress = choice.address;
      await applyLocation(state, choice.coords, choice.mapsUrl, deps, notes);
      return "misma_direccion_si";
    }
    case "branch": {
      const picked = pickOption(message, choice.options);
      if (!picked) return null;
      state.pendingChoice = null;
      state.branchId = picked.branchId;
      state.branchName = picked.name;
      notes.push(`Perfecto, lo retiras en ${picked.name}`);
      await revalidateCartForBranch(state, deps, notes);
      return "sucursal";
    }
  }
}

async function showMenu(state: BotState, message: string, deps: BotDeps, notes: string[]) {
  const products = await deps.catalog(state.branchId);
  const categories = listCategories(products);
  // "¿qué bebidas tienen?" → productos de esa categoría como opciones elegibles.
  const tokens = meaningfulTokens(message).filter((token) => !["menu", "carta", "catalogo", "producto", "opcion", "recomienda", "recomiendas", "recomendacion"].includes(token));
  const category = tokens.length
    ? categories.find((entry) => meaningfulTokens(entry.name).some((name) => tokens.some((token) => tokenSimilarity(token, name) >= 0.85)))
    : undefined;
  if (category) {
    const options = products.filter((product) => product.categoryNames.includes(category.name)).slice(0, 10).map(toOption);
    state.pendingChoice = { kind: "product", query: category.name, quantity: 1, options };
    return;
  }
  notes.push(
    `Estas son nuestras categorías:\n${categories.map((entry) => `• ${titleCase(entry.name)}`).join("\n")}\n\nDime qué se te antoja (ej. "2 bolones mixtos y un café") o mira el menú con fotos: ${deps.menuUrl}`
  );
}

// ─── Siguiente paso ──────────────────────────────────────────────────────────

/**
 * Lo primero que falta para cerrar el pedido, SIEMPRE en este orden:
 * elección pendiente → productos → delivery o retiro → ubicación/sucursal → dirección →
 * sucursal abierta → nombre → correo → pago → factura (si la pidió) → resumen.
 */
export async function nextStep(state: BotState, deps: BotDeps): Promise<{ question: string; route?: Route }> {
  const choice = state.pendingChoice;
  if (choice) {
    state.stage = "choosing";
    if (choice.kind === "product") {
      return { question: `¿Cuál ${choice.query} quieres?\n${optionsList(choice.options)}\n\nResponde con el número`, route: "choice" };
    }
    if (choice.kind === "reorder") {
      return {
        question: `Tu último pedido (${choice.order.orderNumber}) fue:\n${describeLastOrder(choice.order)}\n\n¿Quieres repetirlo? Responde *sí* o dime qué te gustaría pedir`,
        route: "choice",
      };
    }
    if (choice.kind === "reuse_location") {
      return { question: `¿Te lo enviamos a la misma dirección de la vez pasada?\n${choice.address}\n\nResponde *sí* o compárteme otra ubicación`, route: "choice" };
    }
    return { question: `¿En qué local lo retiras?\n${optionsList(choice.options)}\n\nResponde con el número`, route: "choice" };
  }

  if (state.stage === "ordered") return { question: "" };

  if (!state.cart.length) {
    if (!state.reorderOffered) {
      state.reorderOffered = true;
      const order = await deps.lastOrder(state.phone);
      if (order?.items.length) {
        state.customerName = state.customerName || order.customerName;
        state.customerEmail = state.customerEmail || order.customerEmail;
        state.pendingChoice = { kind: "reorder", order };
        const greeting = state.customerName ? `Hola ${state.customerName.split(" ")[0]} 👋` : "Hola 👋";
        return { question: `${greeting}\n${(await nextStep(state, deps)).question}`, route: "choice" };
      }
    }
    state.stage = "idle";
    return { question: `¿Qué te gustaría pedir hoy? Puedes escribirme algo como "2 bolones mixtos de verde y un café" o pedirme el *menú*` };
  }

  if (!state.deliveryType) {
    state.stage = "delivery_type";
    return { question: "¿Es para *delivery* a domicilio o lo *retiras en el local*?\n1. Delivery\n2. Retiro en local" };
  }

  if (state.deliveryType === "delivery" && !state.deliveryCoordinates) {
    if (!state.reuseLocationOffered) {
      state.reuseLocationOffered = true;
      const order = await deps.lastOrder(state.phone);
      if (order?.deliveryType === "delivery" && order.deliveryCoordinates?.lat && order.deliveryAddress) {
        state.pendingChoice = { kind: "reuse_location", address: order.deliveryAddress, coords: order.deliveryCoordinates, mapsUrl: order.deliveryGoogleMapsUrl || "" };
        return nextStep(state, deps);
      }
    }
    state.stage = "location";
    return { question: "Compárteme tu ubicación desde el clip 📎 de WhatsApp (Ubicación → Enviar mi ubicación actual) o un enlace de Google Maps", route: "location" };
  }

  if (state.deliveryType === "pickup" && !state.branchId) {
    const branches = await deps.pickupBranches();
    if (!branches.length) {
      state.stage = "branch";
      return { question: "En este momento no tenemos locales disponibles para retiro" };
    }
    state.pendingChoice = { kind: "branch", options: branches };
    return nextStep(state, deps);
  }

  // Apenas se sabe qué local atiende se revisa el horario: no se le piden más datos a alguien que no va a poder pedir.
  if (state.branchId) {
    const status = await deps.branchStatus(state.branchId);
    if (!status.open) {
      state.stage = "closed";
      return { question: status.message || `${state.branchName || "La sucursal"} está cerrada en este momento` };
    }
  }

  if (state.deliveryType === "delivery" && !state.deliveryAddress) {
    state.stage = "address";
    return { question: "Escríbeme la dirección con una referencia (calle, número de casa, edificio o piso) para el motorizado" };
  }

  if (!state.customerName) {
    state.stage = "name";
    return { question: "¿A nombre de quién va el pedido?" };
  }

  if (!state.customerEmail) {
    state.stage = "email";
    return { question: "¿Cuál es tu correo? Ahí te llega la confirmación del pedido" };
  }

  if (!state.paymentMethod) {
    state.stage = "payment";
    const cashLabel = state.deliveryType === "pickup" ? "Efectivo al retirar" : "Efectivo al motorizado";
    return { question: `¿Cómo quieres pagar?\n1. Tarjeta (te envío un link de pago)\n2. ${cashLabel}` };
  }

  if (state.billingPreference === "invoice" && !state.billingDocNumber) {
    state.stage = "invoice_doc";
    return { question: "Para la factura, ¿cuál es tu cédula (10 dígitos) o RUC (13 dígitos)?" };
  }
  if (state.billingPreference === "invoice" && !state.billingName) {
    state.stage = "invoice_name";
    return { question: "¿A nombre de quién va la factura?" };
  }

  const quote = await deps.quote(state);
  if (!quote) {
    state.stage = "idle";
    return { question: "No pude calcular tu pedido. ¿Me repites qué te gustaría pedir?" };
  }
  state.stage = "confirm";
  return { question: formatSummary(state, quote), route: "checkout" };
}

export function formatSummary(state: BotState, quote: Quote) {
  const lines = quote.lines.map((line) => `${line.quantity} x ${prettyName(line.name)} ${money(line.unitPrice * line.quantity)}`).join("\n");
  const delivery =
    state.deliveryType === "delivery"
      ? `Delivery a: ${state.deliveryAddress}${state.branchName ? ` (sucursal ${state.branchName})` : ""}`
      : `Retiro en: ${state.branchName}`;
  const payment =
    state.paymentMethod === "card"
      ? "Pago: tarjeta (te envío el link al confirmar)"
      : state.deliveryType === "delivery"
      ? "Pago: efectivo al motorizado"
      : "Pago: efectivo al retirar";
  // Aviso de efectivo en delivery pedido por el negocio.
  const cashWarning =
    state.paymentMethod === "cash" && state.deliveryType === "delivery"
      ? `\n\n⚠️ Si no estás cuando llegue el motorizado, el costo del envío (${money(quote.deliveryFee)}) se sumará a tu próxima compra`
      : "";
  // Bloques separados por una línea en blanco; dentro de cada bloque se omiten las líneas que no aplican.
  const block = (...rows: Array<string | false | undefined>) => rows.filter(Boolean).join("\n");
  return [
    block("*Resumen de tu pedido*", lines),
    block(
      `Subtotal ${money(quote.subtotal)}`,
      quote.promoAmount > 0 && `${quote.promoLabel || "Promoción"}: -${money(quote.promoAmount)}`,
      state.deliveryType === "delivery" && `Delivery ${money(quote.deliveryFee)}`,
      `*Total ${money(quote.total)}*`
    ),
    block(
      delivery,
      payment,
      `A nombre de: ${state.customerName} · ${state.customerEmail}`,
      state.billingPreference === "invoice" && `Factura: ${state.billingName} · ${state.billingDocNumber}`,
      state.notes && `Indicaciones: ${state.notes}`
    ),
    cashWarning.trim(),
    "Escribe *confirmo* para enviar tu pedido o dime qué quieres cambiar",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function confirmOrder(state: BotState, deps: BotDeps): Promise<TurnResult> {
  // Antes de crear se revisa todo otra vez: entre el resumen y el "confirmo" pudo cerrar la sucursal.
  const check = await nextStep(state, deps);
  if (state.stage !== "confirm") {
    return { state, reply: check.question, route: check.route || "conversation", intent: "conversar", step: state.stage, decision: "R7:confirmo_revalidacion" };
  }
  const result = await deps.createOrder(state);
  if (!result.ok) {
    return { state, reply: `${result.message}\n\n${check.question}`, route: "checkout", intent: "conversar", step: state.stage, decision: "R7:error_creando" };
  }
  state.stage = "ordered";
  state.lastOrderNumber = result.orderNumber;
  state.lastPaymentLink = result.paymentLink;
  const reply =
    state.paymentMethod === "card"
      ? `✅ Pedido ${result.orderNumber} creado por ${money(result.total)}\n\nPágalo aquí para que la cocina lo empiece:\n${result.paymentLink}`
      : state.deliveryType === "delivery"
      ? `✅ Pedido ${result.orderNumber} confirmado por ${money(result.total)}\n\nYa lo estamos preparando. Ten el efectivo listo para el motorizado`
      : `✅ Pedido ${result.orderNumber} confirmado por ${money(result.total)}\n\nTe esperamos en ${state.branchName}. Pagas en efectivo al retirar`;
  return { state, reply, route: "checkout", intent: "orden_creada", step: "ordered", decision: "R7:orden_creada", orderNumber: result.orderNumber, paymentLink: result.paymentLink };
}
