import { normalizeText } from "./catalog";

/**
 * Detectores deterministas (regex). Corren ANTES de la IA porque son instantáneos,
 * no fallan y no se equivocan con frases que el negocio necesita reconocer siempre:
 * confirmar, repetir pedido, consultar pedido, hablar con una persona.
 */

const test = (pattern: RegExp) => (message: string) => pattern.test(normalizeText(message));
/** Texto normalizado y sin puntos ("ok." → "ok"), para las frases que deben ser SOLO eso. */
const bareText = (message: string) => normalizeText(message).replace(/\./g, " ").replace(/\s+/g, " ").trim();

const YES_WORDS = "si+|sip|claro|dale|ok|okay|oki|va|listo|perfecto|correcto|de una|por supuesto|asi es|exacto|obvio|bueno|si porfa|si por favor|confirmo";
export const isYes = test(new RegExp(`^(${YES_WORDS})\\b`));

/**
 * CLASIFICADOR DEL PASO "confirm" (resumen mostrado). Lo usan igual el router de la Bienvenida
 * (classifyRoute) y la conversación (R7), así /router y /brain nunca se contradicen.
 *
 *   confirm  → afirmación sin pedido de cambio: "sí", "ok dale", "confirmo el pedido", "confirmo mi pedido",
 *              "si esta bien asi", "así está bien", "correcto", "de una", "adelante", "hazlo", "✅", "👍".
 *   courtesy → cortesía sin afirmación: "gracias", "ya", "por favor", "hola", "nada más", "🙏".
 *              NO crea la orden: se vuelve a mostrar el resumen y se pide "confirmo" (no suma "no entendido").
 *   other    → todo lo demás, incluido un cambio ("sí, pero agrégale un café", "mejor sin cebolla",
 *              "otro bolón"): lo resuelve la conversación, que aplica el cambio y reimprime el resumen.
 *
 * El mensaje se lee de izquierda a derecha y CADA palabra debe ser una frase de confirmación, un relleno
 * ("porfa", "gracias", "ya") o el objeto ("el pedido", "mi orden", "todo"). Una sola palabra fuera de esas
 * listas ("pero", "agrega", "sin", "otro", "más", un producto) hace que NO confirme: ante la duda, no se cobra.
 *
 * ✅ y 👍 confirman: el resumen termina pidiendo confirmar y en WhatsApp esa es la forma corta de decir "sí".
 * 🙏, 😀 y demás emojis son cortesía.
 */
const CONFIRM_PHRASES = [
  "si+", "sip", "simon", "claro", "claro que si", "dale", "ok+", "okay", "oki", "okey", "va", "vale", "listo", "perfecto", "esta perfecto",
  "correcto", "todo correcto", "de una", "por supuesto", "asi es", "exacto", "obvio", "bueno", "confirmo", "confirmar", "confirmado",
  "confirma", "si confirmo", "procede", "proceder", "hazlo", "envialo", "envia", "enviar", "mandalo", "manda", "quiero pagar", "pagar",
  "todo bien", "esta bien", "asi esta bien", "esta bien asi", "bien asi", "asi nomas", "de acuerdo", "adelante", "sigue", "seguimos",
  "todo esta bien", "esta todo bien", "okis", "oks", "okas", "okidoki", "sale", "hagale", "de ley", "si claro", "claro que si",
];
/** Rellenos que acompañan a un sí pero, solos, no confirman nada. */
const COURTESY_PHRASES = [
  "gracias", "muchas gracias", "mil gracias", "porfa", "porfis", "por favor", "porfavor", "please", "pls", "ya", "pues", "entonces",
  "hola+", "buenas", "buenos dias", "buenas tardes", "buenas noches", "amigo", "amiga", "nada mas", "nada", "eso es todo", "eso seria todo",
  "seria todo", "es todo", "nomas", "no mas", "solo eso", "eso", "x favor", "xfa", "xfavor", "porfavorcito",
];
/** El objeto de la confirmación: "confirmo EL PEDIDO", "envía MI ORDEN". */
const CONFIRM_OBJECTS = ["el pedido", "mi pedido", "la orden", "mi orden", "el resumen", "todo", "lo"];
const CONFIRM_EMOJI = /[✅👍👌]/u;

type ConfirmReply = "confirm" | "courtesy" | "other";

const phraseAlternation = (phrases: string[]) => [...phrases].sort((a, b) => b.length - a.length).join("|");
const CONFIRM_TOKEN = new RegExp(`^(?:${phraseAlternation(CONFIRM_PHRASES)})(?: |$)`);
const COURTESY_TOKEN = new RegExp(`^(?:${phraseAlternation([...COURTESY_PHRASES, ...CONFIRM_OBJECTS])})(?: |$)`);

/**
 * Tolerancia a errores de tipeo en UNA palabra: "confimo", "confirmoo", "conffirmo", "perfeto", "grasias".
 * Se colapsan letras repetidas ("siii", "okkk") y se compara con las frases de una sola palabra por distancia de
 * edición: 1 letra de diferencia desde 5 letras, 2 desde 8. Las palabras cortas (sí/sin, ok/o) nunca se aproximan:
 * con ellas un error cambia el sentido.
 */
const collapseRepeats = (word: string) => word.replace(/(.)\1+/g, "$1");
const singleWords = (phrases: string[]) => [...new Set(phrases.filter((phrase) => /^[a-z]+$/.test(phrase)).map(collapseRepeats))];
/**
 * Solo estas palabras largas se aproximan para CONFIRMAR: con palabras cortas un error de tipeo cae en otra
 * palabra real ("parar"/"pasar" → "pagar", "hablo" → "hazlo") y se crearía una orden que nadie pidió.
 */
const FUZZY_CONFIRM = ["confirmo", "confirmar", "confirmado", "perfecto", "correcto", "adelante"];
const FUZZY_COURTESY = singleWords(COURTESY_PHRASES);
/** Palabras que se parecen a una confirmación pero dicen otra cosa ("envio" ≠ "envia"). */
const NOT_FUZZY = new Set([
  "envio", "envios", "lista", "listas", "manga", "clara", "claras", "pague", "pagos", "buenos", "buenas", "seguido", "seguidos",
  "seguida", "seguidas", "enviado", "enviados", "enviada", "mando", "mandas", "sigues", "pagas", "confirmas", "confirmaron",
]);

function editDistance(a: string, b: string) {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

/**
 * Un error de tipeo conserva la primera y la última letra ("confimo", "perfeto", "grasias"). Así no se aproximan
 * negaciones ni palabras distintas: "incorrecto"/"imperfecto"/"inexacto" (prefijo in-/im-), "limon" (simon),
 * "visto" (listo), ni otras conjugaciones ("confirmas", "pagas", "confirmaron"). La distancia se mide contra la
 * palabra más CORTA: 2 letras solo si ambas tienen 8 o más ("confirmdo" sí, "incorrecto" → "correcto" no).
 */
function fuzzyWord(word: string, vocabulary: string[]) {
  const collapsed = collapseRepeats(word);
  if (collapsed.length < 5 || NOT_FUZZY.has(word) || NOT_FUZZY.has(collapsed)) return vocabulary.includes(collapsed);
  return vocabulary.some((candidate) => {
    if (candidate.length < 5 || candidate[0] !== collapsed[0] || candidate[candidate.length - 1] !== collapsed[collapsed.length - 1]) return false;
    // 2 letras solo en "confirm…" (el typo más común); en el resto, 1 ("adelgaste" no es "adelante").
    const allowed = candidate.startsWith("confirm") && collapsed.length >= 8 ? 2 : 1;
    return editDistance(collapsed, candidate) <= allowed;
  });
}

export function classifyConfirmReply(message: string): ConfirmReply {
  const raw = String(message || "").trim();
  if (!raw) return "other";
  let text = bareText(raw);
  let confirmed = CONFIRM_EMOJI.test(raw);
  // Solo emojis o signos: ✅/👍 confirman, el resto es cortesía.
  if (!text) return confirmed ? "confirm" : "courtesy";
  while (text) {
    const yes = text.match(CONFIRM_TOKEN);
    const filler = yes ? null : text.match(COURTESY_TOKEN);
    const match = yes || filler;
    if (match) {
      if (yes) confirmed = true;
      text = text.slice(match[0].length).trim();
      continue;
    }
    // Sin coincidencia exacta: la siguiente palabra con un error de tipeo ("confimo", "confirmoo").
    const word = text.split(" ")[0];
    if (collapseRepeats(word).length >= 7 && fuzzyWord(word, FUZZY_CONFIRM)) confirmed = true;
    else if (!fuzzyWord(word, FUZZY_COURTESY)) return "other";
    text = text.slice(word.length).trim();
  }
  // "¿confirmo?", "¿está bien?", "¿ya lo enviaron?": una PREGUNTA nunca crea la orden. Se trata como cortesía:
  // se vuelve a mostrar el resumen y se pide escribir "confirmo".
  if (confirmed && /[?¿]/.test(raw)) return "courtesy";
  return confirmed ? "confirm" : "courtesy";
}

/** "sí", "ok dale", "confirmo el pedido": confirma el resumen sin pedir cambios (ver classifyConfirmReply). */
export function isPlainConfirmation(message: string) {
  return classifyConfirmReply(message) === "confirm";
}
export const isNo = test(/^(no+|nop|nel|mejor no|negativo|todavia no|aun no|no gracias)\b/);

/**
 * Palabras de un cliente que quiere COMPRAR. Nunca se deriva a una persona por ellas: este bot existe
 * para tomar el pedido ("hola quisiera comprar" terminaba en soporte).
 */
const WANTS_TO_BUY = /\b(comprar|compro|pedir|ordenar|orden(ar|e)?|hacer un pedido|quiero un|quiero dos|quisiera|me das|dame|vender|venden|tienen|cuanto cuesta|precio|menu)\b/;

const isComplaint = test(
  new RegExp(
    [
      "\\b(reclamo|queja|quejarme|estafa|estafaron|pesimo|nadie (me )?responde|mal servicio|maltrato)\\b",
      "\\b(llego|vino|vinieron|llegaron) (todo |muy |bien )?(frio|fria|frios|frias|mal|malo|mala|tarde|incompleto|incompleta|equivocado|equivocada|crudo|cruda|feo|fea|dañado|danado)\\b",
      "\\bno (me )?(ha )?(llego|llega|llegado) (mi |el )?(pedido|orden|comida|delivery|motorizado)\\b",
      "\\b(devolucion|devuelvan|reembolso|reembolsen|me cobraron|cobro doble|cobraron doble|cobrado dos veces)\\b",
    ].join("|")
  )
);

/** Pide explícitamente una persona: "quiero hablar con una persona", "pásame un asesor". */
const asksForPerson = test(
  new RegExp(
    [
      "\\b(hablar|comunicarme|contactar|hablo|me pasas|pasame|pasenme|quiero|necesito) (con )?(un |una |el |la )?(humano|humana|persona|asesor|asesora|agente|encargado|encargada|operador|operadora|alguien)\\b",
      "\\b(atencion al cliente|servicio al cliente)\\b",
    ].join("|")
  )
);

/**
 * Solo pasan a una persona los RECLAMOS y quien pide explícitamente hablar con alguien. Un cliente que
 * quiere comprar siempre se queda en la conversación, aunque use palabras parecidas.
 */
export function wantsHuman(message: string) {
  if (isComplaint(message)) return true;
  return asksForPerson(message) && !WANTS_TO_BUY.test(normalizeText(message));
}

/** @deprecated se mantiene para no romper llamadas viejas; equivale a wantsHuman. */
export const wantsSupport = test(
  new RegExp(
    [
      "\\b(humano|asesor|agente|una persona|hablar con alguien|atencion al cliente|soporte|reclamo|queja|estafa|pesimo|nadie (me )?responde)\\b",
      // Reclamos sin la palabra "reclamo": "llegó frío", "no llegó mi pedido", "quiero un reembolso".
      "\\b(llego|vino|vinieron|llegaron) (todo |muy |bien )?(frio|fria|frios|frias|mal|malo|mala|tarde|incompleto|incompleta|equivocado|equivocada|crudo|cruda|feo|fea|dañado|danado)\\b",
      "\\bno (me )?(ha )?(llego|llega|llegado) (mi |el )?(pedido|orden|comida|delivery|motorizado)\\b",
      "\\b(devolucion|devuelvan|reembolso|reembolsen|me cobraron|cobro doble|cobraron doble|cobrado dos veces)\\b",
      "\\b(necesito|quiero|requiero) (una )?ayuda\\b|^ayuda( por favor| porfa)?$",
    ].join("|")
  )
);

/**
 * Saludos y cortesías sin pedido: "hola", "buenas tardes", "gracias", "ok", "👍".
 * No son mensajes "no entendidos": no deben sumar para derivar a una persona.
 */
export function isSmallTalk(message: string) {
  const raw = String(message || "").trim();
  if (!raw) return false;
  const text = bareText(raw);
  // Solo emojis o signos ("😀😀", "👍", "!!").
  if (!text) return true;
  return /^(?:(?:hola+|holi|ola|buenas|buenos|buen|dias|dia|tardes|noches|que tal|como estan|como esta|como estas|saludos|hey|hi|hello|gracias|muchas gracias|mil gracias|ok|okey|okay|oki|vale|dale|listo|perfecto|genial|excelente|chevere|bacan|super|entendido|de acuerdo|amigo|amiga|amigos|señor|senor|señorita|senorita|ya|bien|muy bien|todo bien|y ustedes|y usted|como va|que mas)\s*)+$/.test(text);
}

/** Saludo ("hola", "buenas tardes"): se responde saludando, no con "¡gracias a ti!". */
export function isGreeting(message: string) {
  return isSmallTalk(message) && /\b(hola+|holi|ola|buenas|buenos|buen dia|saludos|hey|hi|hello|que tal)\b/.test(bareText(message)) && !/\bgracias\b/.test(bareText(message));
}

/**
 * ¿El mensaje es una pregunta? "¿cuánto cuesta el envío?", "cuanto se demora", "hacen delivery a Samborondón?".
 * Sirve en el paso de dirección: una pregunta NO es una dirección. Una dirección real ("Av. San Jorge 123,
 * edificio azul piso 2") no trae signos de pregunta, no empieza con palabra interrogativa ni habla de costo/tiempo.
 */
export function isQuestion(message: string) {
  const raw = String(message || "");
  if (/[?¿]/.test(raw)) return true;
  const text = normalizeText(raw);
  return (
    /^(que|cual|cuales|cuanto|cuanta|cuantos|cuando|como|donde|por que|hacen|tienen|llegan|llega|puedo|pueden|podrian|cobran|se demora|demora|tarda|me demoro)\b/.test(text) ||
    /\b(cuanto|cuanta|demora|demoran|tarda|tardan|costo|cuesta|cuestan|precio|valor del (envio|delivery))\b/.test(text)
  );
}

/** "el link no me abre", "pásame el link otra vez", "no me llegó el link de pago". */
export const wantsPaymentLink = test(/\b(link|enlace|liga|url)\b|\bno (me )?(abre|carga|funciona|deja pagar)\b|\b(como|donde) (pago|pagar|lo pago)\b/);

const trackingPattern =
  /\b(mi pedido|mi orden|estado (de )?(mi )?(pedido|orden)|rastrear|seguimiento|tracking|donde (va|esta) (mi )?(pedido|orden)|consultar (mi )?(pedido|orden)|ya (salio|viene)|cuanto (falta|se demora)|ord \d+|(orden|pedido|order) (numero |nro |no |n )?\d{1,6}(?! ?[a-z]))\b/;
/** "agrega un café a mi pedido", "quita la humita de mi orden": editan el carrito, no consultan un pedido. */
const EDIT_VERBS = /\b(agrega\w*|agrego|anade\w*|anadir|suma\w*|pon|ponle|ponme|quita\w*|saca\w*|elimina\w*|borra\w*|cambia\w*|aumenta\w*|agregar|incluye)\b/;
export function wantsTracking(message: string) {
  const text = normalizeText(message);
  return trackingPattern.test(text) && !EDIT_VERBS.test(text);
}

export const wantsReorder = test(
  /\b(lo mismo (de|que) (la )?(ultima|otra) vez|lo de (la )?(ultima|otra) vez|lo de siempre|lo mismo de siempre|repetir (mi |el )?(ultimo )?pedido|repite (mi |el )?(ultimo )?pedido|mi ultimo pedido|pedido anterior|lo mismo que antes|repetir|lo mismo)\b/
);

// "qué tienen", "qué bebidas tienen", "qué tienen de dulce": hasta dos palabras entre "qué" y el verbo.
export const wantsMenu = test(/\b(menu|carta|que (\w+ ){0,2}(tienen|venden|hay)|que (tienen|venden|hay)( \w+){0,3}|catalogo|productos|opciones|recomienda|recomiendas|recomendacion)\b/);

// "ver carrito" / "carrito" solos también: "agrega al carrito un café" NO (ese agrega un producto).
export const wantsCart = test(/\b(^(?:ver |mostrar |muestrame )?(?:el |mi )?carrito$|mi carrito|que llevo|que tengo|resumen|mi pedido actual|como va (mi )?pedido|ver (el )?pedido|total)\b/);

export const wantsClearCart = test(/\b(vaciar|borra(r)? todo|empezar de nuevo|desde cero|cancela(r)? (todo|el pedido|mi pedido|la orden|mi orden)|^cancela(r|lo)?$|ya no quiero)\b/);

/**
 * "no confirmo", "todavía no", "espera", "dame un momento": en el resumen, el cliente aún no decide. No es un cambio
 * ni un rechazo: se le dice que confirme cuando quiera. Solo si el mensaje es SOLO eso ("espera, agrega un café" no).
 */
export const wantsToWait = test(
  /^(?:no (?:confirmo|confirmar|todavia|aun)|todavia no|aun no|(?:no )?(?:espera|esperame|esperate|esperen)|un (?:momento|segundo|rato)|dame un (?:momento|segundo|rato)|(?:ya|luego|despues|mas tarde) te (?:confirmo|aviso))(?: (?:todavia|aun|por favor|porfa|un momento|un segundo|un rato|gracias|confirmo))*\.*$/
);

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

/**
 * "ORD-00017", "orden 17", "pedido #17", "order 17". Con `allowBare` (flow "consultar orden" o el campo
 * orderNumber) también "17" o "#17" solos. Nunca toma más de 6 dígitos: así no confunde teléfonos ni cédulas.
 */
export function extractOrderNumber(message: string, { allowBare = false }: { allowBare?: boolean } = {}) {
  const text = String(message || "");
  const match =
    text.match(/\bORD[-\s#]?(\d{1,6})(?!\d)/i) ||
    text.match(/\b(?:orden|pedido|order)\s*(?:#|n[°º.]?|nro\.?|no\.?|numero|número)?\s*#?\s*(\d{1,6})(?!\d)/i) ||
    (allowBare ? text.trim().match(/^#?\s*(\d{1,6})$/) : null);
  return match ? `ORD-${match[1].padStart(5, "0")}` : "";
}

/**
 * Cédula ecuatoriana (10 dígitos, módulo 10) o RUC (13). Un número con el dígito verificador mal
 * se rechaza aquí: si no, la factura del SRI falla después de cobrar.
 */
export function isValidEcuadorId(value: string) {
  const digits = String(value || "");
  if (!/^\d{10}(\d{3})?$/.test(digits)) return false;
  const province = Number(digits.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  const third = Number(digits[2]);
  if (digits.length === 13 && digits.endsWith("000")) return false;
  // RUC de sociedad (9) o pública (6): su dígito verificador cambia según el tipo; se valida solo la forma.
  if (digits.length === 13 && (third === 6 || third === 9)) return true;
  if (third >= 6) return false;
  const sum = digits
    .slice(0, 9)
    .split("")
    .reduce((total, digit, index) => {
      const product = Number(digit) * (index % 2 === 0 ? 2 : 1);
      return total + (product > 9 ? product - 9 : product);
    }, 0);
  return (10 - (sum % 10)) % 10 === Number(digits[9]);
}

/** Cédula o RUC del mensaje. Devuelve "" si no hay uno o si no es válido (ver `isValidEcuadorId`). */
export function extractDocNumber(message: string) {
  const digits = String(message || "").match(/\b\d{10}(\d{3})?\b/)?.[0] || "";
  return isValidEcuadorId(digits) ? digits : "";
}

/** ¿El mensaje trae un número con forma de cédula/RUC (aunque sea inválido)? Para avisar en vez de ignorarlo. */
export function hasDocLikeNumber(message: string) {
  return /\b\d{10}(\d{3})?\b/.test(String(message || ""));
}

export function extractMapsUrl(message: string) {
  return String(message || "").match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\S*/i)?.[0] || "";
}

/** "me llamo Ana Pérez", "soy Ana", "mi nombre es Ana". */
export function extractDeclaredName(message: string) {
  const match = String(message || "").match(/\b(?:me llamo|mi nombre es|soy)\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,3})/i);
  return match && !isNotAName(match[1]) ? titleCaseName(match[1]) : "";
}

/**
 * Palabras del pedido que NO son un nombre: "retiro" en el paso del nombre quedaba como cliente "Retiro".
 * Si el mensaje trae una de estas, se aplica su intención (retiro, tarjeta, menú…) o se vuelve a pedir el nombre.
 */
const NOT_A_NAME =
  /\b(retiro|retirar|retiras|recoger|recojo|llevar|delivery|domicilio|envio|enviar|tarjeta|efectivo|transferencia|cash|link|pago|pagar|si|sip|no|ok|okay|oki|dale|listo|claro|menu|carta|producto|productos|opciones|confirmo|confirmar|confirmado|local|sucursal|factura|consumidor|final|gracias|hola|buenas|buenos|pedido|orden|quiero|dame|cancelar|cancela|ayuda|nada|precio|cuanto|resumen|correo|nombre|cambiar|cambia|agrega|quita|mejor|otro|otra)\b/;
export function isNotAName(value: string) {
  return NOT_A_NAME.test(normalizeText(value));
}

/** Respuesta suelta cuando el bot preguntó el nombre: "Ana Pérez". "retiro", "tarjeta" o "sí" no son nombres. */
export function looksLikeBareName(message: string) {
  const text = String(message || "").trim();
  return /^[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}){0,3}$/.test(text) && !isYes(text) && !isNo(text) && !isNotAName(text);
}

/** Siglas de razón social que se escriben en mayúsculas aunque el cliente no lo haga. */
const COMPANY_ACRONYMS = new Set(["sa", "s.a", "s.a.", "cia", "cia.", "cía", "cía.", "ltda", "ltda.", "ep", "sas", "s.a.s", "s.a.s.", "cl", "c.l", "c.l.", "ruc"]);

/**
 * Nombre de persona o razón social con mayúscula inicial, SIN romper siglas: "rosa prueba sa" → "Rosa Prueba SA",
 * "Comercial XYZ S.A." se queda igual. Una palabra que el cliente escribió toda en mayúsculas se respeta,
 * salvo que TODO el texto venga en mayúsculas ("ROSA PRUEBA" → "Rosa Prueba").
 */
export function titleCaseName(value: string) {
  const text = value.trim().replace(/\s+/g, " ");
  const allUpper = text === text.toUpperCase();
  return text
    .split(" ")
    .map((word) => {
      if (COMPANY_ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      if (!allUpper && /\p{L}/u.test(word) && word === word.toUpperCase() && word.replace(/[^\p{L}]/gu, "").length >= 2) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
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
      const match = phrase.match(/^(?:(?:quiero|dame|deme|agrega|agregame|agregale|agregue|anade|anademe|anadele|ponme|ponle|sumale|quisiera|me das|mandame|y|pero|si|ok|dale|tambien)\s+)*(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|par)\b\s*(?:de\s+)?(.*)$/);
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
