/**
 * Normaliza un teléfono a código de país + número local.
 *
 * Nació con ORD-00152: el checkout arma el teléfono como "<código> <número>" y la
 * clienta escribió el número YA con prefijo, así que quedó "+593 +593968434421".
 * El parser viejo no sabía qué hacer con el "+" del medio y mandaba a Picker un
 * "número" con letras raras, Picker respondía 422 "Phone number is invalid" y el
 * pedido se quedaba sin motorizado.
 *
 * Acepta las formas que de verdad llegan: "+593 968434421", "+593 +593968434421",
 * "593593968434421", "0968434421", "968434421", "(09) 6843-4421".
 */

// Los mismos códigos que ofrece el selector del checkout. Se prueban del más
// largo al más corto para que "1" no se coma el "1" inicial de otro país.
const KNOWN_COUNTRY_CODES = ["593", "57", "51", "54", "52", "1"];

export interface NormalizedPhone {
  /** Código de país sin "+", p. ej. "593". */
  code: string;
  /** Número local sin ceros a la izquierda, p. ej. "968434421". */
  number: string;
  /** Formato E.164, p. ej. "+593968434421". */
  e164: string;
}

export function normalizePhone(raw: unknown, defaultCode = "593"): NormalizedPhone | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  // Un "+" o un "00" al inicio dicen explícitamente que lo que sigue es código de país.
  const explicitIntl = /^\s*(\+|00)/.test(text);
  let digits = text.replace(/\D+/g, "");
  if (explicitIntl && digits.startsWith("00")) digits = digits.slice(2);
  if (!digits) return null;

  let code = "";
  let local = digits;

  // Sin "+", un número local ecuatoriano ("0968434421" / "968434421") se respeta tal
  // cual: no se intenta leer un código de país dentro de él.
  const looksLocalEc = !explicitIntl && (/^0?9\d{8}$/.test(digits) || /^0?[2-7]\d{6,7}$/.test(digits));
  if (!looksLocalEc) {
    const found = KNOWN_COUNTRY_CODES.find((candidate) => digits.startsWith(candidate) && digits.length > candidate.length + 5);
    if (found) {
      code = found;
      local = digits.slice(found.length);
      // Prefijo duplicado ("593 593968434421"): se quita mientras lo que quede siga
      // teniendo tamaño de número y no de código.
      while (local.startsWith(code) && local.length - code.length >= 7) {
        local = local.slice(code.length);
      }
    }
  }

  if (!code) code = defaultCode;
  local = local.replace(/^0+/, "");

  if (local.length < 6 || local.length > 12) return null;

  return { code, number: local, e164: `+${code}${local}` };
}
