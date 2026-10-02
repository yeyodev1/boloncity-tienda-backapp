import axios from "axios";
import { env } from "../../config/env";

/**
 * Voz del bot. El router arma el texto con plantillas (lo que se dice lo decide el backend) y aquí solo se
 * le da forma: presentación, filtro de signos y, opcionalmente, una reescritura con Gemini para que dos
 * respuestas seguidas no suenen iguales. La reescritura nunca puede cambiar datos: si toca algo protegido,
 * se manda la plantilla original.
 */

export function botName() {
  return String(process.env.BOT_NAME || "").trim() || "Boloncity Bot";
}

/** Presentación obligatoria (Meta): el cliente sabe desde el primer mensaje que habla con un bot. */
export function botIntro(name = botName()) {
  return `Hola 👋 Soy ${name}, el bot de Boloncity y tu agente para lo que necesites 🫓`;
}

/** Signos solo al final: nunca ¿ ni ¡ (estilo de la marca). Vale para las plantillas y para lo que escribe la IA. */
export function stripOpeningMarks(text: string) {
  return String(text || "").replace(/[¿¡]/g, "");
}

/** ¿Está encendida la reescritura con IA? BOT_AI_VOICE=0 la apaga; sin GEMINI_API_KEY no hay nada que encender. */
export function aiVoiceOn() {
  return process.env.BOT_AI_VOICE !== "0" && Boolean(env.GEMINI_API_KEY);
}

const URL = /https?:\/\/\S+/g;
const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
const BOLD = /\*[^*\n]+\*/g;
const CODE = /\b(?:ORD|MP)-[\w-]+/g;
const NUMBER = /\d+(?:[.,:]\d+)*/g;
/** Palabras que la IA borraba al reescribir y que la política de transparencia necesita. */
const KEPT_WORDS = [/\bbot\b/gi, /\bagente\b/gi, /lo que necesites/gi, /\bsiempre\b/gi];
/** Renglones de lista, cuentas o resumen: viñeta, número de opción o un monto. Se copian idénticos. */
const PROTECTED_LINE = /^\s*(?:[•\-–]|\d+[.)]|\d️?⃣)|\$\s?\d/;
/**
 * Palabras de ESTADO del pedido, del pago o de la entrega. La IA no puede agregar ni quitar ninguna: en una
 * prueba cambió "tu pedido ya está registrado" por "ya está en camino" con una tarjeta sin pagar.
 */
const STATE_WORDS = [
  /\bregistrad[oa]s?\b/gi, /\ben camino\b/gi, /\bpagad[oa]s?\b/gi, /\bpendiente\w*/gi, /\bconfirmad[oa]s?\b/gi,
  /\bcread[oa]s?\b/gi, /\bcancelad[oa]s?\b/gi, /\bentregad[oa]s?\b/gi, /\blist[oa] para\b/gi, /\bprogramad[oa]s?\b/gi,
  /\bcerrad[oa]s?\b/gi, /\babiert[oa]s?\b/gi, /\bcocina\b/gi, /\bmotorizad[oa]\b/gi, /\befectivo\b/gi, /\btarjeta\b/gi,
  /\btransferencia\w*/gi, /\bdelivery\b/gi, /\bretir\w*/gi, /\bgratis\b/gi, /\bdescuento\w*/gi, /\bpromo\w*/gi,
  /\breembols\w*/gi, /\bfactura\w*/gi, /\bno\b/gi, /\btodav[ií]a\b/gi, /\ba[uú]n\b/gi, /\bya\b/gi,
];
/** Saludo al inicio del mensaje ("Hola", "¡Hola!", "Holaa", "Buenas"). */
const GREETING = /^[\s¡¿]*(hola+|buenas|buenos dias|buenas tardes|buenas noches|hey|ey)\b/i;
/** La IA no puede decir que es una persona. */
const CLAIMS_HUMAN = /\bsoy (?:una |un )?(?:persona|humano|humana|ser humano)\b|\bno soy (?:un )?bot\b/i;

const count = (text: string, pattern: RegExp) => (text.match(pattern) || []).length;
const tokens = (text: string, pattern: RegExp) => (text.match(pattern) || []).map((token) => token.trim());

/**
 * ¿La reescritura conserva todo lo que no se puede tocar? Listas y montos idénticos, negritas, números, links,
 * correos, códigos de pedido y las palabras de transparencia; sin decir que es persona; sin alargarse más de 30 %.
 */
export function isSafeRewrite(original: string, rewritten: string) {
  const text = String(rewritten || "").trim();
  if (!text) return false;
  if (text.length > Math.max(original.length * 1.3, original.length + 12)) return false;
  if (CLAIMS_HUMAN.test(text) && !CLAIMS_HUMAN.test(original)) return false;
  // No saluda a mitad de la conversación ("Hola! tu pago aún no llega").
  if (GREETING.test(text) && !GREETING.test(original)) return false;
  // Una viñeta con * rompe las negritas de WhatsApp.
  if (/^\s*\*\s/m.test(text)) return false;
  // Cada renglón de lista o con montos debe seguir siendo un renglón idéntico (ni en negrita ni partido).
  const lines = new Set(text.split("\n").map((line) => line.trim()));
  for (const line of original.split("\n")) {
    if (line.trim() && PROTECTED_LINE.test(line) && !lines.has(line.trim())) return false;
  }
  // Ni negritas nuevas: WhatsApp las usa para lo que el cliente tiene que escribir (*confirmo*, *asesor*).
  if (count(text, BOLD) !== count(original, BOLD)) return false;
  for (const pattern of [BOLD, URL, EMAIL, CODE]) {
    const remaining = tokens(text, pattern);
    for (const token of tokens(original, pattern)) {
      const index = remaining.indexOf(token);
      if (index < 0) return false;
      remaining.splice(index, 1);
    }
  }
  // Los números (precios, cantidades, horas) deben ser exactamente los mismos: ni perder uno ni inventar otro.
  const before = tokens(original, NUMBER).sort().join("|");
  const after = tokens(text, NUMBER).sort().join("|");
  if (before !== after) return false;
  if (!KEPT_WORDS.every((pattern) => count(text, pattern) >= count(original, pattern))) return false;
  return STATE_WORDS.every((pattern) => count(text, pattern) === count(original, pattern));
}

const VOICE_PROMPT = `Reescribes los mensajes de WhatsApp del bot de Boloncity (comida típica ecuatoriana) para que no suenen repetidos.
Tono: amigable, cercano, tuteas, con algún emoji. Sin formalidad.
Reglas OBLIGATORIAS:
- Mismo significado y misma información. No agregues datos, ofertas, precios ni promesas.
- No agregues saludos ("Hola", "Ey") si el original no saluda: la conversación ya está en curso.
- Copia IDÉNTICO: todo lo que está entre asteriscos (*así*), cada renglón de lista o con montos, los números, links, correos y códigos (ORD-…).
- Conserva las palabras "bot", "agente", "lo que necesites" y "siempre" si aparecen.
- Nunca digas que eres una persona. Nunca uses * como viñeta.
- Nunca empieces una frase con ¿ ni ¡ (los signos van solo al final).
- No más largo que el original. Responde SOLO con el mensaje reescrito.`;

/**
 * Reescribe la respuesta con Gemini, distinta a los últimos mensajes del bot. Ante cualquier duda (error,
 * timeout, cambio de datos) devuelve la plantilla original: la voz es un adorno, nunca un riesgo.
 */
export async function rewriteWithVoice(reply: string, recentReplies: string[] = [], timeoutMs = 6000): Promise<{ text: string; rewritten: boolean }> {
  const original = String(reply || "");
  if (!aiVoiceOn() || original.trim().length < 12) return { text: original, rewritten: false };
  try {
    const recent = recentReplies.filter(Boolean).slice(-3).map((text, index) => `${index + 1}. ${text.slice(0, 400)}`).join("\n");
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        systemInstruction: { parts: [{ text: VOICE_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: `${recent ? `Últimos mensajes del bot (no los repitas):\n${recent}\n\n` : ""}Mensaje a reescribir:\n${original}` }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
      },
      { timeout: timeoutMs }
    );
    const text = String(response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "").trim();
    if (isSafeRewrite(original, text)) return { text, rewritten: true };
    return { text: original, rewritten: false };
  } catch {
    return { text: original, rewritten: false };
  }
}
