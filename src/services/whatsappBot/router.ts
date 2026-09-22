import { addToCart, CartItem, findInCart, MAX_QUANTITY, removeFromCart, setCartQuantity } from "./cart";
import { CatalogProduct, displayCategoryName, findCategory, listCategories, normalizeText, SearchResult, tokenSimilarity, meaningfulTokens } from "./catalog";
import { asksForNearest, distinctiveLabel, negatedPhrase, pickChoice } from "./choice";
import { Extraction, Extractor } from "./extractor";
import {
  detectDeliveryType,
  detectPaymentMethod,
  extractDeclaredName,
  extractDocNumber,
  extractMapsUrl,
  extractOrderNumber,
  hasDocLikeNumber,
  isNo,
  parseRemovalUnits,
  classifyConfirmReply,
  isGreeting,
  isNotAName,
  isQuestion,
  isSmallTalk,
  isYes,
  looksLikeBareName,
  titleCase,
  titleCaseName,
  wantsCart,
  wantsClearCart,
  wantsToWait,
  wantsConfirm,
  wantsHuman,
  wantsMenu,
  wantsPaymentLink,
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
  | {
      kind: "product";
      query: string;
      quantity: number;
      options: ProductOption[];
      /** Categoría mostrada ("Bebidas"), para preguntar natural. */
      label?: string;
      /** El cliente habló de algo que varias opciones comparten: se repregunta con lo que las diferencia. */
      clarify?: boolean;
    }
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
  /** Dirección borrada con "la dirección está mal" / "otra dirección": "la misma" en el paso de dirección la recupera. */
  previousDeliveryAddress?: string;
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
  /** Ubicación compartida antes de cambiar a retiro: si vuelve a delivery se reusa y se recotiza. */
  savedDeliveryLocation?: { coords: { lat: number; lng: number }; mapsUrl: string };
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
  /**
   * Desempate con IA cuando las reglas no alcanzan. SIEMPRE elige entre las opciones dadas
   * (devuelve el índice 1..N o null): nunca inventa productos ni precios. Es opcional: sin
   * ella —o si falla— las reglas resuelven los casos comunes.
   */
  chooseOption?(input: { message: string; question: string; options: Array<{ name: string; price?: number }> }): Promise<number | null>;
  menuUrl: string;
  supportPhone: string;
}

export interface TurnInput {
  message: string;
  senderName?: string;
  location?: { lat: number; lng: number } | null;
  /** Llegó un evento de ubicación (flow "envian ubicacion nativa") pero sin coordenadas legibles. */
  locationInvalid?: boolean;
  /** Llegó un audio, imagen o documento (BuilderBot manda "_event_media__…" / "_event_voice_note__…"). */
  unsupportedMedia?: boolean;
}

/**
 * `checkout` SOLO cuando la orden existe (se creó en este turno o ya estaba creada): una Rule route=checkout de
 * BuilderBot nunca debe crear una orden con un "gracias". El resumen que espera "confirmo" sale como `summary`.
 */
export type Route = "conversation" | "catalog" | "choice" | "location" | "summary" | "checkout" | "tracking" | "human";

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

/** Rutas que usan las Rules del flow "Bienvenida" de BuilderBot para saltar a cada flow. */
export type BuilderBotRoute = "conversation" | "catalog" | "checkout" | "search_order" | "human";

/**
 * Traduce la ruta interna a las ÚNICAS 5 que puede ver BuilderBot. Las internas ("choice", "summary",
 * "location", "tracking") son para los logs: si salieran, una Rule por `route` mandaría al cliente a un
 * flow que no existe (pasó con "choice" el 2026-09-22). Todo lo que sigue siendo conversación es
 * "conversation", y el que conversa es el mismo endpoint de siempre.
 */
export function publicRoute(route: Route | string): BuilderBotRoute {
  if (route === "catalog" || route === "checkout" || route === "human") return route;
  if (route === "tracking" || route === "search_order") return "search_order";
  return "conversation";
}

/**
 * Enrutador del flow "Bienvenida" (mismo esquema que Sorbito): SOLO decide a qué flow
 * va el mensaje. No cambia la conversación ni llama a la IA, así responde en milisegundos
 * y el flow de destino recibe el mensaje intacto.
 *
 * Usa las mismas reglas que handleTurn para que el destino nunca contradiga al router:
 *   persona/reclamo → human · consultar pedido → search_order · menú → catalog
 *   "confirmo" con el resumen ya mostrado → checkout · todo lo demás → conversation
 */
export function classifyRoute(state: BotState | null, message: string, hasLocation = false): BuilderBotRoute {
  const text = String(message || "").trim();
  if (hasLocation || extractMapsUrl(text) || !text) return "conversation";
  if (wantsHuman(text)) return "human";
  const stage = state?.stage;
  // "¿cuánto se demora?" mientras se pide la dirección habla del delivery que está armando, no de un pedido viejo.
  if (state && isAddressQuestion(state, text)) return "conversation";
  if (wantsTracking(text) && !isConfirmStageReply(stage, text) && !(state && isPendingOrderQuestion(state, text))) return "search_order";
  // Si el bot espera una elección ("1", "maduro", "sí"), la respuesta es parte del pedido.
  if (state?.pendingChoice) return "conversation";
  // "Confirmo" solo es checkout con el resumen ya mostrado. Antes de eso ("quiero pagar con tarjeta")
  // es un dato del pedido y lo resuelve la conversación.
  // "sí, pero agrégale un café" NO es checkout: trae un cambio que debe aplicar la conversación.
  // "gracias" / "ya" tampoco: la conversación vuelve a mostrar el resumen. Misma función que R7 (classifyConfirmReply).
  if ((stage === "confirm" && classifyConfirmReply(text) === "confirm") || (stage === "ordered" && confirmsPlacedOrder(text))) return "checkout";
  if (wantsMenu(text)) return "catalog";
  return "conversation";
}

/**
 * En el resumen, "confirmo mi pedido", "ver el resumen" o "gracias" hablan de ESTE pedido: no son una consulta
 * de un pedido anterior aunque digan "mi pedido". Lo usan classifyRoute y R3.
 */
function isConfirmStageReply(stage: Stage | undefined, message: string) {
  // "cancela mi pedido" / "ya no quiero mi pedido" en el resumen vacían ESTE pedido (R6), no consultan uno anterior
  // (antes ganaba isPendingOrderQuestion: "Apenas lo confirmes…").
  return stage === "confirm" && (wantsCart(message) || wantsClearCart(message) || classifyConfirmReply(message) !== "other");
}

/**
 * En el resumen (pedido armado pero SIN confirmar), "¿cuánto se demora?", "¿a qué hora llega?", "¿dónde está mi
 * pedido?" o "¿ya lo enviaron?" hablan de ESTE pedido: todavía no existe una orden que rastrear. Se responde que
 * falta confirmar y se reimprime el resumen (antes iba a R3: "No encuentro pedidos" + número de soporte).
 * Con un número de orden explícito ("ORD-00012", "pedido 12") sí es una consulta de un pedido anterior (R3).
 */
function isPendingOrderQuestion(state: BotState, message: string) {
  if (state.stage !== "confirm" || state.pendingChoice || extractOrderNumber(message)) return false;
  const text = normalizeText(message);
  if (/\b(agrega\w*|anade\w*|quita\w*|saca\w*|cambia\w*|pon|ponle|ponme)\b/.test(text)) return false;
  return (
    wantsTracking(message) ||
    /\b(demora|demoran|demorara|tarda|tardan|tardara|cuanto tiempo|a que hora|cuando (llega|llegan|llegara|esta|estara|sale)|esta listo|estara listo|ya (lo |la )?(enviaron|mandaron|salio|sale|viene)|lo (enviaron|mandaron))\b/.test(text)
  );
}

/** Respuesta a isPendingOrderQuestion: no se inventan minutos, se dice que falta confirmar. */
function pendingOrderAnswer(state: BotState) {
  const timing =
    state.deliveryType === "pickup"
      ? `Apenas lo confirmes, ${state.branchName ? `el local ${state.branchName}` : "el local"} se pone a prepararlo. El tiempo depende de cuántos pedidos tengan en cocina`
      : "Apenas lo confirmes, la cocina se pone con él. El tiempo depende de la cocina y del tráfico. Cuando salga, escribe *mi pedido* y te paso el seguimiento";
  return `Ojo, tu pedido todavía no está enviado 🙂 ${timing} 👇`;
}

/**
 * En el resumen de un delivery: "cambia la dirección a calle 8 casa 2", "mi dirección es …", "la dirección está mal,
 * es Urdesa calle 8". Devuelve la dirección nueva o "" (antes decía "No vi ningún cambio" y la dejaba igual).
 */
function addressCorrection(state: BotState, message: string) {
  if (state.deliveryType !== "delivery" || !state.deliveryAddress || state.pendingChoice || isQuestion(message)) return "";
  // "a"/"por" solo cuentan después de un verbo de cambio: "la dirección está bien, cambia el pago a efectivo" no es una dirección.
  const match =
    message.match(/\b(?:cambi\w*|correg\w*|corrig\w*|actualiz\w*|pon\w*)\b.*?direcci[oó]n\b.*?(?:\ba\b|\bpor\b|\bes\b|:)\s*(.+)$/iu) ||
    message.match(/direcci[oó]n\b.*?\b(?:mal|equivocad\w*|incorrect\w*)\b.*?(?:\bes\b|:)\s*(.+)$/iu) ||
    message.match(/direcci[oó]n\b\s*(?:correcta\s*)?(?:es|:)\s*(.+)$/iu);
  const address = (match?.[1] || "").replace(/^[\s,.;:]+|[\s.]+$/g, "").trim();
  return looksLikeAddress(address) ? address.slice(0, 200) : "";
}

/**
 * Una dirección tiene un número o una palabra de dirección ("calle", "mz", "villa", "urdesa"…). "correcta", "la misma",
 * "efectivo" o "mi pedido" no lo son (antes reemplazaban la dirección de entrega).
 */
function looksLikeAddress(text: string) {
  const normalized = normalizeText(text);
  if (normalized.length < 5 || /^(la misma|igual|correcta|bien|esta bien|efectivo|tarjeta|mi pedido)\b/.test(normalized)) return false;
  // "la que te di, pero ponme 2 humitas" / "la de antes y 1 cafe": habla de la dirección anterior o trae un cambio del
  // pedido; el dígito es una cantidad, no un número de casa (antes reemplazaba la dirección y se perdían las humitas).
  if (isAddressReference(normalized) || ORDER_CHANGE_WORDS.test(normalized)) return false;
  return (
    /\d/.test(normalized) ||
    /\b(calle|av|avenida|mz|manzana|villa|solar|urb|urbanizacion|cdla|ciudadela|coop|cooperativa|edificio|edif|piso|dpto|departamento|km|sector|barrio|esquina|entre|frente|diagonal|junto|urdesa|kennedy|alborada|samborondon|ceibos|garzota|sauces|centro)\b/.test(normalized)
  );
}

/** Verbos que cambian el pedido: con ellos el texto no es (solo) una dirección. */
const ORDER_CHANGE_WORDS = /\b(pon|ponme|ponle|ponga|pongan|agreg\w*|anad\w*|aumenta\w*|quita\w*|quitale|saca\w*|dame|quiero|quisiera|tambien)\b/;

/**
 * "la misma", "igual que antes", "la que te di", "la de siempre", "la anterior": se refiere a una dirección ya dada,
 * no es una dirección nueva.
 */
function isAddressReference(text: string) {
  const normalized = normalizeText(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return /^(igual|mismo|misma)\b/.test(normalized) || /\b(la misma|el mismo|lo mismo|misma direccion|igual (que|a|q) (antes|la anterior|la otra|siempre|la de antes)|igual que la (anterior|de antes|otra)|es igual|(la|el) (que|q) (te|le|les|ya te|ya le) (di|dije|pase|mande|envie|escribi|puse)|la (que|q) (ya )?(tienes|tienen|tenias|esta|estaba|puse)|la de (siempre|antes|la vez pasada|la otra vez|arriba|ahorita)|la anterior|la registrada|ya te la di|ya la di|ya te dije)\b/.test(
    normalized,
  );
}

/**
 * En el paso de dirección: "la misma", "no sé", "otra dirección", "igual que antes" no son la dirección de entrega
 * (antes se guardaba cualquier texto de 5 letras y el resumen decía "Delivery a: la misma").
 */
function isNotAnAddress(message: string) {
  const normalized = normalizeText(message).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (isAddressReference(normalized)) return true;
  if (/^(no se|nose|no lo se|no sabria|ni idea|no recuerdo|no me acuerdo|no tengo|ninguna|nada|no|nop|si|ok|okey|dale|listo|claro|espera|un momento)\b/.test(normalized) && !looksLikeAddress(normalized)) return true;
  // "otra dirección", "cambiar la dirección", "la dirección está mal": habla de la dirección sin darla.
  return /\bdireccion\b/.test(normalized) && !looksLikeAddress(normalized.replace(/\bdireccion\b/g, " "));
}

/** "no", "incorrecto", "todo está mal", "hay un error": un rechazo sin decir qué cambiar. */
function isBareRejection(message: string) {
  const text = normalizeText(message).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return (
    /^(?:(?:no+|nop|todo|esta|estan|eso|asi|el|la|pedido|resumen|mal|incorrect[ao]s?|equivocad[ao]s?|hay|un|error|gracias)(?: |$))+$/.test(text) &&
    /\b(no+|nop|mal|incorrect[ao]s?|equivocad[ao]s?|error)\b/.test(text)
  );
}

/** Pregunta hecha en el paso de dirección ("¿cuánto cuesta el envío?"). "¿dónde está MI pedido?" no cuenta: es R3. */
function isAddressQuestion(state: BotState, message: string) {
  return state.stage === "address" && !state.deliveryAddress && isQuestion(message) && !/\b(mi|el|la) (pedido|orden)\b/.test(normalizeText(message));
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
  let message = String(input.message || "").trim();
  const notes: string[] = [];

  // El nombre del perfil de WhatsApp solo se usa si parece un nombre ("Ana Pérez"), no "~", "💕✨" ni "{name}".
  const senderName = cleanSenderName(input.senderName);
  if (!state.customerName && senderName) state.customerName = titleCaseName(senderName);

  // El menú ya cierra con "Dime qué se te antoja": no se repite la pregunta de "¿qué te gustaría pedir?".
  let skipIdleQuestion = false;
  const finish = async (decision: string, route: Route = "conversation", extra: Partial<TurnResult> = {}): Promise<TurnResult> => {
    // Cualquier turno que el bot sí entendió reinicia el contador para derivar a una persona.
    if (!decision.startsWith("R11")) state.misunderstood = 0;
    // "para retirar en Kennedy": si el mensaje nombra un local, se toma directo en vez de listar los 8.
    // Vale aunque quede una elección de producto pendiente ("¿cuál bolón mixto?"): el local ya quedó dicho.
    if (message && state.deliveryType === "pickup" && !state.branchId && state.pendingChoice?.kind !== "reorder" && state.pendingChoice?.kind !== "reuse_location") {
      const options = state.pendingChoice?.kind === "branch" ? state.pendingChoice.options : await deps.pickupBranches();
      // "urdesa no": nombrar un local para DESCARTARLO no lo elige (antes el pedido quedaba para
      // retirar justo en el local que el cliente acababa de rechazar).
      const named = negatedPhrase(message) ? null : matchBranchInMessage(message, options);
      if (named) {
        const pending = state.pendingChoice?.kind === "product" ? state.pendingChoice : null;
        await pickBranch(state, named, deps, notes);
        state.pendingChoice = pending;
      }
    }
    const next = await nextStep(state, deps);
    const question = skipIdleQuestion && state.stage === "idle" ? "" : next.question;
    let reply = [...notes, question].filter(Boolean).join("\n\n");
    if (decision === "R10:saludo" && state.stage === "idle" && !/^hola/i.test(reply)) reply = `¡Hola! 👋 Qué gusto tenerte por Boloncity\n\n${reply}`;
    const resolvedRoute = next.route || route;
    const intent: Intent = resolvedRoute === "catalog" || decision === "R9:menu" ? "menu" : "conversar";
    return { state, reply, route: resolvedRoute, intent, step: state.stage, decision, ...extra };
  };

  // Un audio, imagen o documento: el bot solo lee texto y ubicaciones.
  if (input.unsupportedMedia && !input.location) {
    notes.push("Uy, por ahora solo puedo leer mensajes de texto y ubicaciones 🙏 Escríbeme por aquí lo que necesitas y seguimos");
    return finish("R0:media_no_soportada");
  }

  // Orden ya creada: "gracias", "👍", "el link no me abre" o "mejor en efectivo" hablan de ESA orden.
  // No se reinicia el pedido ni se borra el link (antes el cliente perdía su link de pago).
  if (state.stage === "ordered" && state.lastOrderNumber && message && !wantsTracking(message) && !confirmsPlacedOrder(message) && !wantsHuman(message)) {
    const followUp = orderFollowUp(state, message, deps);
    if (followUp) {
      return {
        state,
        reply: followUp,
        // Sigue siendo conversación: la orden ya existe y no hay nada que cobrar de nuevo.
        route: "conversation",
        intent: "conversar",
        step: state.stage,
        decision: "R7:seguimiento_orden",
        orderNumber: state.lastOrderNumber,
        paymentLink: state.lastPaymentLink,
      };
    }
  }

  // Una orden ya creada: si el cliente sigue escribiendo algo que no es consultar, arranca un pedido nuevo.
  // Se conserva quién es (nombre, correo, factura). La entrega se vuelve a preguntar: puede estar en otro
  // lugar; el bot igual ofrece "¿a la misma dirección?" desde su último pedido.
  // "sí", "claro", "correcto" justo después de la orden (doble envío o reintento de BuilderBot) NO son un pedido
  // nuevo: van a R7:ya_confirmado y se conserva el link (antes borraban la orden de la sesión).
  if (state.stage === "ordered" && message && !wantsTracking(message) && !confirmsPlacedOrder(message) && !wantsHuman(message)) {
    // "sí, y agrégale un café" con la orden ya creada: esa orden no se toca. Se avisa que arranca un pedido nuevo
    // (antes empezaba otro en silencio y el cliente creía que había modificado el suyo).
    if (state.lastOrderNumber) notes.push(`Tu pedido ${state.lastOrderNumber} ya está registrado y no lo puedo modificar 🙏 Te empiezo uno nuevo 👇`);
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
      previousDeliveryAddress: undefined,
      deliveryFee: undefined,
      deliveryDistance: undefined,
      savedDeliveryLocation: undefined,
    });
  }

  // R1 · Ubicación (nativa de WhatsApp o link de Google Maps). Gana sobre todo lo demás.
  const mapsUrl = extractMapsUrl(message);
  if (input.location || mapsUrl || input.locationInvalid) {
    const coords = input.location || (mapsUrl ? await deps.resolveMapsUrl(mapsUrl) : null);
    if (!coords) {
      notes.push("Mmm, no pude leer esa ubicación 🙈 Mándamela desde el clip 📎 de WhatsApp o pásame un enlace de Google Maps");
      return finish("R1:ubicacion_invalida", "location");
    }
    // Una ubicación responde "¿en qué local lo retiras?" o "¿a la misma dirección?": el cliente eligió delivery aquí.
    if (state.pendingChoice?.kind === "branch" || state.pendingChoice?.kind === "reuse_location") state.pendingChoice = null;
    await applyLocation(state, coords, mapsUrl || `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`, deps, notes);
    return finish("R1:ubicacion", "location");
  }

  if (!message) return finish("R0:mensaje_vacio");

  // R2 · Quiere una persona o tiene un reclamo.
  if (wantsHuman(message)) {
    return {
      state,
      reply: `Claro, te paso con una persona del equipo 👋 Escríbele al ${deps.supportPhone} y te ayudan enseguida. Por aquí yo te tomo el pedido cuando quieras`,
      route: "human",
      intent: "dudas",
      step: state.stage,
      decision: "R2:humano",
    };
  }

  // Paso de dirección: una pregunta ("¿cuánto cuesta el envío?", "cuánto se demora") NO es la dirección.
  // Se responde lo que se sabe y se vuelve a pedir la dirección (antes la pregunta quedaba como dirección de entrega).
  // "¿dónde está MI pedido?" sí es una consulta: la resuelve R3.
  if (isAddressQuestion(state, message)) {
    notes.push(await answerAddressQuestion(state, message, deps));
    return finish("R10:pregunta_en_direccion");
  }

  // En el resumen, "¿cuánto se demora?" / "¿dónde está mi pedido?" hablan del pedido que aún no se confirma.
  if (!isConfirmStageReply(state.stage, message) && isPendingOrderQuestion(state, message)) {
    notes.push(pendingOrderAnswer(state));
    return finish("R7:pregunta_en_resumen", "summary");
  }

  // En el resumen, "cambia la dirección a …": se corrige la dirección y se reimprime el resumen.
  const newAddress = state.stage === "confirm" ? addressCorrection(state, message) : "";
  if (newAddress) {
    state.deliveryAddress = newAddress;
    notes.push(`Listo, ya la cambié a: ${newAddress} ✅`);
    return finish("R7:direccion_cambiada", "summary");
  }
  // "la dirección está mal" sin decir cuál es: se borra y el siguiente paso vuelve a pedirla.
  if (
    state.stage === "confirm" &&
    state.deliveryType === "delivery" &&
    state.deliveryAddress &&
    !state.pendingChoice &&
    // "cambia la dirección" / "la dirección está mal". No "la dirección está bien, cambia el pago".
    /\b(?:(?:cambi\w*|correg\w*|corrig\w*) (?:la |mi )?direccion|direccion (?:esta |es )?(?:mal|equivocad[ao]|incorrect[ao])|otra direccion)\b/.test(normalizeText(message))
  ) {
    state.previousDeliveryAddress = state.deliveryAddress;
    state.deliveryAddress = undefined;
    return finish("R7:pedir_direccion");
  }

  // R3 · Consulta de un pedido ya hecho.
  if (wantsTracking(message) && !isConfirmStageReply(state.stage, message)) {
    return { state, reply: await deps.trackOrder(state.phone, message), route: "tracking", intent: "consultar_pedido", step: state.stage, decision: "R3:consultar_pedido" };
  }

  // R4 · Respuesta a una elección pendiente (opciones de producto, repetir pedido, sucursal, misma dirección).
  if (state.pendingChoice) {
    const resolved = await resolvePendingChoice(state, message, deps, notes);
    // "no, mejor para retirar": el "no" descarta la opción y el resto del mensaje sigue por las demás reglas
    // (antes se perdía la instrucción de retiro).
    // "no quiero ninguno" / "no quiero ese": "quiero ese" no es un pedido nuevo (antes sumaba "No te entendí bien").
    const rest = resolved === "producto_descartado" ? message.replace(/^\s*(?:(?:no+|nop|nel|negativo|mejor no|quiero|es[eoa]s?|ningun[oa]?(?: de es[oa]s)?)(?![\p{L}\p{N}])[\s,.;!]*)+/iu, "").trim() : "";
    if (resolved && rest && !isSmallTalk(rest) && !isNo(rest)) {
      await processChoiceQueue(state, deps, notes);
      message = rest;
    } else if (resolved) {
      await processChoiceQueue(state, deps, notes);
      return finish(`R4:eleccion_${resolved}`);
    }
  }

  // R5 · "Lo mismo de la última vez".
  if (wantsReorder(message) && !state.pendingChoice) {
    const order = await deps.lastOrder(state.phone);
    state.reorderOffered = true;
    if (!order) {
      notes.push("No te encuentro pedidos anteriores con este número 🙈");
      return finish("R5:repetir_sin_historial");
    }
    state.pendingChoice = { kind: "reorder", order };
    return finish("R5:repetir_pedido", "choice");
  }

  // R6 · Vaciar el carrito / empezar de nuevo.
  if (wantsClearCart(message)) {
    Object.assign(state, { cart: [], pendingChoice: null, choiceQueue: [], stage: "idle" });
    notes.push("Listo, borré tu pedido 🧹 Empezamos de cero");
    return finish("R6:vaciar_carrito");
  }

  // R7 · Confirmación del pedido (solo cuenta si el resumen ya se mostró). En el resumen solo confirma un "sí"
  // sin nada más (classifyConfirmReply, la MISMA función que usa classifyRoute): "sí, pero agrégale un café"
  // aplica el cambio y vuelve a mostrar el resumen; "gracias", "ya" o "nada más" no crean la orden.
  const confirmReply = classifyConfirmReply(message);
  // "no confirmo", "todavía no", "espera": aún no decide. No es "sin cambios" ni un rechazo.
  if (state.stage === "confirm" && !state.pendingChoice && wantsToWait(message)) {
    notes.push("Tranquilo, sin apuro 🙂 Cuando quieras escribe *confirmo* o dime qué cambiar. Tu pedido todavía no está enviado 👇");
    return finish("R7:espera_en_resumen", "summary");
  }
  if (state.stage === "confirm" && confirmReply === "courtesy") {
    notes.push("¡Con gusto! 😊 Ojo que tu pedido todavía no está enviado 👇");
    return finish("R7:cortesia_en_resumen", "summary");
  }
  // "incorrecto", "todo está mal", "no": quiere cambiar algo pero no dijo qué. Se le pregunta sin tocar el pedido.
  if (state.stage === "confirm" && !state.pendingChoice && isBareRejection(message)) {
    notes.push("Dime qué te cambio: productos, entrega, pago o tus datos 🙌 Tu pedido todavía no está enviado 👇");
    return finish("R7:pedir_cambio", "summary");
  }
  const confirming = state.stage === "ordered" ? confirmsPlacedOrder(message) : confirmReply === "confirm";
  if (confirming) {
    if (state.stage === "ordered" && state.lastOrderNumber) {
      notes.push(`Tu pedido ${state.lastOrderNumber} ya está registrado ✅${state.lastPaymentLink ? `\nPuedes pagarlo aquí: ${state.lastPaymentLink}` : ""}`);
      return { state, reply: notes.join("\n\n"), route: "checkout", intent: "orden_creada", step: state.stage, decision: "R7:ya_confirmado", orderNumber: state.lastOrderNumber, paymentLink: state.lastPaymentLink };
    }
    if (state.stage === "confirm") return confirmOrder(state, deps);
    // Dijo "confirmo" antes de tiempo: se le pide lo que falta.
    return finish("R7:confirmo_incompleto");
  }

  // Un número suelto ("1", "2") sin una lista abierta: responde a una lista vieja o es un error. En el resumen o
  // cuando se espera la ubicación NO se manda a la IA (a veces lo leía como "que sea 1 humita" y cambiaba el carrito):
  // se repite el paso sin tocar nada y sin sumar "no entendido".
  if (!state.pendingChoice && (state.stage === "confirm" || state.stage === "location") && /^#?\d{1,3}$/.test(normalizeText(message))) {
    if (state.stage === "confirm") notes.push("Ojo, tu pedido todavía no está enviado 👇");
    return finish("R10:numero_suelto", state.stage === "confirm" ? "summary" : "location");
  }

  // Ya es delivery y falta la ubicación: "delivery" o "quiero delivery a mi casa" repiten lo que ya se sabe.
  // Se vuelve a pedir la ubicación (antes no cambiaba nada y sumaba "no entendido").
  if (state.stage === "location" && state.deliveryType === "delivery" && detectDeliveryType(message) === "delivery" && onlyControlWords(message)) {
    notes.push("¡Perfecto! Va por delivery 🛵");
    return finish("R10:delivery_repetido", "location");
  }

  // R8 · Ver el carrito. Lo que está a medias (esperando que elija) también se cuenta: si no, el cliente
  // que pidió algo mientras había una pregunta abierta lee "tu carrito está vacío" y cree que lo perdió.
  const pendientes = pendingItemsLabel(state);
  if (wantsCart(message) && state.cart.length) {
    notes.push(`Por ahora llevas 🧾\n${state.cart.map(cartLine).join("\n")}${pendientes}`);
    return finish("R8:ver_carrito");
  }
  // "¿qué llevo?" con el carrito vacío: se dice y se sigue con el paso (antes sumaba "no entendido" y derivaba).
  if (wantsCart(message) && !state.cart.length && !wantsMenu(message)) {
    notes.push(pendientes ? `Todavía no tienes nada confirmado 🙂${pendientes}` : "Tu carrito está vacío por ahora 🙂");
    return finish("R8:carrito_vacio");
  }

  // R9 · Menú / qué tienen. También el nombre suelto de una categoría ("bebidas", "jugos").
  if (wantsMenu(message) || (await isBareCategory(state, message, deps))) {
    skipIdleQuestion = await showMenu(state, message, deps, notes);
    return finish("R9:menu", "catalog");
  }

  // Saludos y cortesías ("hola", "buenas tardes", "gracias", "👍"): se responde con el paso actual.
  // No cuentan como "no entendido" (antes dos saludos seguidos derivaban a soporte).
  if (isSmallTalk(message)) return finish("R10:saludo");

  // Local cerrado en retiro: "otro local", "retiro" o el nombre de otro local vuelve a ofrecer los locales.
  if (state.stage === "closed" && state.deliveryType === "pickup") {
    const text = normalizeText(message);
    const named = matchBranchInMessage(message, await deps.pickupBranches());
    const wantsOther = /\b(otro|otra) (local|sucursal|lugar)\b|\bcambi\w* (de |el )?(local|sucursal)\b/.test(text) || detectDeliveryType(message) === "pickup";
    if ((named && named.branchId !== state.branchId) || wantsOther) {
      Object.assign(state, { branchId: undefined, branchName: undefined, pendingChoice: null });
      return finish("R10:cambiar_local");
    }
  }

  // R10 · Respuesta corta y directa a la pregunta del paso actual ("1", "efectivo", "Ana Pérez", la cédula).
  if (await applyDirectAnswer(state, message, deps, notes)) return finish("R10:respuesta_al_paso");

  // R10 · Todo lo demás: se extraen datos del mensaje (IA con respaldo de reglas) y se aplican.
  const lastBotQuestion = stageQuestionHint(state);
  const extraction = await deps.extract(message, { lastBotQuestion, cartNames: state.cart.map((item) => item.name) });
  // Mientras se espera la dirección, un texto como "casa verde, junto al parque" NO debe buscarse como producto:
  // solo se agregan productos que coincidan exacto.
  const strict = state.stage === "address";
  if (strict) {
    // En el paso de dirección, el texto ES la dirección: la IA a veces lo pone en notes o billingAddress
    // y el bot repetía la pregunta (y la dirección terminaba como "Indicaciones" del pedido).
    extraction.notes = undefined;
    extraction.billingAddress = undefined;
  }
  const cartBefore = JSON.stringify(state.cart);
  let answered = await applyExtraction(state, message, extraction, deps, notes, strict);
  if (
    state.stage === "address" &&
    state.deliveryType === "delivery" &&
    !state.deliveryAddress &&
    !state.pendingChoice &&
    JSON.stringify(state.cart) === cartBefore &&
    !extraction.customerEmail &&
    message.length >= 5
  ) {
    if (!isNotAnAddress(message)) {
      state.deliveryAddress = message.slice(0, 200);
      state.previousDeliveryAddress = undefined;
    } else if (isAddressReference(message) && state.previousDeliveryAddress) {
      // "la misma" después de "la dirección está mal": se vuelve a la dirección que tenía (se ve en el resumen).
      state.deliveryAddress = state.previousDeliveryAddress;
      state.previousDeliveryAddress = undefined;
      notes.push(`Listo, te dejo la dirección que tenías: ${state.deliveryAddress} ✅`);
    } else {
      // "no sé", "otra dirección", "la misma" sin dirección anterior: no se guarda y se vuelve a pedir.
      notes.push("Necesito la dirección escrita, porfa 🙏");
    }
    answered = true;
  }
  if (state.stage === "name" && !state.customerName && !answered && isNotAName(message)) {
    // "retiro", "sí", "menú" en el paso del nombre: no es un nombre. Se vuelve a pedir sin sumar "no entendido".
    notes.push("Necesito el nombre de quien hace el pedido, así nomás (ej. *Ana Pérez*) 😊");
    answered = true;
  }
  if (state.stage === "invoice_doc" && !state.billingDocNumber && (hasDocLikeNumber(message) || !answered)) {
    // El dígito verificador no cuadra: se avisa en vez de aceptarla (la factura del SRI fallaría).
    notes.push(hasDocLikeNumber(message) ? "Ese número no es una cédula o RUC válido 🙏 Revísalo porfa" : "La cédula lleva 10 dígitos y el RUC 13 🧾");
    answered = true;
  }

  if (!answered && state.pendingChoice) {
    // No eligió ni pidió nada nuevo. NUNCA se repite el mismo mensaje palabra por palabra (es la queja
    // del dueño): se pide perdón y se repregunta con lo que diferencia a las opciones.
    if (state.pendingChoice.kind === "product") {
      notes.push(
        state.pendingChoice.clarify
          ? "Perdona, sigo sin cacharte 🙈 Dímelo con tus palabras (o dime *menú* y vemos todo)"
          : "Perdona, no te cacho 🙈"
      );
      state.pendingChoice = { ...state.pendingChoice, clarify: true };
    }
    return finish("R4:eleccion_repetida", "choice");
  }
  if (!answered && state.stage === "confirm") {
    // En el resumen nada está a medias: un mensaje que no cambió nada ("okey dokey", un typo raro) vuelve a mostrar
    // el resumen con la instrucción. No suma "no entendido" ni deriva a soporte con el pedido listo para enviar.
    // Una pregunta que no sabemos responder no es "sin cambios": se da el contacto de soporte y el resumen.
    if (isQuestion(message)) {
      notes.push(`Esa dudita te la resuelve mejor una persona del equipo: escríbele al ${deps.supportPhone} 👋 Tu pedido todavía no está enviado 👇`);
      return finish("R7:duda_en_resumen", "summary");
    }
    notes.push("No vi ningún cambio en tu pedido, te lo dejo igualito 👇");
    return finish("R7:resumen_sin_cambios", "summary");
  }
  if (!answered) {
    // Con el local cerrado no hay nada que entender: se repite solo el aviso de horario.
    notes.push(state.cart.length && state.stage !== "closed" ? "No te entendí bien 🙈 ¿Me lo repites?" : "");
    state.misunderstood = (state.misunderstood || 0) + 1;
    // Varios mensajes sin entender NO derivan a una persona: este bot toma pedidos y sigue intentando.
    // Solo un reclamo explícito pasa a soporte (R2). Al tercero se ofrece ayuda concreta.
    if (state.misunderstood >= 2 && state.stage !== "closed") {
      state.misunderstood = 0;
      notes.push(
        state.cart.length
          ? "No te entendí bien 🙈 Dime qué quieres agregar o quitar, escribe *menú* para ver todo, o *qué llevo* para revisar tu pedido"
          : "Perdón, no te entendí 🙈 Escríbeme qué se te antoja, algo como \"2 bolones mixtos de verde y un café\", o pídeme el *menú* para ver todo"
      );
      return finish("R11:ayuda");
    }
    return finish("R11:no_entendido");
  }
  state.misunderstood = 0;
  return finish(`R10:${extraction.source}`);
}

/**
 * Palabras de control de la entrega ("mejor", "delivery", "retiro", "para", "a mi casa"): no son productos.
 * Antes "mejor para retirar" terminaba en `No tenemos "mejor" en el menú`.
 */
const CONTROL_WORDS = new Set([
  "mejor", "delivery", "domicilio", "retiro", "retirar", "retiras", "recoger", "recojo", "pickup", "llevar", "para", "por", "a", "al", "en", "el", "la",
  "lo", "mi", "casa", "local", "envio", "enviar", "quiero", "prefiero", "que", "sea", "entonces", "no", "si", "ok", "dale", "porfa", "favor",
  "gracias", "y", "de", "mas", "bien", "va", "ser", "sera", "seria", "pero", "ahora", "hacer", "haz", "hazlo", "cambia", "cambialo",
]);

/** ¿El mensaje solo trae palabras de control ("quiero delivery a mi casa", "no, mejor para retirar")? */
function onlyControlWords(message: string) {
  const words = normalizeText(message).split(" ").filter(Boolean);
  return words.length > 0 && words.every((word) => CONTROL_WORDS.has(word));
}

/** Respuesta a una pregunta hecha cuando el bot esperaba la dirección. Solo dice lo que el bot sabe de verdad. */
async function answerAddressQuestion(state: BotState, message: string, deps: BotDeps) {
  const text = normalizeText(message);
  const branch = state.branchName ? ` (te atiende la sucursal ${state.branchName})` : "";
  if (/\b(cuanto|cuanta|costo|cuesta|cuestan|precio|valor|cobran)\b/.test(text) && !/\b(demora|tarda|tiempo|minutos)\b/.test(text) && state.deliveryFee != null) {
    // Picker cobra distinto en efectivo y en tarjeta: si el cliente todavía no eligió cómo paga (o pregunta por el
    // otro método), se dicen los dos precios para que el resumen no lo sorprenda con otro valor.
    const quoted = state.paymentMethod || "card";
    const asked = detectPaymentMethod(message);
    const other = asked === "card" || asked === "cash" ? asked : state.paymentMethod ? null : "cash";
    if (other && other !== quoted && state.deliveryCoordinates) {
      const alt = await deps.quoteLocation(state.deliveryCoordinates, other);
      if (alt.covered && Math.round(alt.deliveryFee * 100) !== Math.round(state.deliveryFee * 100)) {
        return `El delivery a la ubicación que me compartiste cuesta ${money(state.deliveryFee)} ${paymentLabel(quoted)} y ${money(alt.deliveryFee)} ${paymentLabel(other)}${branch} 🛵`;
      }
    }
    return `El delivery a la ubicación que me compartiste cuesta ${money(state.deliveryFee)}${branch} 🛵`;
  }
  if (/\b(demora|demoran|tarda|tardan|tiempo|minutos|cuando llega)\b/.test(text)) {
    return `Depende de cómo esté la cocina y el tráfico 🛵 Apenas salga tu pedido, escribe *mi pedido* y te paso el link para seguir al motorizado en vivo`;
  }
  if (/\b(llegan|llega|hacen delivery|hacen envios|envian|cubren|reparten)\b/.test(text)) {
    return `¡Sí llegamos a la ubicación que me compartiste! 🛵${branch}
Si el pedido es para otro lado, mándame esa ubicación desde el clip 📎`;
  }
  return `Esa dudita te la resuelve mejor una persona del equipo: escríbele al ${deps.supportPhone} 👋`;
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

/** Lo que el cliente pidió y todavía está esperando que elija ("un café", "el de queso verde"). */
function pendingItemsLabel(state: BotState) {
  // Solo lo que está en cola: lo que el bot pregunta en este mismo mensaje ya se ve abajo.
  const pending = state.choiceQueue.map((item) => item.query).filter(Boolean);
  return pending.length ? `\n\nY me falta preguntarte por: ${pending.join(", ")} 👇` : "";
}

/** ¿Esto parece el nombre de un producto y no una muletilla ("mejor", "para retirar")? */
function looksLikeProductQuery(query: string) {
  return meaningfulTokens(query).some((token) => token.length >= 4) && !onlyControlWords(query);
}

async function addSearchedItem(state: BotState, query: string, quantity: number, deps: BotDeps, notes: string[], strict = false) {
  // "hola", "ok", "gracias": sin palabras con significado no se busca ni se responde "no tenemos".
  const tokens = meaningfulTokens(query);
  if (!tokens.some((token) => token.length >= 4)) return false;
  // "mejor", "para delivery", "retiro": palabras de control, no productos (sin "No tenemos …").
  if (onlyControlWords(query)) return false;
  const result = await deps.search(query, state.branchId);
  if (strict && result.kind !== "exact") return false;
  if (result.kind === "exact") {
    notes.push(addCapped(state, result.product, quantity));
    return true;
  }
  if (result.kind === "ambiguous") {
    state.pendingChoice = { kind: "product", query, quantity, options: result.options.map(toOption) };
    return true;
  }
  if (result.suggestions.length) {
    notes.push(`Mmm, no encontré "${query}" tal cual 🙈`);
    state.pendingChoice = { kind: "product", query, quantity, options: result.suggestions.map(toOption) };
    return true;
  }
  notes.push(`Uy, no tenemos "${query}" en el menú 🙈`);
  return false;
}

/**
 * Agrega al carrito y devuelve el texto de lo que DE VERDAD se agregó: el carrito tiene tope de MAX_QUANTITY
 * por producto ("108 bolones" agrega hasta 50 y lo avisa, antes decía "Agregué 108").
 */
function addCapped(state: BotState, product: { productId: string; name: string; price: number }, quantity: number) {
  const before = state.cart.find((item) => item.productId === product.productId)?.quantity || 0;
  state.cart = addToCart(state.cart, { productId: product.productId, name: product.name, quantity });
  const added = (state.cart.find((item) => item.productId === product.productId)?.quantity || 0) - before;
  const line = `Agregué ${added} x ${prettyName(product.name)} ${money(product.price * added)}`;
  if (added >= quantity) return line;
  return added > 0
    ? `${line} (pediste ${quantity}, el máximo por producto es ${MAX_QUANTITY})`
    : `Ya tienes el máximo de ${MAX_QUANTITY} x ${prettyName(product.name)} por pedido 🙏`;
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
  // Datos adelantados (lo que el bot todavía no preguntó): se guardan y se confirman con un acuse corto
  // ("Anoté: efectivo ✅") para que el cliente sepa que no hace falta repetirlos.
  const before = { paymentMethod: state.paymentMethod, customerName: state.customerName, customerEmail: state.customerEmail, billingDocNumber: state.billingDocNumber };

  // Transferencia: no se acepta, se ofrece tarjeta o efectivo.
  if (extraction.paymentMethod === "transfer") {
    notes.push("Por aquí no recibimos transferencias 🙏 Puedes pagar con tarjeta (te mando un link) o en efectivo");
    state.paymentMethod = undefined;
    changed = true;
  } else if (extraction.paymentMethod) {
    state.paymentMethod = extraction.paymentMethod;
    changed = true;
  }

  if (extraction.deliveryType && extraction.deliveryType !== state.deliveryType) {
    await setDeliveryType(state, extraction.deliveryType, deps, notes);
    changed = true;
  }

  // La IA a veces toma "retiro" o "tarjeta" como nombre cuando el bot preguntó "¿a nombre de quién?".
  if (extraction.customerName && !isNotAName(extraction.customerName)) {
    state.customerName = titleCaseName(extraction.customerName);
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
    state.billingName = titleCaseName(extraction.billingName);
    changed = true;
  }
  if (extraction.notes) {
    state.notes = [state.notes, extraction.notes].filter(Boolean).join(". ");
    changed = true;
  }

  // "quita uno de los bolones, con uno basta": el cliente quiere bajar la cantidad, no borrar el producto.
  const units = parseRemovalUnits(message);
  for (const query of extraction.remove) {
    const item = findInCart(state.cart, query);
    if (item) {
      const left = units?.keep != null ? units.keep : units?.remove != null ? item.quantity - units.remove : 0;
      if (left > 0 && left < item.quantity) {
        state.cart = setCartQuantity(state.cart, item.productId, left);
        notes.push(`Listo, te dejo ${left} x ${prettyName(item.name)} ✅`);
        changed = true;
        continue;
      }
      state.cart = removeFromCart(state.cart, item.productId);
      notes.push(`Quité ${prettyName(item.name)} ✅`);
    } else {
      notes.push(`No encontré "${query}" en tu pedido 🤔`);
    }
    changed = true;
  }

  for (const change of extraction.setQuantity) {
    const item = findInCart(state.cart, change.query);
    if (item) {
      state.cart = setCartQuantity(state.cart, item.productId, change.quantity);
      const now = state.cart.find((current) => current.productId === item.productId)?.quantity || 0;
      notes.push(
        change.quantity > 0
          ? `Ahora son ${now} x ${prettyName(item.name)}${now < change.quantity ? ` (el máximo por producto es ${MAX_QUANTITY})` : ""}`
          : `Quité ${prettyName(item.name)} ✅`
      );
      changed = true;
    } else {
      // No estaba en el carrito: se trata como producto nuevo.
      extraction.items.push({ query: change.query, quantity: change.quantity || 1 });
    }
  }

  // "para retirar en Boloncity Kennedy": el nombre del local no es un producto.
  if (extraction.items.length) {
    const branches = await deps.pickupBranches();
    extraction.items = extraction.items
      .map((item) => ({ ...item, query: stripBranchWords(item.query, branches) }))
      .filter((item) => item.query && !isBranchPhrase(item.query, branches));
  }

  // Productos: el primero ambiguo abre una elección y los demás esperan en cola.
  for (const item of extraction.items) {
    if (state.pendingChoice) {
      // Hay una pregunta abierta ("¿cuál café?", "¿en qué local?") y el cliente pide otra cosa.
      // Si ese producto es UNO solo, se agrega ya mismo y se sigue con la pregunta: antes el bot
      // repetía la lista tal cual y el producto aparecía recién un turno después (el carrito
      // incluso se veía vacío en "qué llevo").
      const held = state.pendingChoice;
      state.pendingChoice = null;
      const added = looksLikeProductQuery(item.query) && (await addSearchedItem(state, item.query, item.quantity, deps, notes, true));
      state.pendingChoice = held;
      if (added) {
        changed = true;
        continue;
      }
      // No es un producto exacto: solo se anota si de verdad se parece a algo del menú
      // ("mmm no se jaja" no se anota ni se contesta "no tenemos").
      const found = looksLikeProductQuery(item.query) ? await deps.search(item.query, state.branchId) : null;
      if (found && (found.kind !== "none" || found.suggestions.length)) {
        state.choiceQueue.push(item);
        notes.push(`Anotado lo de "${item.query}" 📝 Apenas cerremos esto te pregunto por eso`);
        changed = true;
      }
      continue;
    }
    if (await addSearchedItem(state, item.query, item.quantity, deps, notes, strict)) changed = true;
  }

  const acks: string[] = [];
  if (state.paymentMethod && state.paymentMethod !== before.paymentMethod && state.stage !== "payment") acks.push(state.paymentMethod === "cash" ? "efectivo" : "tarjeta");
  if (state.customerName && state.customerName !== before.customerName && state.stage !== "name") acks.push(`a nombre de ${state.customerName}`);
  if (state.customerEmail && state.customerEmail !== before.customerEmail && state.stage !== "email") acks.push(state.customerEmail);
  if (state.billingDocNumber && state.billingDocNumber !== before.billingDocNumber && state.stage !== "invoice_doc") acks.push(`cédula/RUC ${state.billingDocNumber}`);
  if (acks.length) notes.push(`Anoté: ${acks.join(" · ")} ✅`);

  // Si el cliente cambió algo que afecta el precio del delivery, se recotiza.
  if (changed && extraction.paymentMethod && extraction.paymentMethod !== "transfer") {
    await requoteForPayment(state, deps, notes);
  }

  return changed;
}

/**
 * Mensaje corto que responde exactamente lo que el bot preguntó. Solo mensajes cortos:
 * "2 humitas para llevar" en el paso de entrega trae productos y va por la extracción completa.
 */
async function applyDirectAnswer(state: BotState, message: string, deps: BotDeps, notes: string[]) {
  const text = normalizeText(message);
  const short = text.split(" ").length <= 4;
  switch (state.stage) {
    case "delivery_type": {
      const type = text === "1" ? "delivery" : text === "2" ? "pickup" : short ? detectDeliveryType(message) : null;
      if (!type) return false;
      await setDeliveryType(state, type, deps, notes);
      return true;
    }
    case "payment": {
      const method = text === "1" ? "card" : text === "2" ? "cash" : short ? detectPaymentMethod(message) : null;
      if (method !== "card" && method !== "cash") return false;
      state.paymentMethod = method;
      await requoteForPayment(state, deps, notes);
      return true;
    }
    case "name": {
      // "me llamo Diego Reyes", "soy Ana": el cliente presenta su nombre hablando (antes quedaba
      // como cliente "Me Llamo Diego Reyes").
      const declared = extractDeclaredName(message);
      if (declared) {
        state.customerName = declared;
        return true;
      }
      // "Ana Pérez" es un nombre; "humita" también parece uno, por eso se descarta si es un producto.
      if (!looksLikeBareName(message) || (await deps.search(message, state.branchId)).kind === "exact") return false;
      state.customerName = titleCaseName(message);
      return true;
    }
    case "invoice_doc": {
      const doc = extractDocNumber(message);
      if (!doc) return false;
      state.billingDocNumber = doc;
      return true;
    }
    case "email": {
      const declaredInEmail = extractDeclaredName(message);
      if (declaredInEmail) {
        state.customerName = declaredInEmail;
        return true;
      }
      // Dio su nombre cuando se le pidió el correo ("Ana Pérez"): se toma como nombre del pedido.
      if (!looksLikeBareName(message) || (await deps.search(message, state.branchId)).kind === "exact") return false;
      state.customerName = titleCaseName(message);
      return true;
    }
    case "invoice_name":
      // Razón social: "Rosa Prueba SA" conserva la sigla (titleCaseName).
      if (!/^[\p{L}.&\s]{2,80}$/u.test(message.trim()) || isNotAName(message)) return false;
      state.billingName = titleCaseName(message);
      return true;
    default:
      return false;
  }
}

async function setDeliveryType(state: BotState, type: "delivery" | "pickup", deps: BotDeps, notes: string[]) {
  state.deliveryType = type;
  // "¿En qué local lo retiras?" no aplica a delivery, ni "¿a la misma dirección?" a retiro: la pregunta se descarta.
  if ((type === "delivery" && state.pendingChoice?.kind === "branch") || (type === "pickup" && state.pendingChoice?.kind === "reuse_location")) {
    state.pendingChoice = null;
  }
  // Cambiar de modalidad invalida lo calculado para la otra. La ubicación compartida se guarda aparte: si el cliente
  // vuelve a delivery (delivery → retiro → delivery) se reusa y se recotiza en vez de pedirla otra vez.
  if (type === "pickup") {
    if (state.deliveryCoordinates) state.savedDeliveryLocation = { coords: state.deliveryCoordinates, mapsUrl: state.deliveryGoogleMapsUrl || "" };
    Object.assign(state, { deliveryCoordinates: undefined, deliveryGoogleMapsUrl: undefined, deliveryFee: undefined, deliveryDistance: undefined, branchId: undefined, branchName: undefined });
    return;
  }
  Object.assign(state, { branchId: state.deliveryCoordinates ? state.branchId : undefined, branchName: state.deliveryCoordinates ? state.branchName : undefined });
  const saved = state.savedDeliveryLocation;
  if (!state.deliveryCoordinates && saved) {
    state.savedDeliveryLocation = undefined;
    notes.push("Uso la ubicación que me compartiste antes 📍 Si es otra, mándame la nueva desde el clip 📎");
    await applyLocation(state, saved.coords, saved.mapsUrl, deps, notes);
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
    // El motivo de Picker/web habla de «Retiro en tienda» (botón de la web): en WhatsApp se dice en una frase.
    const reason = /tienda|sucursal m[aá]s cercana/i.test(quote.reason || "") || !quote.reason ? "Uy, hasta esa ubicación no llegamos con delivery 😔" : quote.reason;
    notes.push(`${reason}\nPero lo puedes retirar en el local, escribe *retiro* 🏠`);
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
  if (!silent) notes.push(`¡Listo! Te atiende la sucursal ${quote.branchName} 🛵 El delivery te cuesta ${money(quote.deliveryFee)}`);
  if (branchChanged) await revalidateCartForBranch(state, deps, notes);
  return true;
}

const paymentLabel = (method: "card" | "cash") => (method === "cash" ? "pagando en efectivo" : "pagando con tarjeta");

/**
 * Picker cobra distinto en efectivo y en tarjeta: al elegir o cambiar el pago en delivery se recotiza para que el
 * resumen muestre lo que se cobrará. Si el envío cambia respecto a lo que se dijo al compartir la ubicación, se dice
 * explícitamente (antes pasaba de $2.69 a $2.80 sin aviso).
 */
async function requoteForPayment(state: BotState, deps: BotDeps, notes: string[]) {
  if (state.deliveryType !== "delivery" || !state.deliveryCoordinates || !state.paymentMethod) return;
  const before = state.deliveryFee;
  const covered = await applyLocation(state, state.deliveryCoordinates, state.deliveryGoogleMapsUrl || "", deps, notes, { silent: true });
  if (covered && before != null && state.deliveryFee != null && Math.round(before * 100) !== Math.round(state.deliveryFee * 100)) {
    notes.push(`Ojo: el envío ${paymentLabel(state.paymentMethod)} cuesta ${money(state.deliveryFee)}, no ${money(before)} como te dije 🙏`);
  }
}

/** Al fijar sucursal, se quitan del carrito los productos que ahí no se venden. */
async function revalidateCartForBranch(state: BotState, deps: BotDeps, notes: string[]) {
  if (!state.branchId || !state.cart.length) return;
  const available = new Set((await deps.catalog(state.branchId)).map((product) => product.productId));
  const missing = state.cart.filter((item) => !available.has(item.productId));
  if (!missing.length) return;
  state.cart = state.cart.filter((item) => available.has(item.productId));
  notes.push(`En ${state.branchName} no hay disponible: ${missing.map((item) => prettyName(item.name)).join(", ")} 😕 Lo saqué de tu pedido`);
}

/**
 * Desempate con IA ENTRE LAS OPCIONES MOSTRADAS. Devuelve la opción elegida o null.
 * La IA no ve el catálogo ni escribe el mensaje: solo dice cuál de la lista quiso el cliente.
 * Si no hay IA configurada, si falla o si devuelve algo fuera de la lista, se sigue con las reglas.
 */
async function chooseWithAi<T extends { name: string; price?: number }>(
  message: string,
  options: T[],
  choice: { kind: "product"; query: string; label?: string } | { kind: "branch" },
  deps: BotDeps
): Promise<T | null> {
  if (!deps.chooseOption || options.length < 2) return null;
  const question = choice.kind === "branch" ? "¿En qué local lo retiras?" : choice.label ? `Opciones de ${choice.label}` : `¿Cuál ${choice.query} quieres?`;
  try {
    const index = await deps.chooseOption({ message, question, options: options.map((option) => ({ name: option.name, price: option.price })) });
    return index && index >= 1 && index <= options.length ? options[index - 1] : null;
  } catch (error) {
    console.error("[whatsapp-bot] la IA no pudo desempatar la elección, sigo con reglas:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * ¿Las palabras que no son de la lista mostrada nombran OTRO producto del menú?
 * "kero" no es nada (es "quiero" mal escrito) → la elección sigue en pie.
 * "tigrillo" sí existe → el cliente cambió de idea y lo resuelve el router como pedido nuevo.
 */
async function namesAnotherProduct(words: string[], state: BotState, deps: BotDeps) {
  const query = words.filter((word) => word.length >= 4).join(" ").trim();
  if (!query) return false;
  const result = await deps.search(query, state.branchId);
  return result.kind === "exact" || result.kind === "ambiguous";
}

async function resolvePendingChoice(state: BotState, message: string, deps: BotDeps, notes: string[]): Promise<string | null> {
  const choice = state.pendingChoice!;
  switch (choice.kind) {
    case "product": {
      const pick = pickChoice(message, choice.options);
      // "no quiero el maduro", "el verde no": está descartando UNA opción, no toda la pregunta.
      // Va antes del "no" suelto: si no, el bot descartaba todo y de paso ofrecía justo lo negado.
      if (negatedPhrase(message) && (pick.kind === "one" || (pick.kind === "several" && pick.negated))) {
        if (pick.kind === "one") {
          state.pendingChoice = null;
          notes.push(addCapped(state, pick.option, pick.quantity || choice.quantity));
          return "producto";
        }
        state.pendingChoice = { ...choice, options: pick.options, clarify: true };
        notes.push("Dale, ese lo descartamos 👍");
        return "producto_descartado_parcial";
      }
      if (isNo(message) || /\b(ninguno|ninguna|ninguno de esos|otro)\b/.test(normalizeText(message))) {
        state.pendingChoice = null;
        notes.push("Dale, no lo agrego 👍");
        return "producto_descartado";
      }
      if (pick.kind === "one") {
        state.pendingChoice = null;
        // "cualquiera", "el que me recomiendes": se dice cuál se eligió para que nadie se lleve una sorpresa.
        if (pick.any) notes.push("Dale, te pongo la que más sale 😋");
        notes.push(addCapped(state, pick.option, pick.quantity || choice.quantity));
        return "producto";
      }
      // "los dos", "uno de cada uno": se agregan TODAS las opciones mostradas, una unidad de cada una
      // (o la cantidad que pidió: "2 de cada uno" no existe todavía, así que se usa la del pedido original).
      if (pick.kind === "all") {
        state.pendingChoice = null;
        for (const option of pick.options) notes.push(addCapped(state, option, choice.quantity));
        return "producto_todos";
      }
      // Sigue ambiguo ("el de queso" cuando todas son de queso): antes de repreguntar, la IA intenta
      // desempatar entre ESTAS opciones (nunca inventa: solo devuelve cuál de la lista).
      // Si el cliente nombró OTRA cosa, no se fuerza una elección de esta lista.
      if (pick.kind === "none" && pick.reason === "foreign") {
        // "mejor un tigrillo", "cambia, quiero una humita": cambió de idea. Se descarta la pregunta y el
        // mensaje sigue por las demás reglas, que buscan el producto nuevo.
        if (/^(?:mejor|cambia\w*|olvida\w*|prefiero otr[ao]|no importa)\b/.test(normalizeText(message))) {
          state.pendingChoice = null;
          notes.push("Dale, no lo agrego 👍");
          return "producto_descartado";
        }
        // "kero el maduro": lo distintivo se entendió y lo raro ("kero") no es ningún producto del menú.
        // Se toma la opción que el cliente sí nombró en vez de repetirle la lista igualita.
        if (pick.best && !(await namesAnotherProduct(pick.words || [], state, deps))) {
          state.pendingChoice = null;
          notes.push(addCapped(state, pick.best, choice.quantity));
          return "producto";
        }
        return null;
      }
      // "el verde no": se repregunta SOLO entre las que quedan, reconociendo lo que descartó.
      if (pick.kind === "several" && pick.negated) {
        state.pendingChoice = { ...choice, options: pick.options, clarify: true };
        notes.push("Dale, ese lo descartamos 👍");
        return "producto_descartado_parcial";
      }
      const candidates = pick.kind === "several" ? pick.options : choice.options;
      // Con una negación de por medio ("el de queso no") la IA no desempata: podría agregar justo
      // lo que el cliente descartó. Se prefiere repreguntar.
      const byAi = negatedPhrase(message) ? null : await chooseWithAi(message, candidates, choice, deps);
      if (byAi) {
        state.pendingChoice = null;
        notes.push(addCapped(state, byAi, choice.quantity));
        return "producto_ia";
      }
      if (pick.kind === "several") {
        // Se repregunta mostrando SOLO lo que las diferencia.
        state.pendingChoice = { ...choice, options: candidates, clarify: true };
        return "producto_ambiguo";
      }
      return null;
    }
    case "reorder": {
      if (isNo(message)) {
        state.pendingChoice = null;
        return "repetir_no";
      }
      // "sí, lo mismo", "dale repite", "el mismo de siempre", "ya, repítelo".
      if (!isYes(message) && !wantsReorder(message) && !/\b(repite\w*|repetir|repitelo|lo mismo|el mismo|igual que antes|igualito)\b/.test(normalizeText(message))) return null;
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
        `¡Listo! Te armé lo mismo de la vez pasada 🫓\n${state.cart.map(cartLine).join("\n")}${missing.length ? `\n\nEso sí, ya no tenemos: ${missing.join(", ")}` : ""}`
      );
      return "repetir_si";
    }
    case "reuse_location": {
      if (isNo(message)) {
        state.pendingChoice = null;
        return "misma_direccion_no";
      }
      // "sí", "la misma de siempre", "sí la de antes", "a la misma": todas dicen lo mismo.
      if (!isYes(message) && !isAddressReference(message)) return null;
      state.pendingChoice = null;
      state.deliveryAddress = choice.address;
      await applyLocation(state, choice.coords, choice.mapsUrl, deps, notes);
      return "misma_direccion_si";
    }
    case "branch": {
      // La lista de locales solo vale en retiro: si el pedido ya es delivery, un "1" no elige local (antes decía
      // "lo retiras en Avalon" y dejaba el delivery con esa sucursal).
      if (state.deliveryType !== "pickup") {
        state.pendingChoice = null;
        return null;
      }
      // "el de la kennedy", "urdesa", "el primero", "2" o "retiro en Boloncity Kennedy".
      const byRules = pickChoice(message, choice.options);
      // "urdesa no": se descarta ese local y se repregunta con los que quedan. Nunca se fija el
      // que el cliente acaba de rechazar (iría a buscar su pedido a la tienda equivocada).
      if (byRules.kind === "several" && byRules.negated) {
        state.pendingChoice = { kind: "branch", options: byRules.options };
        notes.push("Dale, ese local lo descartamos 👍");
        return "sucursal_descartada";
      }
      // En los locales "cualquiera" no alcanza: hay que saber a dónde va a ir de verdad.
      if (byRules.kind === "one" && byRules.any) {
        notes.push("Para el retiro sí necesito saber a cuál vas 🙏");
        return "sucursal_cualquiera";
      }
      const picked =
        byRules.kind === "one"
          ? byRules.option
          : (!negatedPhrase(message) && matchBranchInMessage(message, choice.options)) ||
            (negatedPhrase(message) ? null : await chooseWithAi(message, choice.options, { kind: "branch" }, deps));
      if (!picked) {
        // "el más cercano": sin la ubicación del cliente no se puede saber cuál le queda más cerca.
        if (asksForNearest(message)) {
          notes.push("Para saber cuál te queda más cerca, mándame tu ubicación desde el clip 📎 o dime por qué sector andas 📍");
          return "sucursal_cercana";
        }
        return null;
      }
      await pickBranch(state, picked, deps, notes);
      return "sucursal";
    }
  }
}

/** Productos que no se ofrecen sueltos al listar una categoría (syrups, agrandados, envases). */
const NOT_LISTED = /\b(syrup|agrandar|envase|funda|contenedor|cubiertos|servilletas)\b/i;

/** Devuelve true si mostró la lista de categorías (que ya termina con una pregunta). */
async function showMenu(state: BotState, message: string, deps: BotDeps, notes: string[]) {
  const products = await deps.catalog(state.branchId);
  const categories = listCategories(products);
  // "¿qué bebidas tienen?" / "menú de jugos" → productos de esa categoría como opciones elegibles.
  const category = findCategory(message, categories);
  if (category) {
    const options = products
      .filter((product) => product.categoryNames.includes(category.name) && !NOT_LISTED.test(product.name))
      .slice(0, 10)
      .map(toOption);
    if (options.length) {
      state.pendingChoice = { kind: "product", query: category.name, quantity: 1, options, label: displayCategoryName(titleCase(category.name)) };
      return false;
    }
  }
  notes.push(
    `Mira, esto es lo que tenemos 🫓\n${categories.map((entry) => `• ${displayCategoryName(titleCase(entry.name))}`).join("\n")}\n\nDime qué se te antoja (ej. "2 bolones mixtos y un café") o mira el menú con fotos aquí: ${deps.menuUrl}`
  );
  return !state.cart.length;
}

/** "bebidas", "jugos", "tostadas": el mensaje es solo el nombre de una categoría. */
async function isBareCategory(state: BotState, message: string, deps: BotDeps) {
  const text = normalizeText(message);
  if (!text || /\d/.test(text) || text.split(" ").length > 3) return false;
  return Boolean(findCategory(message, listCategories(await deps.catalog(state.branchId)), { exactOnly: true }));
}

// ─── Sucursales ──────────────────────────────────────────────────────────────

/** Palabras del nombre de un local que lo distinguen ("Boloncity Kennedy" → kennedy). */
function branchTokens(name: string) {
  return meaningfulTokens(name).filter((token) => token !== "boloncity" && token.length >= 3);
}

/** El local que nombra el mensaje ("retiro en Kennedy", "en la de Urdesa"). Solo si es uno solo. */
export function matchBranchInMessage(message: string, branches: BranchOption[]): BranchOption | null {
  const tokens = meaningfulTokens(message);
  if (!tokens.length) return null;
  const scored = branches
    .map((branch) => {
      const names = branchTokens(branch.name);
      const hits = names.filter((name) => tokens.some((token) => tokenSimilarity(token, name) >= 0.85)).length;
      return { branch, score: names.length ? hits / names.length : 0 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].branch;
}

/** "en boloncity kennedy", "local urdesa": frase que solo nombra un local, no un producto. */
function isBranchPhrase(query: string, branches: BranchOption[]) {
  const generic = new Set(["boloncity", "local", "sucursal", "retiro", "retirar", "recoger", "tienda"]);
  const tokens = meaningfulTokens(query);
  if (!tokens.length) return false;
  const branchWords = branches.flatMap((branch) => branchTokens(branch.name));
  return tokens.every((token) => generic.has(token) || branchWords.some((word) => tokenSimilarity(token, word) >= 0.85));
}

/** "humita en boloncity samborondon" → "humita": quita el local que quedó pegado al final del producto. */
function stripBranchWords(query: string, branches: BranchOption[]) {
  const connectors = new Set(["en", "el", "la", "de", "del", "al", "a", "para", "boloncity", "local", "sucursal", "retiro", "retirar", "recoger", "tienda"]);
  const branchWords = branches.flatMap((branch) => branchTokens(branch.name));
  const words = normalizeText(query).split(" ").filter(Boolean);
  const isBranchWord = (word: string) => connectors.has(word) || branchWords.some((name) => tokenSimilarity(meaningfulTokens(word)[0] || word, name) >= 0.85);
  // Solo si de verdad nombra un local: "tostada de la casa" no se toca.
  const tail = [...words];
  let removed = false;
  while (tail.length && isBranchWord(tail[tail.length - 1])) {
    if (!connectors.has(tail[tail.length - 1])) removed = true;
    tail.pop();
  }
  return removed ? tail.join(" ") : query;
}

async function pickBranch(state: BotState, branch: BranchOption, deps: BotDeps, notes: string[]) {
  state.pendingChoice = null;
  state.branchId = branch.branchId;
  state.branchName = branch.name;
  notes.push(`¡Perfecto! Lo retiras en ${branch.name} 🏠`);
  await revalidateCartForBranch(state, deps, notes);
}

/** Respuesta a lo que el cliente escribe DESPUÉS de crear la orden, si habla de esa orden. */
/** Con la orden ya creada: "confirmo", "sí", "claro", "de una", "si está bien así" repiten la confirmación. */
function confirmsPlacedOrder(message: string) {
  return wantsConfirm(message) || classifyConfirmReply(message) === "confirm";
}

function orderFollowUp(state: BotState, message: string, deps: BotDeps): string | null {
  const order = state.lastOrderNumber!;
  const link = state.lastPaymentLink;
  const method = detectPaymentMethod(message);
  const short = normalizeText(message).split(" ").length <= 8;
  if (wantsPaymentLink(message)) {
    return link
      ? `Aquí tienes el link de pago de tu pedido ${order} 💳\n${link}\n\nSi no te abre, cópialo y pégalo en el navegador. Y si sigue sin funcionar, escríbele al ${deps.supportPhone} que te ayudan`
      : `Tu pedido ${order} es con pago en efectivo 💵, no necesita link. Si necesitas algo más, escríbenos al ${deps.supportPhone}`;
  }
  if (method && short) {
    if (link && method !== "card") {
      return `Tu pedido ${order} ya quedó creado para pagar con tarjeta 💳\n${link}\n\nSi prefieres pagar ${method === "cash" ? "en efectivo" : "de otra forma"}, escríbele al ${deps.supportPhone} y te lo cambian`;
    }
    return `Tu pedido ${order} ya está registrado ✅${link ? `\nPuedes pagarlo aquí: ${link}` : ""}`;
  }
  if (isGreeting(message)) {
    return `¡Hola de nuevo! 👋 Tu pedido ${order} está registrado${link ? `\nSi aún no lo pagas, hazlo aquí: ${link}` : ""}\n\nEscribe *mi pedido* para ver cómo va, o dime qué se te antoja y armamos uno nuevo`;
  }
  if (isSmallTalk(message)) {
    return `¡Gracias a ti! 🙌 Tu pedido ${order} está registrado${link ? `\nSi aún no lo pagas, hazlo aquí: ${link}` : ""}\n\nY si se te antoja algo más, dime nomás`;
  }
  return null;
}

/** Nombre del perfil de WhatsApp utilizable como nombre del pedido, o "" si no parece un nombre. */
function cleanSenderName(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw || /^\{.*\}$/.test(raw) || /boloncity/i.test(raw)) return "";
  const letters = raw.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñÜü\s]/g, " ").replace(/\s+/g, " ").trim();
  return looksLikeBareName(letters) ? letters : "";
}

// ─── Siguiente paso ──────────────────────────────────────────────────────────

/**
 * Lo primero que falta para cerrar el pedido, SIEMPRE en este orden:
 * elección pendiente → productos → delivery o retiro → ubicación/sucursal → dirección →
 * sucursal abierta → nombre → correo → pago → factura (si la pidió) → resumen.
 */
export async function nextStep(state: BotState, deps: BotDeps): Promise<{ question: string; route?: Route }> {
  // Una elección de local solo vale en retiro (y "¿a la misma dirección?" solo en delivery): si la modalidad
  // cambió por otro camino, la pregunta vieja no se vuelve a mostrar.
  if ((state.pendingChoice?.kind === "branch" && state.deliveryType !== "pickup") || (state.pendingChoice?.kind === "reuse_location" && state.deliveryType === "pickup")) {
    state.pendingChoice = null;
  }
  const choice = state.pendingChoice;
  if (choice) {
    state.stage = "choosing";
    if (choice.kind === "product") {
      // El cliente ya dijo algo que varias comparten ("el de queso"): se repregunta mostrando SOLO
      // lo que las diferencia, sin pedirle que responda con un número.
      if (choice.clarify) {
        const differences = choice.options.map((option, index) => `${index + 1}. ${prettyName(distinctiveLabel(option, choice.options, index))} ${money(option.price)}`).join("\n");
        return { question: `Uy, tengo varias parecidas 😅 ¿cuál prefieres?\n${differences}\n\nDime cuál y te la agrego`, route: "choice" };
      }
      const ask = choice.label ? `Estas son nuestras opciones de ${choice.label} 😋` : `¿Cuál ${choice.query} quieres?`;
      return { question: `${ask}\n${optionsList(choice.options)}\n\nDime cuál prefieres 😊`, route: "choice" };
    }
    if (choice.kind === "reorder") {
      return {
        question: `Tu último pedido (${choice.order.orderNumber}) fue:\n${describeLastOrder(choice.order)}\n\n¿Te lo repito? Dime que sí o cuéntame qué se te antoja hoy 🫓`,
        route: "choice",
      };
    }
    if (choice.kind === "reuse_location") {
      return { question: `¿Te lo mandamos a la misma dirección de la vez pasada? 📍\n${choice.address}\n\nDime si te sirve esa misma o mándame otra ubicación`, route: "choice" };
    }
    return { question: `¿En qué local lo retiras? 🏠\n${optionsList(choice.options)}\n\nDime cuál te queda mejor 😊`, route: "choice" };
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
        const greeting = state.customerName ? `¡Hola ${state.customerName.split(" ")[0]}! 👋 Qué bueno verte de vuelta` : "¡Hola! 👋 Qué bueno verte";
        return { question: `${greeting}\n${(await nextStep(state, deps)).question}`, route: "choice" };
      }
    }
    state.stage = "idle";
    return { question: `¿Qué te gustaría pedir hoy? 🫓 Escríbeme algo como "2 bolones mixtos de verde y un café", o pídeme el *menú* si quieres ver todo` };
  }

  if (!state.deliveryType) {
    state.stage = "delivery_type";
    return { question: "¿Te lo mandamos a domicilio o lo retiras en el local? 🛵\n1. Delivery\n2. Retiro en local\n\nDime cuál te acomoda 😊" };
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
    return { question: "Mándame tu ubicación desde el clip 📎 de WhatsApp (Ubicación → Enviar mi ubicación actual) o pásame un enlace de Google Maps 📍", route: "location" };
  }

  if (state.deliveryType === "pickup" && !state.branchId) {
    const branches = await deps.pickupBranches();
    if (!branches.length) {
      state.stage = "branch";
      return { question: "Justo ahora no tengo locales disponibles para retiro 😔 Prueba con delivery y te lo mandamos" };
    }
    state.pendingChoice = { kind: "branch", options: branches };
    return nextStep(state, deps);
  }

  // Apenas se sabe qué local atiende se revisa el horario: no se le piden más datos a alguien que no va a poder pedir.
  if (state.branchId) {
    const status = await deps.branchStatus(state.branchId);
    if (!status.open) {
      state.stage = "closed";
      return { question: status.message || `${state.branchName || "La sucursal"} está cerrada ahorita 😴 Te esperamos apenas abramos` };
    }
  }

  if (state.deliveryType === "delivery" && !state.deliveryAddress) {
    state.stage = "address";
    return { question: "Escríbeme la dirección con una referencia (calle, número de casa, edificio o piso) para el motorizado 🙌" };
  }

  if (!state.customerName) {
    state.stage = "name";
    return { question: "¿A nombre de quién va el pedido? 😊" };
  }

  if (!state.customerEmail) {
    state.stage = "email";
    return { question: "¿Cuál es tu correo? Ahí te llega la confirmación del pedido 📩" };
  }

  if (!state.paymentMethod) {
    state.stage = "payment";
    const cashLabel = state.deliveryType === "pickup" ? "Efectivo al retirar" : "Efectivo al motorizado";
    return { question: `¿Cómo prefieres pagar?\n1. Tarjeta 💳 (te mando un link de pago)\n2. ${cashLabel} 💵\n\nDime cómo te queda mejor 😊` };
  }

  if (state.billingPreference === "invoice" && !state.billingDocNumber) {
    state.stage = "invoice_doc";
    return { question: "Para la factura, ¿me pasas tu cédula (10 dígitos) o RUC (13 dígitos)? 🧾" };
  }
  if (state.billingPreference === "invoice" && !state.billingName) {
    state.stage = "invoice_name";
    return { question: "¿A nombre de quién va la factura? 🧾" };
  }

  const quote = await deps.quote(state);
  if (!quote) {
    state.stage = "idle";
    return { question: "Uy, no pude calcular tu pedido 🙏 ¿Me repites qué te gustaría pedir?" };
  }
  state.stage = "confirm";
  return { question: formatSummary(state, quote), route: "summary" };
}

export function formatSummary(state: BotState, quote: Quote) {
  const lines = quote.lines.map((line) => `${line.quantity} x ${prettyName(line.name)} ${money(line.unitPrice * line.quantity)}`).join("\n");
  const delivery =
    state.deliveryType === "delivery"
      ? `Delivery a: ${state.deliveryAddress}${state.branchName ? ` (sucursal ${state.branchName})` : ""}`
      : `Retiro en: ${state.branchName}`;
  const payment =
    state.paymentMethod === "card"
      ? "Pago: tarjeta 💳 (te mando el link al confirmar)"
      : state.deliveryType === "delivery"
      ? "Pago: efectivo al motorizado 💵"
      : "Pago: efectivo al retirar 💵";
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
    "Escribe *confirmo* y lo mandamos a la cocina 🙌 O dime qué quieres cambiar",
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
    return { state, reply: `${result.message}\n\n${check.question}`, route: "summary", intent: "conversar", step: state.stage, decision: "R7:error_creando" };
  }
  state.stage = "ordered";
  state.lastOrderNumber = result.orderNumber;
  state.lastPaymentLink = result.paymentLink;
  const reply =
    state.paymentMethod === "card"
      ? `✅ Listo, tu pedido ${result.orderNumber} quedó creado por ${money(result.total)}\n\nPágalo aquí y la cocina se pone de una:\n${result.paymentLink}`
      : state.deliveryType === "delivery"
      ? `✅ Listo, tu pedido ${result.orderNumber} quedó confirmado por ${money(result.total)}\n\nYa lo estamos preparando 🫓 Ten el efectivo listo para el motorizado`
      : `✅ Listo, tu pedido ${result.orderNumber} quedó confirmado por ${money(result.total)}\n\nTe esperamos en ${state.branchName} 🏠 Pagas en efectivo al retirar`;
  return { state, reply, route: "checkout", intent: "orden_creada", step: "ordered", decision: "R7:orden_creada", orderNumber: result.orderNumber, paymentLink: result.paymentLink };
}
