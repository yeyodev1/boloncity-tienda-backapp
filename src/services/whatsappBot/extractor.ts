import axios from "axios";
import { env } from "../../config/env";
import { meaningfulTokens, tokenSimilarity } from "./catalog";
import {
  additionAfterRemoval,
  detectDeliveryType,
  detectPaymentMethod,
  extractDeclaredName,
  extractDocNumber,
  extractEmail,
  parseQuantityChange,
  parseRemoval,
  splitItemPhrases,
  wantsFinalConsumer,
  wantsInvoice,
} from "./intents";

/**
 * Qué dijo el cliente, en datos. La IA NO escribe la respuesta ni ve el catálogo:
 * solo traduce el mensaje a este JSON. Productos, precios y el siguiente paso los
 * decide el router con datos reales.
 */
export interface Extraction {
  items: Array<{ query: string; quantity: number }>;
  remove: string[];
  setQuantity: Array<{ query: string; quantity: number }>;
  customerName?: string;
  customerEmail?: string;
  deliveryType?: "delivery" | "pickup";
  paymentMethod?: "card" | "cash" | "transfer";
  wantsInvoice?: boolean;
  billingDocNumber?: string;
  billingName?: string;
  billingAddress?: string;
  notes?: string;
  source: "ai" | "heuristic";
}

export interface ExtractionContext {
  lastBotQuestion: string;
  cartNames: string[];
}

export type Extractor = (message: string, context: ExtractionContext) => Promise<Extraction>;

/** Frases de datos que se quitan del mensaje antes de buscar productos en lo que queda. */
const DATA_PHRASES = [
  /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi,
  /\b(?:me llamo|mi nombre es)\s+[a-záéíóúñ]+(?:\s+[a-záéíóúñ]+){0,3}/gi,
  /\b(?:para|a|al|en el|en|por)?\s*(?:delivery|domicilio|retiro|retirar|recoger|llevar|el local|local|pickup)\b/gi,
  /\b(?:pago|pagar|pagaré|pagare|pagamos)?\s*(?:con|en)?\s*(?:tarjeta|efectivo|transferencia|link|cash)\b/gi,
  /\b(?:con )?factura\b|\bconsumidor final\b/gi,
];

/**
 * Muletillas alrededor de un cambio de entrega o pago ("no, mejor delivery", "quiero delivery a mi casa"):
 * no son productos. Solo se quitan si el mensaje sí trae entrega o pago (si no, "mejor 2 cafés" es un pedido).
 */
const FILLER_WITH_DATA = /(?<![\p{L}\p{N}])(?:mejor que sea|que sea|no|s[ií]|mejor|prefiero|quiero|quisiera|cambia(?:lo)?|c[aá]mbialo|a mi casa|mi casa|a domicilio|domicilio|entonces|porfa|por favor|gracias|ok|dale)(?![\p{L}\p{N}])/giu;

/** Verbos de quitar: sin uno de ellos, un "remove" de la IA que no nombra el producto se descarta. */
const REMOVAL_VERB = /\b(quit|saca|sacar|sacal|elimin|borra|cancel|ya no|no quiero|sin )/i;

/** Extracción por reglas. Es el respaldo si Gemini falla y lo que usan las pruebas. */
export const heuristicExtract: Extractor = async (message) => {
  const removal = parseRemoval(message);
  const quantityChange = parseQuantityChange(message);
  const invoice = wantsInvoice(message) ? true : wantsFinalConsumer(message) ? false : undefined;
  const email = extractEmail(message);
  const name = extractDeclaredName(message);
  const deliveryType = detectDeliveryType(message) || undefined;
  const paymentMethod = detectPaymentMethod(message) || undefined;
  // "quita el café" / "que sean 3" hablan del carrito: no son productos nuevos.
  // "quita el bolón crunch y ponme el de queso verde": lo que pide a cambio SÍ es un producto nuevo.
  let itemText = removal ? additionAfterRemoval(message) : quantityChange ? "" : DATA_PHRASES.reduce((text, pattern) => text.replace(pattern, " "), message);
  if (deliveryType || paymentMethod) itemText = itemText.replace(FILLER_WITH_DATA, " ");
  return {
    items: splitItemPhrases(itemText),
    remove: removal ? [removal] : [],
    setQuantity: quantityChange ? [quantityChange] : [],
    customerName: name || undefined,
    customerEmail: email || undefined,
    deliveryType,
    paymentMethod,
    wantsInvoice: invoice,
    billingDocNumber: extractDocNumber(message) || undefined,
    source: "heuristic",
  };
};

const PROMPT = `Eres el EXTRACTOR de datos de un bot de pedidos de Boloncity (comida típica ecuatoriana: bolones, tigrillos, bistec, café, jugos).
No respondes al cliente. Devuelves SOLO JSON válido con esta forma exacta:
{"items":[{"query":"","quantity":1}],"remove":[""],"setQuantity":[{"query":"","quantity":1}],"customerName":null,"customerEmail":null,"deliveryType":null,"paymentMethod":null,"wantsInvoice":null,"billingDocNumber":null,"billingName":null,"billingAddress":null,"notes":null}

Reglas:
- items: productos que el cliente quiere AGREGAR. "query" = el producto con las palabras del cliente, sin cantidad ni verbos ("2 bolones mixtos de verde" -> {"query":"bolon mixto verde","quantity":2}). Un renglón por producto. "un/una" = 1.
- NO inventes productos ni corrijas a nombres que el cliente no dijo. NO incluyas precios.
- remove: productos que quiere QUITAR del carrito. setQuantity: cambios de cantidad de algo que ya está en el carrito.
- deliveryType: "delivery" (a domicilio) o "pickup" (retira en el local). paymentMethod: "card" (tarjeta/link), "cash" (efectivo) o "transfer" (transferencia/depósito).
- customerName solo si el cliente dice su nombre. customerEmail solo si escribe un correo.
- wantsInvoice: true si pide factura, false si dice consumidor final. billingDocNumber: cédula (10 dígitos) o RUC (13).
- notes: indicaciones de preparación ("sin cebolla", "bien cocido").
- Si el mensaje solo responde la pregunta del bot, usa esa pregunta para interpretarlo (ej. pregunta "¿Cómo te llamas?" y responde "Ana Pérez" -> customerName).
- Todo lo que no aplique va null o [].`;

const normalizeForVerb = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Extracción con Gemini: entiende frases libres. Si falla o tarda, cae a las reglas. */
export const aiExtract: Extractor = async (message, context) => {
  if (!env.GEMINI_API_KEY) return heuristicExtract(message, context);
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Pregunta anterior del bot: ${context.lastBotQuestion || "(ninguna)"}\nCarrito actual: ${context.cartNames.join(", ") || "(vacío)"}\nMensaje del cliente: ${message}`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 500,
          // Sin "thinking": aquí solo se extrae, y cada segundo cuenta contra el timeout del bot.
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      { timeout: 12000 }
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    const fallback = await heuristicExtract(message, context);
    const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const oneOf = <T extends string>(value: unknown, allowed: T[]) => (allowed.includes(value as T) ? (value as T) : undefined);
    // La IA a veces copia el ejemplo del prompt ("bolon mixto verde") cuando el mensaje no trae nada.
    // Solo se aceptan productos con al menos una palabra que el cliente sí escribió.
    const messageTokens = meaningfulTokens(message);
    const saidByCustomer = (query: string) =>
      meaningfulTokens(query).some((token) => messageTokens.some((word) => tokenSimilarity(word, token) >= 0.7 || tokenSimilarity(token, word) >= 0.7));
    return {
      items: Array.isArray(parsed.items)
        ? parsed.items
            .filter((item: any) => str(item?.query) && saidByCustomer(str(item.query)!))
            .map((item: any) => ({ query: str(item.query)!, quantity: Number(item.quantity) || 1 }))
        : [],
      // "no, mejor delivery" con una humita en el carrito: la IA a veces lo lee como "quitar la humita".
      // Solo se quita algo si el cliente nombró el producto o usó un verbo de quitar.
      remove: Array.isArray(parsed.remove)
        ? parsed.remove.map(str).filter((query: string | undefined): query is string => Boolean(query) && (saidByCustomer(query!) || REMOVAL_VERB.test(normalizeForVerb(message))))
        : [],
      setQuantity: Array.isArray(parsed.setQuantity)
        ? parsed.setQuantity.filter((item: any) => str(item?.query)).map((item: any) => ({ query: str(item.query)!, quantity: Number(item.quantity) || 0 }))
        : [],
      // El correo y la cédula se validan con regex aunque vengan de la IA.
      customerName: str(parsed.customerName),
      customerEmail: extractEmail(String(parsed.customerEmail || "")) || fallback.customerEmail,
      deliveryType: oneOf(parsed.deliveryType, ["delivery", "pickup"]) || fallback.deliveryType,
      paymentMethod: oneOf(parsed.paymentMethod, ["card", "cash", "transfer"]) || fallback.paymentMethod,
      wantsInvoice: typeof parsed.wantsInvoice === "boolean" ? parsed.wantsInvoice : fallback.wantsInvoice,
      billingDocNumber: extractDocNumber(String(parsed.billingDocNumber || "")) || fallback.billingDocNumber,
      billingName: str(parsed.billingName),
      billingAddress: str(parsed.billingAddress),
      notes: str(parsed.notes),
      source: "ai",
    };
  } catch (error) {
    console.error("[whatsapp-bot] extracción IA falló, uso reglas:", error instanceof Error ? error.message : error);
    return heuristicExtract(message, context);
  }
};

/**
 * DESEMPATE CON IA ENTRE LAS OPCIONES YA MOSTRADAS.
 *
 * Solo se usa cuando las reglas de choice.ts no alcanzan. La IA NO ve el catálogo, no escribe el
 * mensaje y no puede inventar nada: recibe la lista que el bot ya mostró (con los nombres y precios
 * que salieron de Mongo) y devuelve el NÚMERO de la opción, o null si el cliente no eligió ninguna.
 */
const CHOICE_PROMPT = `Eres parte de un bot de pedidos por WhatsApp en Ecuador. El bot le mostró al cliente una lista numerada de opciones y el cliente respondió hablando normal, con errores de tipeo, cortesías y modismos ecuatorianos.
Tu única tarea: decir a QUÉ OPCIÓN DE LA LISTA se refiere.

Devuelve SOLO JSON: {"index": <número de la opción o null>}

Reglas:
- index es el número de la lista (1..N). Si el cliente no eligió ninguna, si nombra algo que NO está en la lista, o si sigue siendo ambiguo entre dos opciones, devuelve null.
- Ignora cortesías ("porfa", "me encantaría", "gracias") y errores de tipeo ("boon" = bolón).
- "el más barato" / "el de 3.50" se resuelven por el precio de la lista.
- "el primero", "la segunda", "el último" son posiciones de la lista.
- NUNCA inventes productos, nombres ni precios. Solo eliges un número de la lista.`;

export async function aiChooseOption(input: { message: string; question: string; options: Array<{ name: string; price?: number }> }): Promise<number | null> {
  if (!env.GEMINI_API_KEY || input.options.length < 2) return null;
  const list = input.options.map((option, index) => `${index + 1}. ${option.name}${option.price != null ? ` $${option.price.toFixed(2)}` : ""}`).join("\n");
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        systemInstruction: { parts: [{ text: CHOICE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `Pregunta del bot: ${input.question}\nOpciones:\n${list}\nMensaje del cliente: ${input.message}` }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
      },
      { timeout: 8000 }
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    const index = Number(parsed.index);
    return Number.isInteger(index) && index >= 1 && index <= input.options.length ? index : null;
  } catch (error) {
    console.error("[whatsapp-bot] el desempate con IA falló, sigo con reglas:", error instanceof Error ? error.message : error);
    return null;
  }
}
