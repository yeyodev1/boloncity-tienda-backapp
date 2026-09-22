import { Product } from "../../models/Product";
// Registra el modelo para el populate de categorías aunque ninguna otra ruta lo haya cargado.
import "../../models/Category";
import { isAvailableAt } from "../../utils/productAvailability";

/**
 * Buscador del catálogo para el bot de WhatsApp.
 *
 * El bot NO le pasa el menú completo a la IA: la IA solo extrae lo que el cliente
 * pidió ("bolón mixto", 2) y aquí se busca contra los productos reales de la
 * sucursal. Así el prompt mide lo mismo con 190 o con 2000 productos, y el precio
 * y la disponibilidad salen siempre de Mongo.
 *
 * El menú de Boloncity es muy ambiguo a propósito: "bolón de queso" existe en verde,
 * maduro, pintón, crunch, mini, medio, agrandado, combo y congelado. Por eso la
 * búsqueda no adivina: si hay empate, devuelve las opciones para que el bot pregunte.
 */

export interface CatalogProduct {
  productId: string;
  name: string;
  /** Precio en dólares, ya con el precio de la sucursal si existe. */
  price: number;
  categoryNames: string[];
  tags: string[];
}

export type SearchResult =
  | { kind: "exact"; product: CatalogProduct }
  | { kind: "ambiguous"; options: CatalogProduct[] }
  | { kind: "none"; suggestions: CatalogProduct[] };

const STOPWORDS = new Set([
  "de", "del", "con", "y", "e", "o", "u", "el", "la", "lo", "los", "las", "un", "una", "uno", "unos", "unas", "al", "a", "en",
  "por", "para", "favor", "porfa", "porfavor", "porfis", "quiero", "quisiera", "queria", "dame", "deme", "denme", "me", "mi",
  "mis", "regalame", "necesito", "pideme", "pedir", "ordenar", "orden", "agrega", "agregame", "agregar", "anade", "anademe",
  "pon", "ponme", "tambien", "mas", "otro", "otra", "otros", "otras", "que", "sea", "sean", "solo", "nomas", "hola", "buenas",
  "buenos", "dias", "tardes", "noches", "gracias", "tipo", "algo", "tienen", "tiene", "hay", "vende", "venden", "llevar",
  "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "docena",
]);

/**
 * Palabras que marcan una variante "no obvia" del producto. Si el cliente no las
 * dice, esa variante pierde contra la normal: quien pide "bolón de queso" quiere
 * el bolón, no el agrandado, el combo ni la caja congelada.
 */
const VARIANT_WORDS = new Set([
  "agrandar", "envase", "contenedor", "cubiertos", "servilletas", "syrup", "funda", "congelado", "caja", "extra", "combo",
  "2x1", "apps", "promo", "mini", "medio", "media", "mega", "kids", "regalo", "bot", "cc", "70cc", "250ml", "porcion",
  // Productos exclusivos de apps de delivery: no se venden por este canal salvo que el cliente los nombre.
  "uber", "rappi", "pedidosya",
]);

/** Sinónimos que el cliente usa y no están en el nombre del producto. */
const SYNONYMS: Record<string, string> = {
  cafecito: "cafe",
  tinto: "cafe",
  cocacola: "coca",
  coke: "coca",
  gaseosa: "cola",
  cola: "cola",
  tigrillos: "tigrillo",
  trigrillo: "tigrillo",
  bolo: "bolon",
  bolones: "bolon",
  chicharon: "chicharron",
  mixta: "mixto",
  mixtas: "mixto",
  jugito: "jugo",
  naranjada: "naranja",
  capuchino: "capuccino",
  cappuccino: "capuccino",
  batida: "batido",
  milkshake: "milkshake",
  batido: "batido",
  humitas: "humita",
  empanaditas: "empanada",
  tomar: "bebida",
  beber: "bebida",
  bebestible: "bebida",
};

export function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9$.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Plural simple del español: bolones → bolon, tigrillos → tigrillo, verdes → verde. */
export function stem(word: string) {
  if (word.length <= 3) return word;
  if (word.endsWith("ones")) return word.slice(0, -2);
  if (/[aeiou]s$/.test(word)) return word.slice(0, -1);
  return word;
}

function toToken(word: string) {
  // "cafecitos" → cafecito → cafe: el sinónimo se busca también en singular.
  return stem(SYNONYMS[word] || SYNONYMS[stem(word)] || word);
}

/** Tokens con significado: sin stopwords, sin números sueltos ni precios ("4.99", "$5.99"). */
export function meaningfulTokens(value: unknown) {
  const tokens = normalizeText(value)
    .split(" ")
    .filter((word) => word && !STOPWORDS.has(word) && !/^\$?\d+([.,]\d+)?$/.test(word) && word !== "x");
  return [...new Set(tokens.map(toToken))];
}

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

/** Qué tan parecido es un token del cliente a un token del producto (0 = nada, 1 = igual). */
export function tokenSimilarity(query: string, candidate: string) {
  if (query === candidate) return 1;
  if (query.replace(/e$/, "") === candidate.replace(/e$/, "")) return 1;
  const shortest = Math.min(query.length, candidate.length);
  // "chicha" → "chicharron". Solo en esa dirección: que el producto contenga lo escrito.
  if (query.length >= 4 && candidate.startsWith(query)) return 0.85;
  if (shortest >= 5 && levenshtein(query, candidate) <= 1) return 0.85;
  if (shortest >= 8 && levenshtein(query, candidate) <= 2) return 0.7;
  return 0;
}

const MATCH_THRESHOLD = 0.7;

interface Scored {
  product: CatalogProduct;
  coverage: number;
  score: number;
  /** Sin palabras de más ni variantes: "BOLON MIXTO VERDE" para "bolón mixto verde". */
  perfect: boolean;
  /** true si el nombre tiene una variante que el cliente no pidió (combo, mini, uber…). */
  isVariant: boolean;
}

export function scoreProduct(queryTokens: string[], product: CatalogProduct): Scored {
  const nameTokens = meaningfulTokens(product.name);
  const extraTokens = meaningfulTokens([...product.categoryNames, ...product.tags].join(" "));
  const matchedName = new Set<string>();
  let matchSum = 0;

  for (const queryToken of queryTokens) {
    let best = 0;
    let bestToken = "";
    for (const nameToken of nameTokens) {
      const similarity = tokenSimilarity(queryToken, nameToken);
      if (similarity > best) {
        best = similarity;
        bestToken = nameToken;
      }
    }
    if (best >= MATCH_THRESHOLD) {
      matchedName.add(bestToken);
      matchSum += best;
      continue;
    }
    // Categoría o tags valen menos que el nombre: "bebida" encuentra el jugo, pero
    // un nombre que dice "jugo" gana.
    const extraBest = Math.max(0, ...extraTokens.map((token) => tokenSimilarity(queryToken, token)));
    if (extraBest >= MATCH_THRESHOLD) matchSum += extraBest * 0.6;
  }

  const coverage = queryTokens.length ? matchSum / queryTokens.length : 0;
  const unmatched = nameTokens.filter((token) => !matchedName.has(token));
  const variantPenalty = unmatched.filter((token) => VARIANT_WORDS.has(token)).length * 0.15;
  const score = coverage - unmatched.length * 0.04 - variantPenalty;
  return { product, coverage, score, perfect: coverage >= 0.99 && unmatched.length === 0, isVariant: variantPenalty > 0 };
}

const TIE_MARGIN = 0.1;
const MAX_OPTIONS = 6;

/** Clasifica la búsqueda en exacta, ambigua (hay que preguntar) o sin resultados. Pura: se prueba sin base de datos. */
export function rankProducts(query: string, products: CatalogProduct[]): SearchResult {
  const queryTokens = meaningfulTokens(query);
  if (!queryTokens.length) return { kind: "none", suggestions: [] };

  const scored = products.map((product) => scoreProduct(queryTokens, product)).sort((a, b) => b.score - a.score);
  // Match completo = todas las palabras del cliente aparecen (con tolerancia a tildes, plurales y typos).
  const complete = scored.filter((item) => item.coverage >= 0.8);

  if (!complete.length) {
    // "bebidas", "algo de tomar": ningún nombre coincide, pero sí una categoría → se ofrecen sus productos.
    const byCategory = scored.filter((item) => {
      const categoryTokens = meaningfulTokens(item.product.categoryNames.join(" "));
      return queryTokens.every((token) => categoryTokens.some((candidate) => tokenSimilarity(token, candidate) >= 0.85));
    });
    if (byCategory.length) return { kind: "ambiguous", options: byCategory.filter((item) => !item.isVariant).slice(0, MAX_OPTIONS).map((item) => item.product) };
    return { kind: "none", suggestions: scored.filter((item) => item.coverage >= 0.5).slice(0, 3).map((item) => item.product) };
  }

  const perfect = complete.filter((item) => item.perfect);
  if (perfect.length === 1) return { kind: "exact", product: perfect[0].product };

  const top = complete[0];
  const tied = complete.filter((item) => top.score - item.score < TIE_MARGIN);
  if (tied.length === 1) {
    // Única coincidencia pero es una variante ("mini bolón" → solo existe un combo): se confirma, no se agrega a ciegas.
    return top.isVariant ? { kind: "ambiguous", options: [top.product] } : { kind: "exact", product: top.product };
  }

  return { kind: "ambiguous", options: tied.slice(0, MAX_OPTIONS).map((item) => item.product) };
}

/**
 * Elige entre las opciones que el bot ya mostró. Acepta el número ("2", "la segunda")
 * o el nombre de la variante ("maduro", "el de pintón").
 */
export function pickOption<T extends { name: string }>(message: string, options: T[]): T | null {
  const text = normalizeText(message);
  const ordinals: Record<string, number> = {
    primero: 1, primera: 1, segundo: 2, segunda: 2, tercero: 3, tercera: 3, cuarto: 4, cuarta: 4, quinto: 5, quinta: 5, sexto: 6, sexta: 6,
  };
  const numeric = text.match(/^(?:el|la|opcion|numero|#)?\s*(\d{1,2})\b/);
  const index = numeric ? Number(numeric[1]) : Object.entries(ordinals).find(([word]) => new RegExp(`\\b${word}\\b`).test(text))?.[1];
  if (index && index >= 1 && index <= options.length) return options[index - 1];

  const tokens = meaningfulTokens(text);
  if (!tokens.length) return null;
  // Se puntúa solo contra las opciones mostradas: "maduro" basta porque las demás no lo tienen.
  const scored = options
    .map((option) => {
      const optionTokens = meaningfulTokens(option.name);
      const hits = tokens.filter((token) => optionTokens.some((candidate) => tokenSimilarity(token, candidate) >= MATCH_THRESHOLD)).length;
      return { option, hits, extra: optionTokens.length };
    })
    .filter((item) => item.hits === tokens.length)
    .sort((a, b) => a.extra - b.extra);
  if (scored.length === 1) return scored[0].option;
  if (scored.length > 1 && scored[0].extra < scored[1].extra) return scored[0].option;
  return null;
}

// ─── Carga desde Mongo ───────────────────────────────────────────────────────

let cache: { at: number; products: any[] } | null = null;
const CACHE_MS = 60_000;

async function loadRawProducts() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.products;
  const products = await Product.find({ isAvailable: true })
    .select("name price branchPrices branches unavailableBranches isAvailable stock sellWithoutStock tags categories")
    .populate("categories", "name")
    .lean();
  cache = { at: Date.now(), products };
  return products;
}

function toCatalogProduct(raw: any, branchId?: string): CatalogProduct {
  const branchPrice = branchId ? raw.branchPrices?.find((item: any) => String(item.branch) === branchId)?.price : undefined;
  return {
    productId: String(raw._id),
    name: raw.name,
    price: Number(branchPrice ?? raw.price) || 0,
    categoryNames: (raw.categories || []).map((category: any) => category?.name).filter(Boolean),
    tags: raw.tags || [],
  };
}

/** Productos vendibles hoy. Con sucursal: solo los disponibles ahí y con su precio. */
export async function loadCatalog(branchId?: string): Promise<CatalogProduct[]> {
  const raw = await loadRawProducts();
  return raw
    .filter((product: any) => product.sellWithoutStock !== false || product.stock > 0)
    .filter((product: any) => (branchId ? isAvailableAt(product, branchId) : true))
    .filter((product: any) => Number(product.price) > 0)
    .map((product: any) => toCatalogProduct(product, branchId));
}

export async function searchCatalog(query: string, branchId?: string) {
  return rankProducts(query, await loadCatalog(branchId));
}

/**
 * Categorías internas del POS (grupos de cocina/caja, stock, empaques, adicionales): existen para operar,
 * no para que el cliente elija. No se muestran en el menú del bot.
 */
const INTERNAL_CATEGORY = /^(cocina|caja|general)$|stockeable|agrandar|contenedor|desechable|empaque|adicional|jalea|^extra |extra para|congelado/;

export function isCustomerCategory(name: string) {
  return !INTERNAL_CATEGORY.test(normalizeText(name));
}

/** Nombre de categoría para mostrar al cliente (corrige erratas del POS como "Trigrillos"). */
export function displayCategoryName(name: string) {
  return name.replace(/\btrigrillo/gi, (match) => (match[0] === "T" ? "Tigrillo" : "tigrillo"));
}

export function listCategories(products: CatalogProduct[]) {
  const counts = new Map<string, number>();
  for (const product of products) {
    for (const name of product.categoryNames) {
      if (isCustomerCategory(name)) counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => displayCategoryName(a.name).localeCompare(displayCategoryName(b.name)));
}

/**
 * La categoría que nombra el mensaje ("menú de jugos" → JUGOS, no JUGO DE BISTEC). Gana la que el mensaje
 * cubre más completa; si empatan, la que tiene más productos. Con `exactOnly`, el mensaje debe ser solo
 * el nombre de la categoría ("bebidas"), para no confundir un pedido con una consulta de menú.
 */
export function findCategory(message: string, categories: Array<{ name: string; count: number }>, { exactOnly = false } = {}) {
  const ignore = new Set(["menu", "carta", "catalogo", "producto", "opcion", "recomienda", "recomiendas", "recomendacion", "ver", "muestrame", "mostrar"]);
  const tokens = meaningfulTokens(message).filter((token) => !ignore.has(token));
  if (!tokens.length) return undefined;
  const scored = categories
    .map((category) => {
      const names = meaningfulTokens(category.name);
      const covered = names.filter((name) => tokens.some((token) => tokenSimilarity(token, name) >= 0.85)).length;
      const used = tokens.filter((token) => names.some((name) => tokenSimilarity(token, name) >= 0.85)).length;
      return { category, coverage: names.length ? covered / names.length : 0, used };
    })
    .filter((item) => item.used > 0 && (!exactOnly || (item.coverage === 1 && item.used === tokens.length)))
    .sort((a, b) => b.coverage - a.coverage || b.used - a.used || b.category.count - a.category.count);
  return scored[0]?.category;
}
