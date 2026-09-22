import { meaningfulTokens, normalizeText, stem, undiminish } from "./catalog";

/**
 * ELEGIR HABLANDO NORMAL.
 *
 * Cuando el bot muestra opciones ("¿Cuál bolón de queso quieres?"), el cliente casi nunca
 * responde con el número: escribe "el verde", "boon de queso verde porf avor, me encantaria",
 * "el más barato", "mejor el crunch" o "el primero". Este módulo compara el mensaje SOLO con
 * las opciones que el bot mostró (nunca con todo el catálogo) y decide:
 *
 *   one     → el mensaje distingue una sola opción: se agrega esa.
 *   all     → "los dos", "uno de cada uno": quiere todas las opciones mostradas.
 *   several → habló de algo que comparten varias ("el de queso" cuando todas son de queso):
 *             hay que volver a preguntar mostrando SOLO lo que las diferencia.
 *   none    → no eligió (nombró otro producto, preguntó otra cosa): lo resuelve el router.
 *
 * Reglas primero (instantáneas y gratis); la IA solo entra después, y siempre eligiendo
 * entre estas mismas opciones: nunca inventa productos ni precios.
 */

export interface ChoiceOption {
  name: string;
  price?: number;
}

export type ChoicePick<T> =
  /** `any`: dijo "cualquiera" / "el que quieras" y aceptó lo que le demos. */
  | { kind: "one"; option: T; quantity?: number; any?: boolean }
  | { kind: "all"; options: T[] }
  /**
   * Hay que repreguntar entre ESTAS. `negated` = lo que el cliente descartó ("el verde no"),
   * para que el bot lo reconozca en vez de repetir la lista completa.
   */
  | { kind: "several"; options: T[]; negated?: string }
  /**
   * `foreign`: nombró otra cosa (otro producto) → lo resuelve el router. `unclear`: no se entendió la elección.
   * `foreign` + `best`: la palabra distintiva sí se entendió ("kero el maduro") y lo único raro es una
   * muletilla mal escrita: el router revisa si esa palabra es un producto real antes de descartar la elección.
   */
  | { kind: "none"; reason: "foreign" | "unclear"; words?: string[]; best?: T };

/**
 * Cortesías y muletillas que acompañan una elección y NO son parte del nombre del producto.
 * Se toleran con errores de tipeo ("porf avor" llega como "porf" + "avor").
 */
const FILLER_WORDS = [
  "porfa", "porfis", "porfavor", "porfavorcito", "favor", "porf", "avor", "plis", "please", "pls", "gracias", "graciass",
  "encantaria", "encanta", "encantara", "gustaria", "gusta", "quisiera", "quiero", "queria", "dame", "deme", "denme",
  "regalame", "mandame", "ponme", "ponle", "prefiero", "prefiera", "mejor", "seria", "sera", "vendria", "antoja",
  "pues", "entonces", "bueno", "listo", "dale", "ya", "eso", "ese", "esa", "esos", "esas", "este", "esta", "mismo",
  "misma", "nomas", "pero", "aunque", "igual", "tambien", "ahi", "asi", "opcion", "opciones", "numero", "uno", "una",
  "rico", "rica", "delicioso", "deliciosa", "grande", "grandes", "pequeno", "pequena", "chico", "chica", "mediano",
  "mediana", "normal", "caliente", "fria", "frio", "dulce", "salado", "sale", "vale", "ok", "okey", "si", "sip",
];

const FILLER_SET = new Set(FILLER_WORDS.map(stem));

function levenshtein(a: string, b: string) {
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
 * Parecido entre una palabra del cliente y una de la opción. Más tolerante que el buscador del
 * catálogo porque aquí solo se compite entre 2 y 6 opciones ya mostradas: "boon" es "bolón",
 * "madro" es "maduro", "cruch" es "crunch".
 */
function rawSimilarity(word: string, candidate: string) {
  if (word === candidate || stem(word) === stem(candidate)) return 1;
  const shortest = Math.min(word.length, candidate.length);
  if (shortest >= 4 && (candidate.startsWith(word) || word.startsWith(candidate))) return 0.9;
  if (shortest >= 4 && levenshtein(word, candidate) <= 1) return 0.85;
  if (shortest >= 7 && levenshtein(word, candidate) <= 2) return 0.75;
  return 0;
}

export function looseSimilarity(word: string, candidate: string) {
  if (!word || !candidate) return 0;
  const direct = rawSimilarity(word, candidate);
  if (direct) return direct;
  // Diminutivos: se vuelve a comparar por la raíz, con un pelo menos de confianza.
  const base = undiminish(word);
  const other = undiminish(candidate);
  if (base === word && other === candidate) return 0;
  return rawSimilarity(base, other) * 0.95;
}

const MATCH = 0.75;
const matchesAny = (word: string, candidates: string[]) => candidates.some((candidate) => looseSimilarity(word, candidate) >= MATCH);
/**
 * Cortesía o muletilla. Solo las palabras LARGAS se aproximan: con palabras cortas un error de tipeo cae en
 * otra palabra real ("zero" quedaba como "pero" y "Coca Cola Zero" dejaba de poderse elegir).
 */
const isFiller = (word: string) =>
  FILLER_SET.has(stem(word)) || (word.length >= 6 && [...FILLER_SET].some((filler) => filler.length >= 6 && looseSimilarity(word, filler) >= 0.85));

/** "los dos", "ambos", "uno de cada uno", "todos": quiere todas las opciones mostradas. */
function wantsAll(text: string, total: number) {
  if (/\b(uno de cada|una de cada|de cada uno|de cada una|todos|todas|todito)\b/.test(text)) return true;
  if (total === 2 && /\b(los dos|las dos|ambos|ambas|el par|los 2|las 2)\b/.test(text)) return true;
  if (total === 3 && /\b(los tres|las tres|los 3|las 3)\b/.test(text)) return true;
  return false;
}

const ORDINALS: Record<string, number> = {
  primero: 1, primera: 1, primer: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, tercer: 3,
  cuarto: 4, cuarta: 4, quinto: 5, quinta: 5, sexto: 6, sexta: 6,
};

/** "el primero", "la segunda opción", "el último", "el de la mitad". Devuelve el índice 1..N o 0. */
function ordinalIndex(text: string, total: number) {
  if (/\b(ultimo|ultima|el final|al final)\b/.test(text)) return total;
  if (/\b(penultimo|penultima)\b/.test(text)) return Math.max(1, total - 1);
  const word = Object.entries(ORDINALS).find(([name]) => new RegExp(`\\b${name}\\b`).test(text));
  return word ? word[1] : 0;
}

/** "2", "la 2", "opción 2", "#2", "el numero 2", "la 2 porfa". */
function numericIndex(text: string) {
  const match = text.match(/^(?:(?:el|la|los|las|opcion|numero|num|nro|#|la opcion|el numero)\s*)*#?\s*(\d{1,2})\b/);
  return match ? Number(match[1]) : 0;
}

/** "el de 3.50", "el de $3.75": el precio que el cliente nombró. */
function pricePick<T extends ChoiceOption>(text: string, options: T[]): ChoicePick<T> | null {
  // "el más baratito", "lo más económico": el diminutivo también cuenta.
  if (/\b(?:mas|el|la|lo)\s+(?:barat\w*|economic\w*|comod\w*)\b|\bmenos car\w*\b/.test(text)) {
    const prices = options.map((option) => option.price).filter((price): price is number => typeof price === "number");
    if (prices.length !== options.length) return null;
    const min = Math.min(...prices);
    const cheapest = options.filter((option) => option.price === min);
    return cheapest.length === 1 ? { kind: "one", option: cheapest[0] } : { kind: "several", options: cheapest };
  }
  if (/\b(?:mas|el|la|lo)\s+(?:car[oa]\w*|complet\w*)\b/.test(text)) {
    const prices = options.map((option) => option.price).filter((price): price is number => typeof price === "number");
    if (prices.length !== options.length) return null;
    const max = Math.max(...prices);
    const priciest = options.filter((option) => option.price === max);
    return priciest.length === 1 ? { kind: "one", option: priciest[0] } : { kind: "several", options: priciest };
  }
  const amount = text.match(/\$?\s*(\d{1,3}[.,]\d{2})\b/);
  if (!amount) return null;
  const value = Number(amount[1].replace(",", "."));
  const same = options.filter((option) => typeof option.price === "number" && Math.round(option.price * 100) === Math.round(value * 100));
  if (!same.length) return null;
  return same.length === 1 ? { kind: "one", option: same[0] } : { kind: "several", options: same };
}

/** Cantidad al inicio del mensaje: "2 del verde" → 2. 0 si no la hay. */
function leadingQuantity(text: string) {
  const words: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
  const match = text.match(/^(?:(?:quiero|dame|deme|ponme|agrega|agregame|mejor|si|dale|ok|porfa)\s+)*(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/);
  if (!match) return 0;
  return /^\d+$/.test(match[1]) ? Number(match[1]) : words[match[1]] || 0;
}

/**
 * Cantidad dicha en cualquier parte de la respuesta, siempre pegada a un verbo de pedido: "verde quiero 3",
 * "ponme 2", "que sean tres". Solo se usa cuando el cliente YA nombró la opción, para no confundir un
 * "quiero 2" que en realidad elige la opción 2 de la lista.
 */
function statedQuantity(text: string) {
  const words: Record<string, number> = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
  const match = text.match(
    /\b(?:quiero|quisiera|dame|deme|ponme|pon|agrega|agregame|mandame|manda|llevo|lleva|que sean|seran|serian|sean)\s+(\d{1,2}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/
  );
  if (!match) return 0;
  return /^\d+$/.test(match[1]) ? Number(match[1]) : words[match[1]] || 0;
}

/**
 * Palabras de cada opción que NO comparten todas: son las que de verdad distinguen
 * ("verde", "maduro", "pinton", "crunch" cuando todas son "bolón de queso").
 */
export function distinctiveTokens(options: Array<{ name: string }>) {
  const perOption = options.map((option) => meaningfulTokens(option.name));
  return perOption.map((tokens, index) =>
    tokens.filter((token) => !perOption.every((other, otherIndex) => otherIndex === index || other.some((candidate) => looseSimilarity(token, candidate) >= MATCH)))
  );
}

/** Etiqueta corta para repreguntar mostrando solo lo que diferencia ("Verde", "Crunch Verde"). */
export function distinctiveLabel(option: { name: string }, options: Array<{ name: string }>, index: number) {
  const distinctive = distinctiveTokens(options)[index];
  if (!distinctive.length) return option.name;
  const words = normalizeText(option.name).split(" ");
  const kept = words.filter((word) => distinctive.some((token) => looseSimilarity(token, meaningfulTokens(word)[0] || word) >= MATCH));
  return kept.length ? kept.join(" ") : option.name;
}

/**
 * LO QUE EL CLIENTE DESCARTÓ.
 *
 * "el verde no", "el que no sea maduro", "cualquiera menos la zero", "sin crunch": la negación
 * cambia por completo el pedido. Si no se lee, el bot agrega justo lo que el cliente rechazó y
 * eso llega a la cocina. Devuelve la parte negada del mensaje ("verde") o "" si no hay negación.
 */
export function negatedPhrase(message: string) {
  const text = normalizeText(message);
  if (!text) return "";
  const patterns = [
    /\bque no (?:sea|sean|tenga|tengan|lleve|lleven|venga con)\s+(.+)$/,
    /\bno (?:quiero|queria|quisiera|me gusta|me gustaria|me des|me pongas|pongas|sea|sean)\s+(?:el|la|los|las|un|una|de)?\s*(.+)$/,
    /\b(?:menos|excepto|salvo|aparte de)\s+(?:el|la|los|las|de)?\s*(.+)$/,
    /\bsin\s+(?:el|la|los|las|de)?\s*(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1].trim()) return match[1].trim();
  }
  // "el verde no", "urdesa no porfa": el "no" va al final y niega lo que viene antes.
  const words = text.split(" ").filter(Boolean);
  while (words.length && isFiller(words[words.length - 1]) && words[words.length - 1] !== "no") words.pop();
  const last = words[words.length - 1];
  if (last === "no" || last === "nop" || last === "nel") {
    const rest = words.slice(0, -1).join(" ").trim();
    if (rest && meaningfulTokens(rest).length) return rest;
  }
  return "";
}

/** Opciones que sobreviven a lo que el cliente descartó, o null si la negación no tocó ninguna. */
function rejectNegated<T extends ChoiceOption>(phrase: string, options: T[]): T[] | null {
  const words = meaningfulTokens(phrase).filter((word) => !isFiller(word));
  if (!words.length) return null;
  const distinctive = distinctiveTokens(options);
  const survivors = options.filter((_option, index) => !distinctive[index].some((token) => matchesAny(token, words)));
  return survivors.length === options.length ? null : survivors;
}

/** "cualquiera", "el que sea", "el que me recomiendes", "me da igual": acepta lo que le demos. */
function anyIsFine(text: string) {
  return /\b(cualquiera|cualquier|el que sea|la que sea|lo que sea|como sea|me da igual|da igual|da lo mismo|tu decides|usted decide|el que quieras|la que quieras|el que gustes|el que recomiendes|la que recomiendes|lo que recomiendes|recomiendame|sorprendeme|el que mas vendan|el mas pedido)\b/.test(text);
}

/**
 * Elige entre las opciones mostradas leyendo el mensaje como lo diría una persona.
 * Nunca mira el catálogo: solo estas opciones.
 */
export function pickChoice<T extends ChoiceOption>(message: string, options: T[]): ChoicePick<T> {
  if (!options.length) return { kind: "none", reason: "unclear" };
  const text = normalizeText(message);
  if (!text) return { kind: "none", reason: "unclear" };

  if (wantsAll(text, options.length)) return { kind: "all", options };

  // "el verde no", "el que no sea maduro": primero se descarta lo que NO quiere. Si queda una sola
  // opción es esa; si quedan varias se repregunta entre esas (nunca se agrega lo que rechazó).
  const negated = negatedPhrase(message);
  if (negated) {
    const survivors = rejectNegated(negated, options);
    if (survivors && survivors.length === 1) return { kind: "one", option: survivors[0] };
    if (survivors && survivors.length > 1) {
      // "el verde no, mejor el maduro": si además nombró una, esa gana.
      const chosen = pickByName(text.replace(new RegExp(`\\b${negated.split(" ")[0]}\\b`, "g"), " "), survivors);
      if (chosen.kind === "one") return chosen;
      return { kind: "several", options: survivors, negated };
    }
    if (survivors && !survivors.length) return { kind: "none", reason: "unclear" };
  }

  // "cualquiera", "el que me recomiendes": el cliente ya dijo que sí a lo que le demos.
  if (anyIsFine(text)) return { kind: "one", option: options[0], any: true };

  // "el de 3.50", "el más barato": el precio sale de las opciones reales, no de la IA.
  const byPrice = pricePick(text, options);
  if (byPrice) return byPrice;

  // Por nombre: se compara contra las palabras que DIFERENCIAN a cada opción.
  const byName = pickByName(text, options);
  if (byName.kind === "one") {
    // La cantidad puede ir al inicio ("2 del verde") o pegada al verbo ("y verde quiero 3", "ponme 3").
    const quantity = leadingQuantity(text) || statedQuantity(text);
    return quantity > 1 ? { ...byName, quantity } : byName;
  }

  // Ordinales y números: "el primero", "la segunda opción", "el último", "2", "#2".
  const index = ordinalIndex(text, options.length) || numericIndex(text);
  if (index >= 1 && index <= options.length) return { kind: "one", option: options[index - 1] };

  // "ese mismo", "ese porfa" con una sola opción en pantalla.
  if (options.length === 1 && /\b(ese|esa|eso|este|esta|mismo|misma|dale|sale|va|ok)\b/.test(text)) return { kind: "one", option: options[0] };

  return byName;
}

function pickByName<T extends ChoiceOption>(text: string, options: T[]): ChoicePick<T> {
  const words = meaningfulTokens(text).filter((word) => !isFiller(word));
  if (!words.length) return { kind: "none", reason: "unclear" };

  const perOption = options.map((option) => meaningfulTokens(option.name));
  const distinctive = distinctiveTokens(options);

  const scored = options.map((option, index) => {
    const tokens = perOption[index];
    const own = distinctive[index];
    const distinctiveHits = own.filter((token) => matchesAny(token, words)).length;
    const matched = tokens.filter((token) => matchesAny(token, words));
    return { option, distinctiveHits, unmatched: tokens.length - matched.length, matched: matched.length };
  });

  // Palabras del cliente que no son de ninguna opción ni cortesía: está hablando de otra cosa
  // ("mejor un tigrillo verde"). No se elige a la fuerza: lo resuelve el router como pedido nuevo.
  const allTokens = perOption.flat();
  const foreign = words.filter((word) => word.length >= 4 && !matchesAny(word, allTokens));

  const ranked = [...scored].sort((a, b) => b.distinctiveHits - a.distinctiveHits || a.unmatched - b.unmatched || b.matched - a.matched);
  const best = ranked[0];
  const second = ranked[1];

  const uniqueBest = !second || best.distinctiveHits > second.distinctiveHits || best.unmatched < second.unmatched;

  // "kero el maduro": la palabra que distingue está perfecta y lo único raro es la muletilla mal
  // escrita. No se descarta la elección: se devuelve la candidata y el router revisa si esa palabra
  // suelta es de verdad otro producto del menú antes de decidir.
  if (best.distinctiveHits > 0 && foreign.length && uniqueBest) {
    return { kind: "none", reason: "foreign", words: foreign, best: best.option };
  }

  if (best.distinctiveHits > 0 && !foreign.length) {
    if (uniqueBest) return { kind: "one", option: best.option };
    // Empate real ("el de queso" entre dos que lo son): se repregunta con lo que las diferencia.
    const tied = ranked.filter((item) => item.distinctiveHits === best.distinctiveHits && item.unmatched === best.unmatched).map((item) => item.option);
    return { kind: "several", options: tied };
  }

  // Solo nombró lo que todas comparten ("el de queso", "el bolón"): sigue ambiguo.
  if (!foreign.length && best.matched > 0 && scored.every((item) => item.distinctiveHits === 0)) return { kind: "several", options };

  return { kind: "none", reason: foreign.length ? "foreign" : "unclear", words: foreign.length ? foreign : undefined };
}

/** "el más cercano", "el que esté más cerca": no se puede saber sin la ubicación del cliente. */
export function asksForNearest(message: string) {
  return /\b(mas cercano|mas cerca|mas cercana|cerquita|el que me quede mas cerca|el mas proximo)\b/.test(normalizeText(message));
}
