import { addToCart, CartItem, findInCart, MAX_QUANTITY, removeFromCart, setCartQuantity } from "./cart";
import { CatalogProduct, displayCategoryName, findCategory, listCategories, normalizeText, SearchResult, tokenSimilarity, meaningfulTokens } from "./catalog";
import { asksForNearest, distinctiveLabel, negatedPhrase, pickChoice } from "./choice";
import { Extraction, Extractor } from "./extractor";
import {
  claimsPaid,
  detectDeliveryType,
  detectPaymentMethod,
  extractDeclaredName,
  extractDocNumber,
  extractMapsUrl,
  faqTopic,
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
  wantsSchedule,
  wantsNow,
  wantsNowUrgently,
  wantsOtherOpenBranch,
  rejectsClosedOption,
  asksOpeningHours,
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
  /** ¿Está atendiendo ahorita? Se usa para marcar los locales abiertos y ofrecer alternativa. */
  open?: boolean;
  nextOpening?: OpeningWindow | null;
}

/**
 * Próxima ventana de atención de una sucursal, tal como se la dice al cliente. `at` es el instante exacto
 * (ISO con offset) que se guarda en `scheduledFor`; `label` ya viene en palabras ("mañana miércoles 23").
 * Nunca se inventa: sale de los horarios de Mongo (branchOperational.service).
 */
export interface OpeningWindow {
  at: string;
  opensAt: string;
  closesAt: string;
  label: string;
}

/** Sucursal ABIERTA que también cubre la dirección: se ofrece como alternativa a programar. */
export interface OpenAlternative {
  branchId: string;
  branchName: string;
  deliveryFee: number;
  distance: number;
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
  /** El pago con tarjeta de `lastOrderNumber` ya quedó confirmado (por el navegador o por "pagado"). */
  paymentConfirmed?: boolean;
  /** Ubicación compartida antes de cambiar a retiro: si vuelve a delivery se reusa y se recotiza. */
  savedDeliveryLocation?: { coords: { lat: number; lng: number }; mapsUrl: string };
  /** Última intención enviada a BuilderBot; se reusa si BuilderBot reintenta el mismo mensaje. */
  lastIntent?: Intent;
  /**
   * PEDIDO PROGRAMADO. `scheduledFor` es el instante exacto de la próxima apertura de la sucursal
   * (ISO con offset, el mismo formato que manda el checkout web) y `scheduledLabel` cómo se le dijo al
   * cliente ("mañana miércoles 23 a las 07:00"). Se limpian si cambia la sucursal o la modalidad.
   */
  scheduledFor?: string;
  scheduledLabel?: string;
  /** Sucursal que el cliente eligió a mano (la abierta que se le ofreció): manda sobre la más cercana. */
  preferredBranchId?: string;
  /** Otra sucursal ABIERTA que cubre la dirección, de la última cotización. */
  openAlternative?: OpenAlternative | null;
  /** Lo que se le ofreció con la sucursal cerrada, para entender su respuesta ("programar" / "la otra"). */
  closedOffer?: {
    branchId: string;
    branchName?: string;
    nextOpeningAt?: string;
    nextOpeningLabel?: string;
    opensAt?: string;
    closesAt?: string;
    alternative?: OpenAlternative | null;
  } | null;
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
  | {
      covered: true;
      branchId: string;
      branchName: string;
      deliveryFee: number;
      distance: number;
      /** ¿La sucursal que gana está atendiendo ahorita? Gana la más CERCANA que cubra, abierta o cerrada. */
      open?: boolean;
      /** Cuándo vuelve a abrir esa sucursal (para ofrecer programar el pedido). */
      nextOpening?: OpeningWindow | null;
      /** Otra sucursal ABIERTA que también cubre, para ofrecerla si la que gana está cerrada. */
      openAlternative?: OpenAlternative | null;
    }
  | { covered: false; reason: string };

/**
 * Lo que el bot necesita saber del pago de una orden de tarjeta para redactar la respuesta.
 * `outcome` viene del caso de uso compartido (cardPaymentSettlement.service.ts).
 */
export interface PaymentSettlement {
  outcome: "already_paid" | "paid_now" | "pending" | "rejected" | "mismatch" | "not_applicable" | "error";
  /** Total del pedido en DOLARES (como `quote.total`), para repetirselo al cliente. */
  total?: number;
  /** Seguimiento en vivo del motorizado (picker.smrURL), si ya hay reserva. */
  trackingUrl?: string;
  /** Link de pago, para reenviarlo cuando el pago todavia no llega. */
  paymentLink?: string;
  /** "delivery" o "pickup" del pedido ya creado: cambia lo que se le promete al cliente. */
  deliveryType?: "delivery" | "pickup";
  branchName?: string;
}

export interface BotDeps {
  search(query: string, branchId?: string): Promise<SearchResult>;
  catalog(branchId?: string): Promise<CatalogProduct[]>;
  lastOrder(phone: string): Promise<LastOrder | null>;
  resolveMapsUrl(url: string): Promise<{ lat: number; lng: number } | null>;
  /**
   * `preferBranchId` fuerza a que gane ESA sucursal si cubre la dirección: es la que el cliente eligió
   * a mano cuando la más cercana estaba cerrada. Sin ella gana siempre la más cercana que cubra.
   */
  quoteLocation(coords: { lat: number; lng: number }, paymentMethod?: "card" | "cash", preferBranchId?: string): Promise<LocationQuote>;
  pickupBranches(): Promise<BranchOption[]>;
  branchStatus(branchId: string): Promise<{ open: boolean; message?: string; branchName?: string; nextOpening?: OpeningWindow | null }>;
  quote(state: BotState): Promise<Quote | null>;
  createOrder(state: BotState): Promise<{ ok: true; orderNumber: string; total: number; paymentLink?: string } | { ok: false; message: string }>;
  /**
   * El cliente escribio *pagado*: se CONSULTA el estado real del pago en PayPhone y, si esta
   * cobrado, se cierra el pedido (cocina, Picker con CARD, correo). Nunca se le cree al cliente.
   * Es idempotente: el segundo "pagado" devuelve `already_paid` y no duplica nada.
   */
  settlePayment(orderNumber: string): Promise<PaymentSettlement>;
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
  /** Promo activa del negocio ("20% de descuento"), tal como la configuró el local. Vacío = no hay. */
  activePromo?(): Promise<string>;
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
  // "pagado" con la orden ya creada lo resuelve la conversación (verifica el pago en PayPhone): mandarlo
  // a checkout lo dejaba en el corto circuito "Tu pedido ya está registrado" sin verificar nada.
  if (stage === "ordered" && claimsPaid(text)) return "conversation";
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

/**
 * En el paso de dirección: "me llamo Diego Reyes" (o el nombre pelado, cuando la IA lo leyó como nombre) es el
 * NOMBRE del cliente, no la dirección de entrega. El motorizado recibía "Delivery a: me llamo Diego Reyes".
 * Una dirección de verdad ("Victor Emilio Estrada 123 y Guayacanes, casa blanca") nunca cae aquí: siempre le
 * sobran palabras que no son el nombre.
 */
export function isCustomerNameNotAddress(message: string, name?: string) {
  const text = normalizeText(message).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/^(me llamo|mi nombre es|soy|a nombre de|de parte de|el nombre es)\s+\S/.test(text) && !looksLikeAddress(text)) return true;
  if (!name) return false;
  const nameWords = new Set(normalizeText(name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
  if (!nameWords.size) return false;
  // El mensaje es el nombre y nada más ("Diego Reyes").
  return text.split(" ").every((word) => nameWords.has(word));
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

/** Las disculpas de "no te entendí": se quitan si el turno sí aplicó algo (ver finish). */
const APOLOGY = /^(No te entendí bien|Perdón, no te entendí|Perdona, no te cacho|Perdona, sigo sin cacharte)/;

/**
 * Todo lo que un turno puede aplicarle al pedido. Si esta foto cambia durante el turno, el bot entendió algo
 * aunque la regla haya terminado en "no entendido" (ej. el local se elige dentro de finish).
 */
function applicableSnapshot(state: BotState) {
  return JSON.stringify([
    state.cart,
    state.choiceQueue,
    state.deliveryType,
    state.deliveryAddress,
    state.deliveryCoordinates,
    state.branchId,
    state.customerName,
    state.customerEmail,
    state.paymentMethod,
    state.billingPreference,
    state.billingName,
    state.billingDocNumber,
    state.notes,
    // Programar el pedido es aplicar algo: sin esto el bot se disculpaba por un turno que sí entendió.
    state.scheduledFor,
  ]);
}

export async function handleTurn(previous: BotState, input: TurnInput, deps: BotDeps): Promise<TurnResult> {
  const state: BotState = { ...previous, cart: [...(previous.cart || [])], choiceQueue: [...(previous.choiceQueue || [])] };
  let message = String(input.message || "").trim();
  const notes: string[] = [];

  // El nombre del perfil de WhatsApp solo se usa si parece un nombre ("Ana Pérez"), no "~", "💕✨" ni "{name}".
  const senderName = cleanSenderName(input.senderName);
  if (!state.customerName && senderName) state.customerName = titleCaseName(senderName);

  // El menú ya cierra con "Dime qué se te antoja": no se repite la pregunta de "¿qué te gustaría pedir?".
  let skipIdleQuestion = false;
  // Foto de lo que el turno puede aplicar al pedido: si algo de esto cambió, el bot SÍ entendió (ver APOLOGY).
  const appliedBefore = applicableSnapshot(state);
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
    // El bot no se disculpa por un turno que SÍ aplicó algo (tipo de entrega, dirección, local, nombre, correo,
    // pago, productos). En producción se vio "No te entendí bien 🙈" junto con "¿me mandas tu ubicación?" o con la
    // dirección ya guardada: la disculpa sobraba. El local se elige dentro de este mismo finish (pickBranch), por
    // eso la comparación se hace aquí y no donde se arma la disculpa.
    const applied = applicableSnapshot(state) !== appliedBefore;
    if (applied) state.misunderstood = 0;
    const shown = applied ? notes.filter((note) => !APOLOGY.test(note.trim())) : notes;
    let reply = [...shown, question].filter(Boolean).join("\n\n");
    // Nunca una respuesta vacía por haber quitado la disculpa.
    if (!reply) reply = [...notes, question].filter(Boolean).join("\n\n");
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

  // R7 · "PAGADO": el cliente dice que ya pagó su orden de tarjeta. Va ANTES del seguimiento de la orden
  // (orderFollowUp) y del reinicio a pedido nuevo: si no, "listo pagué" se lo comía uno de esos dos y el
  // cliente recibía la frase de siempre con el link, sin que nadie verifique el pago.
  // El bot NO le cree: consulta el estado real en PayPhone (deps.settlePayment) y recién ahí responde.
  // Un reclamo con pedido de persona ("ya pagué pero quiero hablar con alguien") sigue yendo a R2.
  if (state.stage === "ordered" && state.lastOrderNumber && claimsPaid(message) && !wantsHuman(message)) {
    const settlement = await deps.settlePayment(state.lastOrderNumber).catch(() => ({ outcome: "error" as const }));
    const paid = settlement.outcome === "paid_now" || settlement.outcome === "already_paid";
    if (paid) state.paymentConfirmed = true;
    return {
      state,
      reply: paymentClaimReply(state, settlement, deps),
      // La orden ya existe y el cobro ya está cerrado o pendiente en PayPhone: no hay nada que cobrar de nuevo.
      route: "conversation",
      intent: paid ? "orden_creada" : "conversar",
      step: state.stage,
      decision: `R7:pago_${settlement.outcome}`,
      orderNumber: state.lastOrderNumber,
      paymentLink: state.lastPaymentLink,
    };
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
      paymentConfirmed: undefined,
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

  // R4 · "mejor que sean 3" mientras se elige el producto: es una CANTIDAD, no un "no te entendí". Se guarda para
  // lo que se está eligiendo (antes se respondía "Perdona, no te cacho 🙈" y el carrito quedaba en 1).
  if (state.pendingChoice?.kind === "product") {
    const cantidad = quantityOnlyRequest(message);
    if (cantidad) {
      state.pendingChoice = { ...state.pendingChoice, quantity: cantidad };
      notes.push(`Dale, que sean ${cantidad} 👍`);
      return finish("R4:cantidad_en_eleccion", "choice");
    }
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
    clearSchedule(state);
    notes.push("Listo, borré tu pedido 🧹 Empezamos de cero");
    return finish("R6:vaciar_carrito");
  }

  // Local cerrado: el cliente elige entre programar para la próxima apertura o irse con una sucursal
  // abierta. Va ANTES de la confirmación y del saludo porque "dale", "sí" o "ahora" responden a ESA
  // pregunta: si no, la regla de confirmar se los comía y el pedido no avanzaba.
  if (state.stage === "closed") {
    const decided = await handleClosedReply(state, message, deps, notes);
    if (decided) return finish(`R10:${decided}`);
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
    // Con el local cerrado el pedido no puede salir hasta que elija: repetir la pregunta tal cual
    // dejaba al cliente dando vueltas sin entender qué le faltaba.
    if (state.stage === "closed") {
      notes.push("Para enviarlo primero dime cómo lo quieres 👇");
      return finish("R7:falta_elegir_horario");
    }
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

  // El cliente ESCRIBE la dirección cuando el bot le pidió el pin ("Victor Emilio Estrada 123 y Guayacanes, casa
  // blanca de dos pisos"). El bot SÍ entendió: se guarda como referencia de entrega y se vuelve a pedir el pin sin
  // disculparse (antes respondía "No te entendí bien 🙈"). Las coordenadas siguen siendo obligatorias: sin ellas no
  // se puede cotizar el envío ni saber qué local atiende.
  if (
    state.stage === "location" &&
    state.deliveryType === "delivery" &&
    !state.deliveryCoordinates &&
    !state.deliveryAddress &&
    !extractMapsUrl(message) &&
    looksLikeAddress(message) &&
    meaningfulTokens(message).length >= 4
  ) {
    // "2 colas bien frias" también trae dígitos: si el texto es del menú, no es una dirección.
    const asProduct = await deps.search(message, state.branchId);
    if (asProduct.kind === "none" && !asProduct.suggestions.length) {
      state.deliveryAddress = message.slice(0, 200);
      notes.push(`Anoté la dirección: ${state.deliveryAddress} ✅\nPara cotizarte el envío igual necesito el pin 📍`);
      return finish("R10:direccion_escrita", "location");
    }
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

  // R10 · Respuesta corta y directa a la pregunta del paso actual ("1", "efectivo", "Ana Pérez", la cédula).
  if (await applyDirectAnswer(state, message, deps, notes)) return finish("R10:respuesta_al_paso");

  // R9 · Preguntas frecuentes del negocio (horarios, direcciones, envío, promos, factura, pagos). Solo si el
  // mensaje ES una pregunta: "una humita con factura" es un pedido, "¿hacen factura?" no. Se responde con
  // datos reales (sucursales de Mongo, promo configurada), nunca con la IA.
  const FAQ_SKIP_STEPS: Stage[] = ["invoice_doc", "invoice_name", "name", "email", "address"];
  if (!state.pendingChoice && !FAQ_SKIP_STEPS.includes(state.stage) && isQuestion(message)) {
    const faq = await answerFaq(state, message, deps);
    if (faq) {
      notes.push(faq);
      skipIdleQuestion = state.stage === "idle" && !state.cart.length;
      state.misunderstood = 0;
      return finish("R9:pregunta_frecuente");
    }
  }

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
    if (isCustomerNameNotAddress(message, extraction.customerName || state.customerName)) {
      // "me llamo Diego Reyes" en el paso de la dirección: es su nombre (ya quedó anotado), no la dirección de
      // entrega. Antes se guardaba crudo y el resumen decía "Delivery a: me llamo Diego Reyes".
      notes.push("Ese es tu nombre 😊 Ahora sí, la dirección de entrega 👇");
    } else if (!isNotAnAddress(message)) {
      state.deliveryAddress = message.slice(0, 200);
      state.previousDeliveryAddress = undefined;
      notes.push(`Anoté la dirección: ${state.deliveryAddress} ✅`);
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
    // Si ya se dijo algo ("no tenemos X en el menú"), no se apila otra disculpa encima: suena a bot roto.
    const yaSeDisculpo = notes.some((nota) => /no tenemos|no encontr|no te entend/i.test(nota));
    notes.push(state.cart.length && state.stage !== "closed" && !yaSeDisculpo ? "No te entendí bien 🙈 ¿Me lo repites?" : "");
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

/** Palabras que acompañan a una cantidad ("mejor que sean 3") y que no nombran ningún producto. */
const QUANTITY_CONTEXT_WORDS = new Set([
  "mejor", "que", "q", "sean", "sea", "seran", "son", "serian", "seria", "ser", "ponme", "pon", "quiero", "dame", "hazlo",
  "haz", "hazme", "anota", "anotame", "en", "total", "ahora", "porfa", "porfavor", "favor", "gracias", "y", "de", "a", "me",
  "no", "si", "mas", "entonces", "ya", "pero",
]);

const WORD_NUMBERS: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };

/** Palabras que dejan claro que el número es una CANTIDAD y no la opción de la lista ("que sean 3" vs "3"). */
const QUANTITY_MARKERS = new Set(["sean", "sea", "seran", "son", "serian", "seria", "total"]);

/**
 * "mejor que sean 3": el mensaje SOLO cambia la cantidad (no nombra productos ni elige de la lista). Con una
 * elección abierta el bot respondía "Perdona, no te cacho 🙈" y la cantidad se perdía; un número suelto ("3") sigue
 * siendo la opción 3 de la lista.
 */
export function quantityOnlyRequest(message: string): number | null {
  const words = normalizeText(message).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  let quantity: number | null = null;
  for (const word of words) {
    const value = /^\d{1,2}$/.test(word) ? Number(word) : WORD_NUMBERS[word] || 0;
    if (value) {
      if (quantity !== null) return null;
      quantity = value;
      continue;
    }
    if (!QUANTITY_CONTEXT_WORDS.has(word)) return null;
  }
  if (!quantity || quantity < 1 || quantity > 20) return null;
  return words.some((word) => QUANTITY_MARKERS.has(word)) ? quantity : null;
}

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
  const pending = state.choiceQueue.map((item) => cleanQueryLabel(item.query)).filter(Boolean);
  return pending.length ? `\n\nY me falta preguntarte por: ${pending.join(", ")} 👇` : "";
}

/**
 * Adjetivos de CÓMO lo quiere el cliente, no de QUÉ producto es: no se repiten al preguntar
 * ("¿Cuál colita bien fria quieres?" sonaba a que el bot se burlaba). Ver cleanQueryLabel.
 */
const PREFERENCE_WORDS = new Set([
  "bien", "muy", "super", "bn", "porfa", "porfavor", "favor",
  "fria", "frio", "frias", "frios", "friita", "friito", "heladita", "helado", "helada", "heladito", "fresca", "fresco",
  "caliente", "calientita", "calientito", "calentita", "calentito", "tibia", "tibio",
  "grande", "grandes", "pequena", "pequeno", "chiquita", "chiquito", "chica", "chico",
]);

/**
 * El nombre del producto tal como se le muestra al cliente en una pregunta: sin los adjetivos de cómo lo quiere
 * ("una colita bien fria" → "colita"). Si al quitarlos no queda nada, se deja el texto original.
 */
export function cleanQueryLabel(query: string) {
  const words = String(query || "").trim().split(/\s+/).filter(Boolean);
  const kept = words.filter((word) => !PREFERENCE_WORDS.has(normalizeText(word)));
  return kept.length ? kept.join(" ") : String(query || "").trim();
}

/**
 * ¿Las dos consultas hablan del MISMO producto? Sirve para no anotar dos veces lo que el cliente dijo una sola vez
 * ("colita" vs "colita bien fria"): se quitan los adjetivos de cómo lo quiere y los tokens con significado tienen
 * que ser LOS MISMOS.
 *
 * Ojo: no basta con que uno contenga al otro. "una cola y una cola zero" son DOS bebidas distintas ("cola" ⊂
 * "cola zero") y con la inclusión el segundo producto se descartaba en silencio: el cliente pedía dos y le llegaba
 * una sola, sin aviso.
 */
export function sameProductQuery(a: string, b: string) {
  const left = meaningfulTokens(cleanQueryLabel(a));
  const right = meaningfulTokens(cleanQueryLabel(b));
  if (!left.length || !right.length) return false;
  const key = (tokens: string[]) => [...new Set(tokens)].sort().join(" ");
  return key(left) === key(right);
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
    notes.push(`Mmm, no encontré "${cleanQueryLabel(query)}" tal cual 🙈`);
    state.pendingChoice = { kind: "product", query, quantity, options: result.suggestions.map(toOption) };
    return true;
  }
  notes.push(`Uy, no tenemos "${cleanQueryLabel(query)}" en el menú 🙈`);
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
  // Una PREGUNTA no elige nada: "¿puedo pagar mitad en efectivo y mitad con tarjeta?" dejaba el pedido en
  // tarjeta, y "¿hacen delivery a Samborondón?" lo pasaba a domicilio. Salvo en el paso donde el bot
  // justo pregunta eso ("¿cómo prefieres pagar?" → "¿con tarjeta?" sí elige).
  if (isQuestion(message)) {
    if (state.stage !== "payment") extraction.paymentMethod = undefined;
    if (state.stage !== "delivery_type") extraction.deliveryType = undefined;
  }
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
      // El cliente nombró el MISMO producto dos veces en un mensaje ("una colita bien fria": la IA devuelve
      // "colita" y "colita bien fria"). Ya se le está preguntando por él: no se anota otra vez, o el bot decía
      // "Apenas cerremos esto te pregunto por eso" y preguntaba por eso mismo en el mismo mensaje.
      if (held.kind === "product" && sameProductQuery(held.query, item.query)) continue;
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
        notes.push(`Anotado lo de "${cleanQueryLabel(item.query)}" 📝 Apenas cerremos esto te pregunto por eso`);
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
  // Una pregunta del negocio no es la respuesta al paso: "¿hacen delivery a Samborondón?" en el paso de
  // entrega pasaba el pedido a domicilio sin que el cliente lo eligiera. La contesta R9 y se vuelve a preguntar.
  if (isQuestion(message) && faqTopic(message)) return false;
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
  // Cambiar de modalidad cambia (o borra) la sucursal: lo programado para la anterior ya no vale.
  if (state.deliveryType !== type) clearSchedule(state);
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
  { silent = false, keepPreferred = false }: { silent?: boolean; keepPreferred?: boolean } = {}
) {
  // Una ubicación NUEVA vuelve a decidir qué sucursal atiende: la elección manual anterior no se arrastra.
  if (!keepPreferred) state.preferredBranchId = undefined;
  const quote = await deps.quoteLocation(coords, state.paymentMethod, state.preferredBranchId);
  if (!quote.covered) {
    Object.assign(state, { deliveryCoordinates: undefined, deliveryGoogleMapsUrl: undefined, deliveryFee: undefined, branchId: undefined, branchName: undefined });
    clearSchedule(state);
    state.openAlternative = null;
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
    openAlternative: quote.openAlternative ?? null,
  });
  // Cambiar de sucursal invalida lo programado: cada local tiene su propio horario.
  if (branchChanged) clearSchedule(state);
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
  const covered = await applyLocation(state, state.deliveryCoordinates, state.deliveryGoogleMapsUrl || "", deps, notes, { silent: true, keepPreferred: true });
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
  const question = choice.kind === "branch" ? "¿En qué local lo retiras?" : choice.label ? `Opciones de ${choice.label}` : `¿Cuál ${cleanQueryLabel(choice.query)} quieres?`;
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

/** ¿El pedido ya quedó programado para la sucursal que lo atiende? Entonces el horario no lo frena. */
function isScheduledForBranch(state: BotState) {
  return Boolean(state.scheduledFor && state.branchId && state.closedOffer?.branchId === state.branchId);
}

/**
 * LO PROGRAMADO CADUCA SOLO.
 *
 * Una sesión de anoche puede quedar programada para hoy a las 07:00 y el cliente escribir "confirmo"
 * a las 10:00. Esa hora YA PASÓ: la orden no se puede crear ("Esa hora ya pasó 🙈") y, como el pedido
 * seguía marcado como programado, el chequeo de horario se saltaba y el resumen volvía a mostrar
 * "🗓️ Programado para…" — cada "confirmo" repetía el mismo error, sin salida.
 *
 * Al caducar se borra la programación y el pedido vuelve al camino normal: si el local está ABIERTO
 * sigue como pedido inmediato; si está cerrado, el chequeo de horario de abajo vuelve a ofrecer
 * programarlo para la PRÓXIMA apertura.
 */
function expireStaleSchedule(state: BotState) {
  if (!state.scheduledFor) return;
  const at = new Date(state.scheduledFor).getTime();
  if (Number.isNaN(at) || at > Date.now()) return;
  clearSchedule(state);
}

/**
 * Sucursal cerrada: se dice el horario REAL y se ofrecen los DOS caminos, sin decidir por el cliente.
 *   a) programar el pedido para la próxima apertura;
 *   b) si hay otra sucursal ABIERTA que lo pueda atender, irse con esa (diciendo su envío si cambia).
 * Los horarios y los precios salen de `deps` (Mongo / Picker): aquí no se inventa ninguno.
 */
async function closedQuestion(
  state: BotState,
  status: { open: boolean; message?: string; branchName?: string; nextOpening?: OpeningWindow | null },
  deps: BotDeps
): Promise<string> {
  const name = status.branchName || state.branchName || "La sucursal";
  const next = status.nextOpening || null;
  const alternative = state.deliveryType === "delivery" ? state.openAlternative || null : null;
  const openBranches =
    state.deliveryType === "pickup" ? (await deps.pickupBranches()).filter((branch) => branch.open && branch.branchId !== state.branchId) : [];

  state.closedOffer = {
    branchId: state.branchId!,
    branchName: name,
    nextOpeningAt: next?.at,
    nextOpeningLabel: next?.label,
    opensAt: next?.opensAt,
    closesAt: next?.closesAt,
    alternative,
  };

  // Sin horario configurado y sin alternativa no hay nada que ofrecer: queda el aviso de siempre.
  if (!next && !alternative && !openBranches.length) {
    return status.message || `${name} está cerrada ahorita 😴 Te esperamos apenas abramos`;
  }

  const head = next
    ? `${name} está cerrada ahorita 😴 Atiende de ${next.opensAt} a ${next.closesAt}, y vuelve a abrir ${next.label} a las ${next.opensAt}`
    : `${name} está cerrada ahorita 😴`;

  const options: string[] = [];
  const hints: string[] = [];
  if (next) {
    options.push(`${options.length + 1}. Te lo *programo* para ${next.label} a las ${next.opensAt} 🗓️`);
    hints.push("*programar*");
  }
  if (alternative) {
    const feeNote =
      state.deliveryFee != null && Math.round(alternative.deliveryFee * 100) !== Math.round(state.deliveryFee * 100)
        ? ` — ojo que el envío desde ahí cuesta ${money(alternative.deliveryFee)}, no ${money(state.deliveryFee)}`
        : ` — el envío te cuesta ${money(alternative.deliveryFee)}`;
    options.push(`${options.length + 1}. Te lo manda *${alternative.branchName}*, que sí está abierta ahorita 🛵${feeNote}`);
    hints.push("*la otra*");
  }
  if (openBranches.length) {
    options.push(`${options.length + 1}. Lo retiras en otro local abierto ahorita: ${openBranches.map((branch) => branch.name).join(", ")} 🏠`);
    hints.push("*otro local*");
  }

  return `${head}\n\n¿Cómo prefieres?\n${options.join("\n")}\n\nDime ${hints.join(" o ")} y seguimos 🙌`;
}

/**
 * Respuesta del cliente con la sucursal cerrada. Reglas primero: "prográmalo", "dale para mañana",
 * "mejor ahora", "que me lo mande la otra", "¿a qué hora abren?", o el número de la opción.
 * Devuelve el nombre de la decisión, o null si el mensaje no hablaba de esto.
 */
/**
 * Responde una PREGUNTA FRECUENTE con datos reales (sucursales de Mongo, promo del negocio). Devuelve el
 * texto o "" si no hay nada que decir. El bot toma pedidos, pero antes de pedir la gente pregunta horarios,
 * direcciones o si hacen factura: contestarle "¿qué te gustaría pedir?" era dejarlo hablando solo.
 */
async function answerFaq(state: BotState, message: string, deps: BotDeps): Promise<string> {
  const topic = faqTopic(message);
  if (!topic) return "";
  const branches = await deps.pickupBranches().catch(() => [] as BranchOption[]);
  const named = matchBranchInMessage(message, branches);
  const hours = (branch?: BranchOption) => {
    const window = branch?.nextOpening;
    if (!window) return "";
    return `${branch?.name}: atiende de ${window.opensAt} a ${window.closesAt}${branch?.open ? " · abierto ahorita ✅" : ` · cerrado, abre ${window.label} a las ${window.opensAt}`}`;
  };

  if (topic === "horario") {
    const chosen = named || branches.find((branch) => branch.branchId === state.branchId);
    if (chosen) return hours(chosen) || `${chosen.name} no tiene horario cargado, escríbenos al ${deps.supportPhone} 🙏`;
    const abiertos = branches.filter((branch) => branch.open);
    if (!abiertos.length) {
      const proxima = branches.map(hours).filter(Boolean).slice(0, 3);
      return `Ahorita están todas cerradas 😴\n${proxima.join("\n")}\n\nSi quieres te tomo el pedido igual y lo dejamos programado 🗓️`;
    }
    return `Abiertos ahorita 🕒\n${abiertos.map((branch) => `• ${branch.name} (hasta ${branch.nextOpening?.closesAt || "el cierre"})`).join("\n")}\n\n¿Te tomo el pedido?`;
  }

  if (topic === "direccion") {
    const chosen = named || branches.find((branch) => branch.branchId === state.branchId);
    if (chosen?.address) return `${chosen.name} queda en ${chosen.address} 📍${chosen.open ? " (abierto ahorita ✅)" : ""}`;
    if (!branches.length) return "";
    return `Estos son nuestros locales 🏠\n${branches.map((branch) => `• ${branch.name}${branch.address ? ` · ${branch.address}` : ""}`).join("\n")}`;
  }

  if (topic === "envio") {
    if (state.deliveryFee != null && state.branchName) return `El envío desde ${state.branchName} te cuesta ${money(state.deliveryFee)} 🛵`;
    return "El envío depende de qué tan lejos estés del local 🛵 Mándame tu ubicación desde el clip 📎 y te digo el precio exacto";
  }

  if (topic === "promos") {
    const promo = deps.activePromo ? await deps.activePromo().catch(() => "") : "";
    if (promo) return `Sí 🎉 Ahorita tenemos ${promo}. Se aplica sola al cerrar el pedido`;
    return `Ahorita no tenemos promos activas 🙂 Mira el menú con fotos aquí: ${deps.menuUrl}`;
  }

  if (topic === "cobertura") {
    return "Llegamos a buena parte de Guayaquil 🛵 Mándame tu ubicación desde el clip 📎 y te digo al toque si llegamos y cuánto sale el envío 📍";
  }
  if (topic === "factura") return "Sí, hacemos factura 🧾 Al cerrar el pedido te pido la cédula o el RUC y el nombre";
  if (topic === "pagos") return "Puedes pagar con tarjeta 💳 (te mando un link) o en efectivo 💵 al recibirlo. Transferencias por aquí no recibimos 🙏";
  if (topic === "llamada") return `Para llamadas escríbele al ${deps.supportPhone} 👋 Por aquí yo te tomo el pedido cuando quieras`;
  return "";
}

async function handleClosedReply(state: BotState, message: string, deps: BotDeps, notes: string[]): Promise<string | null> {
  const offer = state.closedOffer;
  if (!offer || offer.branchId !== state.branchId) return null;
  const text = normalizeText(message);
  const numbered = /^#?([1-3])$/.test(text) ? Number(text.replace("#", "")) : 0;
  // Las opciones se numeran en el mismo orden en que se imprimieron (ver closedQuestion).
  let index = 0;
  const scheduleNumber = offer.nextOpeningAt ? (index += 1) : 0;
  const alternativeNumber = offer.alternative ? (index += 1) : 0;
  const otherBranchNumber = state.deliveryType === "pickup" ? (index += 1) : 0;

  // "¿a qué hora abren?": el bot ya lo dijo, se repite el aviso sin contarlo como "no entendido".
  if (asksOpeningHours(message)) return "horario";

  // PROGRAMAR LE GANA A "AHORITA". El cliente puede decir las dos cosas en un mismo mensaje
  // ("ahorita no puedo, prográmalo", "hoy no, mejor mañana"): si pide programar EXPLÍCITAMENTE,
  // eso manda. Antes el "ahorita/hoy" (aunque viniera negado) mudaba el pedido a la otra sucursal
  // y le cambiaba el envío sin que él la hubiera elegido.
  // …salvo cuando la urgencia es explícita ("no puedo esperar hasta mañana"): ahí el "mañana"
  // se nombra para rechazarlo, no para programar.
  const urgent = wantsNowUrgently(message);
  const asksSchedule = !urgent && wantsSchedule(message);
  const asksNow = !asksSchedule && wantsNow(message);
  const schedules =
    Boolean(offer.nextOpeningAt) &&
    (asksSchedule ||
      // "dale" / "sí" cuando programar es lo ÚNICO que se ofreció (no hay otra sucursal abierta que cubra):
      // en retiro el "otro local" no se imprime como opción, así que un sí es un sí a programar.
      (!asksNow && ((scheduleNumber > 0 && numbered === scheduleNumber) || (isYes(message) && !offer.alternative))));
  if (schedules) {
    state.scheduledFor = offer.nextOpeningAt;
    state.scheduledLabel = `${offer.nextOpeningLabel} a las ${offer.opensAt}`;
    notes.push(`¡Listo! Tu pedido queda programado para ${state.scheduledLabel} 🗓️ Seguimos con los datos y te lo dejo listo 👇`);
    return "programar";
  }

  const alternative = offer.alternative;
  const picksAlternative =
    alternative &&
    (wantsOtherOpenBranch(message) ||
      asksNow ||
      (alternativeNumber > 0 && numbered === alternativeNumber) ||
      // Nombrar la sucursal para DESCARTARLA ("Avalon no") no la elige (igual que al elegir local en finish).
      Boolean(!negatedPhrase(message) && matchBranchInMessage(message, [{ branchId: alternative.branchId, name: alternative.branchName }])));
  if (picksAlternative && alternative && state.deliveryCoordinates) {
    const before = state.deliveryFee;
    state.preferredBranchId = alternative.branchId;
    clearSchedule(state);
    await applyLocation(state, state.deliveryCoordinates, state.deliveryGoogleMapsUrl || "", deps, notes, { silent: true, keepPreferred: true });
    if (state.branchId === alternative.branchId) {
      const feeChanged = before != null && state.deliveryFee != null && Math.round(before * 100) !== Math.round(state.deliveryFee * 100);
      notes.push(
        `Dale, te atiende ${state.branchName} que está abierta ahorita 🛵 El envío te cuesta ${money(state.deliveryFee || 0)}${
          feeChanged ? ` (te había dicho ${money(before!)} desde ${offer.branchName})` : ""
        }`
      );
    } else {
      // La alternativa dejó de cubrir la dirección entre un mensaje y otro: se vuelve a mostrar el aviso.
      state.preferredBranchId = undefined;
      notes.push("Uy, esa sucursal ya no te puede atender ahorita 😔");
    }
    return "otra_sucursal";
  }

  // Retiro: "otro local" / el nombre de otro local vuelve a ofrecer la lista (marcando cuáles están abiertos).
  if (state.deliveryType === "pickup") {
    const named = negatedPhrase(message) ? null : matchBranchInMessage(message, await deps.pickupBranches());
    const wantsOther =
      wantsOtherOpenBranch(message) ||
      asksNow ||
      (otherBranchNumber > 0 && numbered === otherBranchNumber) ||
      /\b(otro|otra) (local|sucursal|lugar)\b|\bcambi\w* (de |el )?(local|sucursal)\b/.test(text) ||
      detectDeliveryType(message) === "pickup";
    if ((named && named.branchId !== state.branchId) || wantsOther) {
      Object.assign(state, { branchId: undefined, branchName: undefined, pendingChoice: null });
      clearSchedule(state);
      return "cambiar_local";
    }
  }

  // Dijo que NO a una de las opciones ("la otra no, gracias", "ahorita no"): no eligió nada, pero
  // tampoco habló de productos. Se repite la pregunta del local cerrado. Sin esto el mensaje llegaba
  // a la extracción y "no quiero la otra" se leía como quitar un producto (vaciaba el carrito).
  if (rejectsClosedOption(message)) {
    notes.push(`Dale, entonces seguimos con ${offer.branchName} 🙌`);
    return "sigue_cerrada";
  }

  return null;
}

/** Lo programado vale para UNA sucursal y su horario: si cambia el local o la modalidad, se borra. */
function clearSchedule(state: BotState) {
  state.scheduledFor = undefined;
  state.scheduledLabel = undefined;
  state.closedOffer = null;
}

async function pickBranch(state: BotState, branch: BranchOption, deps: BotDeps, notes: string[]) {
  state.pendingChoice = null;
  if (state.branchId !== branch.branchId) clearSchedule(state);
  state.branchId = branch.branchId;
  state.branchName = branch.name;
  notes.push(`¡Perfecto! Lo retiras en ${branch.name} 🏠`);
  await revalidateCartForBranch(state, deps, notes);
}

/** Respuesta a lo que el cliente escribe DESPUÉS de crear la orden, si habla de esa orden. */
/** Con la orden ya creada: "confirmo", "sí", "claro", "de una", "si está bien así" repiten la confirmación. */
function confirmsPlacedOrder(message: string) {
  // "listo pagué" / "ya está pagado" NO son una reconfirmación del pedido: son un reclamo de pago
  // que verifica la regla R7:pago_* contra PayPhone. Sin esta exclusión caían en R7:ya_confirmado.
  if (claimsPaid(message)) return false;
  return wantsConfirm(message) || classifyConfirmReply(message) === "confirm";
}

/**
 * Respuesta al "pagado" del cliente, SEGÚN LO QUE DIJO PAYPHONE (nunca según lo que dijo el cliente).
 *
 *   paid_now / already_paid → total, "ya está en cocina" y el aviso del motorizado (+ seguimiento si ya hay).
 *   pending                 → "todavía no nos llega", que reintente, y se REENVÍA el link.
 *   rejected / mismatch     → se dice claro y se reenvía el link (mismatch además manda a soporte).
 *   error / not_applicable  → se pide reintentar; nada se da por pagado.
 */
function paymentClaimReply(state: BotState, settlement: PaymentSettlement, deps: BotDeps): string {
  const order = state.lastOrderNumber!;
  const link = state.lastPaymentLink;
  const total = typeof settlement.total === "number" ? ` por ${money(settlement.total)}` : "";
  const deliveryType = settlement.deliveryType || state.deliveryType;
  const branchName = settlement.branchName || state.branchName;
  const retry = `Si ya pagaste, dame un momentito y escríbeme *pagado* otra vez 🙏`;

  if (settlement.outcome === "paid_now" || settlement.outcome === "already_paid") {
    const head =
      settlement.outcome === "already_paid"
        ? `✅ Tu pago del pedido ${order} ya está confirmado${total}`
        : `✅ ¡Pago confirmado! Tu pedido ${order} quedó pagado${total}`;
    const body =
      deliveryType === "pickup"
        ? `Ya está en cocina 🫓 Te aviso en cuanto esté listo para retirar${branchName ? ` en ${branchName}` : ""}`
        : `Ya está en cocina 🫓 Te aviso cuando salga el motorizado 🛵`;
    const tracking = settlement.trackingUrl ? `\n\nSigue a tu motorizado en vivo aquí 🛵\n${settlement.trackingUrl}` : "";
    return `${head}\n\n${body}${tracking}\n\nEscribe *mi pedido* cuando quieras para ver cómo va`;
  }

  if (settlement.outcome === "pending") {
    return `Todavía no nos llega el pago de tu pedido ${order} 💳 A veces se demora un momentito en aparecer.${
      link ? `\n\nSi aún no lo completaste, págalo aquí:\n${link}` : ""
    }\n\n${retry}`;
  }

  if (settlement.outcome === "rejected") {
    return `Uy, el pago de tu pedido ${order} no se completó ❌ El banco no lo aprobó.${
      link ? `\n\nIntenta de nuevo aquí:\n${link}` : ""
    }\n\nSi te vuelve a fallar, escríbele al ${deps.supportPhone} y te ayudan`;
  }

  if (settlement.outcome === "mismatch") {
    return `Me llega un pago que no coincide con el total de tu pedido ${order} 😕 Para no cobrarte mal, escríbele al ${deps.supportPhone} y lo revisan enseguida`;
  }

  return `No pude verificar tu pago ahorita 🙏${link ? `\n\nSi aún no lo completaste, págalo aquí:\n${link}` : ""}\n\n${retry}`;
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
    return `Tu pedido ${order} ya está registrado ✅${link ? `\nPuedes pagarlo aquí: ${link}\n\nCuando lo hayas pagado, escríbeme *pagado* y verifico el pago ✅` : ""}`;
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
      const ask = choice.label ? `Estas son nuestras opciones de ${choice.label} 😋` : `¿Cuál ${cleanQueryLabel(choice.query)} quieres?`;
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
    // Se marca cuál está atendiendo ahorita para que pueda elegir uno abierto en vez de programar.
    const anyStatus = choice.options.some((option) => option.open !== undefined);
    const list = anyStatus
      ? choice.options
          .map((option, index) => `${index + 1}. ${prettyName(option.name)}${option.address ? ` · ${option.address}` : ""}${option.open ? " · abierto ahora ✅" : " · cerrado 😴"}`)
          .join("\n")
      : optionsList(choice.options);
    return { question: `¿En qué local lo retiras? 🏠\n${list}\n\nDime cuál te queda mejor 😊`, route: "choice" };
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

  // Apenas se sabe qué local atiende se revisa el horario. Si está cerrado NO se corta la conversación:
  // se le ofrece programar el pedido para la próxima apertura o irse con otra sucursal abierta, y el
  // cliente decide. Un pedido ya programado para ESA sucursal sigue su curso normal.
  expireStaleSchedule(state);
  if (state.branchId && !isScheduledForBranch(state)) {
    const status = await deps.branchStatus(state.branchId);
    if (!status.open) {
      clearSchedule(state);
      state.stage = "closed";
      return { question: await closedQuestion(state, status, deps) };
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
      // Pedido programado: se dice para cuándo queda, con las mismas palabras que se usaron al ofrecerlo.
      state.scheduledFor && state.scheduledLabel && `🗓️ Programado para ${state.scheduledLabel}`,
      payment,
      `A nombre de: ${state.customerName} · ${state.customerEmail}`,
      state.billingPreference === "invoice" && `Factura: ${state.billingName} · ${state.billingDocNumber}`,
      state.notes && `Indicaciones: ${state.notes}`
    ),
    cashWarning.trim(),
    state.scheduledFor && state.scheduledLabel
      ? `Escribe *confirmo* y te lo dejo agendado para ${state.scheduledLabel} 🙌 O dime qué quieres cambiar`
      : "Escribe *confirmo* y lo mandamos a la cocina 🙌 O dime qué quieres cambiar",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * PALABRA CLAVE DEL NEGOCIO: el dueño no quiere cobrar dentro del chat. Manda el link, y el cliente
 * avisa escribiendo *pagado*; ahí el bot consulta PayPhone de verdad (ver la regla R7:pago_*).
 */
const PAID_KEYWORD_HINT = "Cuando lo hayas pagado, escríbeme *pagado* y verifico el pago al instante ✅";

/** Efectivo con delivery: el motorizado cobra el TOTAL (subtotal + envío). Se le dice cuánto. */
function cashToDriver(total: number) {
  return `Págale ${money(total)} en efectivo al motorizado 💵`;
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
  // Un pedido programado NO se está preparando ahora: la cocina lo toma cuando abre el local.
  const scheduled = state.scheduledFor && state.scheduledLabel ? `🗓️ Programado para ${state.scheduledLabel}` : "";
  const reply = scheduled
    ? state.paymentMethod === "card"
      ? `✅ Listo, tu pedido ${result.orderNumber} quedó por ${money(result.total)}\n${scheduled}\n\nPágalo aquí y queda todo listo para esa hora:\n${result.paymentLink}\n\n${PAID_KEYWORD_HINT}`
      : state.deliveryType === "delivery"
      ? `✅ Listo, tu pedido ${result.orderNumber} quedó confirmado por ${money(result.total)}\n${scheduled}\n\nLo preparamos apenas abra ${state.branchName} y te lo mandamos 🛵 ${cashToDriver(result.total)}`
      : `✅ Listo, tu pedido ${result.orderNumber} quedó confirmado por ${money(result.total)}\n${scheduled}\n\nTe esperamos en ${state.branchName} a esa hora 🏠 Pagas ${money(result.total)} en efectivo al retirar`
    : state.paymentMethod === "card"
    ? `✅ Listo, tu pedido ${result.orderNumber} quedó creado por ${money(result.total)}\n\nPágalo aquí y la cocina se pone de una:\n${result.paymentLink}\n\n${PAID_KEYWORD_HINT}`
    : state.deliveryType === "delivery"
    ? `✅ Listo, tu pedido ${result.orderNumber} quedó confirmado por ${money(result.total)}\n\nYa lo estamos preparando 🫓 ${cashToDriver(result.total)}`
    : `✅ Listo, tu pedido ${result.orderNumber} quedó confirmado por ${money(result.total)}\n\nTe esperamos en ${state.branchName} 🏠 Pagas ${money(result.total)} en efectivo al retirar`;
  return { state, reply, route: "checkout", intent: "orden_creada", step: "ordered", decision: "R7:orden_creada", orderNumber: result.orderNumber, paymentLink: result.paymentLink };
}
