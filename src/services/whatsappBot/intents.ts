import { normalizeText } from "./catalog";

/**
 * Detectores deterministas (regex). Corren ANTES de la IA porque son instantáneos,
 * no fallan y no se equivocan con frases que el negocio necesita reconocer siempre:
 * confirmar, repetir pedido, consultar pedido, hablar con una persona.
 */

const test = (pattern: RegExp) => (message: string) => pattern.test(normalizeText(message));

export const isYes = test(/^(si+|sip|claro|dale|ok|okay|oki|va|listo|perfecto|correcto|de una|por supuesto|asi es|exacto|obvio|bueno|si porfa|si por favor|confirmo)\b/);
export const isNo = test(/^(no+|nop|nel|mejor no|negativo|todavia no|aun no|no gracias)\b/);

export const wantsHuman = test(
  /\b(humano|asesor|agente|una persona|hablar con alguien|atencion al cliente|soporte|reclamo|queja|estafa|pesimo|nadie (me )?responde)\b/
);

export const wantsTracking = test(
  /\b(mi pedido|mi orden|estado (de )?(mi )?(pedido|orden)|rastrear|seguimiento|tracking|donde (va|esta) (mi )?(pedido|orden)|consultar (mi )?(pedido|orden)|ya (salio|viene)|cuanto (falta|se demora)|ord \d+)\b/
);

export const wantsReorder = test(
  /\b(lo mismo (de|que) (la )?(ultima|otra) vez|lo de (la )?(ultima|otra) vez|lo de siempre|lo mismo de siempre|repetir (mi |el )?(ultimo )?pedido|repite (mi |el )?(ultimo )?pedido|mi ultimo pedido|pedido anterior|lo mismo que antes|repetir|lo mismo)\b/
);

// "qué tienen", "qué bebidas tienen", "qué tienen de dulce": hasta dos palabras entre "qué" y el verbo.
export const wantsMenu = test(/\b(menu|carta|que (\w+ ){0,2}(tienen|venden|hay)|que (tienen|venden|hay)( \w+){0,3}|catalogo|productos|opciones|recomienda|recomiendas|recomendacion)\b/);

export const wantsCart = test(/\b(mi carrito|que llevo|que tengo|resumen|mi pedido actual|como va (mi )?pedido|ver (el )?pedido|total)\b/);

export const wantsClearCart = test(/\b(vaciar|borra(r)? todo|empezar de nuevo|desde cero|cancela(r)? (todo|el pedido|mi pedido)|ya no quiero)\b/);

export const wantsConfirm = test(/^(confirmo|confirmar|si confirmo|confirmado|dale confirmo|listo confirmo|quiero pagar|pagar|procede|proceder|hazlo|envialo|mandalo)\b/);

export const wantsInvoice = test(/\b(factura|facturar|ruc|con datos)\b/);
export const wantsFinalConsumer = test(/\b(consumidor final|sin factura|no necesito factura|sin datos)\b/);

export function detectDeliveryType(message: string): "delivery" | "pickup" | null {
  const text = normalizeText(message);
  if (/\b(retiro|retirar|retiro en (el )?local|recoger|recojo|paso (a )?(retirar|recoger|buscar)|voy (al|a) local|en (el )?local|para llevar|pickup)\b/.test(text)) return "pickup";
  if (/\b(delivery|domicilio|a mi casa|envio|enviar|envien|traigan|traer|motorizado|a domicilio)\b/.test(text)) return "delivery";
  return null;
}

export function detectPaymentMethod(message: string): "card" | "cash" | "transfer" | null {
  const text = normalizeText(message);
  if (/\b(transferencia|transfiero|deposito|depositar|banco|pichincha|produbanco|guayaquil|bolivariano|deuna|de una transferencia)\b/.test(text)) return "transfer";
  if (/\b(tarjeta|credito|debito|link|payphone|en linea|online|visa|mastercard)\b/.test(text)) return "card";
  if (/\b(efectivo|cash|billete|en persona|al recibir|contra entrega|al motorizado|al retirar)\b/.test(text)) return "cash";
  return null;
}

export function extractEmail(message: string) {
  return String(message || "").match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i)?.[0]?.toLowerCase() || "";
}

export function extractOrderNumber(message: string) {
  const match = String(message || "").match(/\bORD[-\s]?(\d{1,6})\b/i);
  return match ? `ORD-${match[1].padStart(5, "0")}` : "";
}

export function extractDocNumber(message: string) {
  const digits = String(message || "").match(/\b\d{10}(\d{3})?\b/)?.[0] || "";
  return digits;
}

export function extractMapsUrl(message: string) {
  return String(message || "").match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\S*/i)?.[0] || "";
}

/** "me llamo Ana Pérez", "soy Ana", "mi nombre es Ana". */
export function extractDeclaredName(message: string) {
  const match = String(message || "").match(/\b(?:me llamo|mi nombre es|soy)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,3})/i);
  return match ? titleCase(match[1]) : "";
}

/** Respuesta suelta cuando el bot preguntó el nombre: "Ana Pérez". */
export function looksLikeBareName(message: string) {
  const text = String(message || "").trim();
  return /^[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}){0,3}$/.test(text) && !isYes(text) && !isNo(text);
}

export function titleCase(value: string) {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, par: 2,
};

/**
 * Parte un mensaje en renglones con cantidad: "2 bolones mixtos y un café" →
 * [{ query: "bolones mixtos", quantity: 2 }, { query: "café", quantity: 1 }].
 * No decide si son productos: eso lo resuelve el buscador.
 */
export function splitItemPhrases(message: string) {
  // Se parte ANTES de normalizar: normalizeText borra las comas que separan los productos.
  return String(message || "")
    .toLowerCase()
    .split(/\s*(?:,|;|\+|\n|\by\b|\be\b|\bm[aá]s\b|\badem[aá]s\b|\btambi[eé]n\b)\s*/)
    .map((phrase) => normalizeText(phrase).replace(/\b(\d+)\s*x\s*(?!1\b)/g, "$1 ").trim())
    .filter(Boolean)
    .map((phrase) => {
      const match = phrase.match(/^(?:(?:quiero|dame|deme|agrega|agregame|ponme|quisiera|me das|mandame|y)\s+)*(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|par)\b\s*(?:de\s+)?(.*)$/);
      if (match) {
        const quantity = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1]];
        return { query: match[2].trim(), quantity: quantity || 1 };
      }
      return { query: phrase, quantity: 1 };
    })
    .filter((item) => item.query.length >= 3);
}

/** "quita el café", "sin la humita", "elimina el bolón". */
export function parseRemoval(message: string) {
  const match = normalizeText(message).match(/\b(?:quita(?:me)?|quitar|saca(?:me)?|sacar|elimina(?:r)?|borra(?:r)?|ya no quiero|no quiero)\s+(?:el|la|los|las|un|una)?\s*(.+)$/);
  return match ? match[1].trim() : "";
}

/** "que sean 3 bolones", "cambia el café a 2", "mejor 2 cafés". */
export function parseQuantityChange(message: string) {
  const text = normalizeText(message);
  const toNumber = (value: string) => (/^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value] || 0);
  const first = text.match(/\b(?:que sean|mejor|cambia(?:lo)? a|pon(?:me)?|dejalo en|solo)\s+(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(.+)$/);
  if (first) return { query: first[2].trim(), quantity: toNumber(first[1]) };
  const second = text.match(/\b(?:cambia|pon)\s+(?:el|la|los|las)?\s*(.+?)\s+a\s+(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco)\b/);
  if (second) return { query: second[1].trim(), quantity: toNumber(second[2]) };
  return null;
}
