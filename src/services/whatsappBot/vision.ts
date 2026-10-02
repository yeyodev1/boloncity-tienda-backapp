import axios from "axios";
import { env } from "../../config/env";

/**
 * Lee una imagen que mandó el cliente ({urlTempFile} de BuilderBot) y dice QUÉ es. La IA solo clasifica y,
 * si es comida, dice a qué producto del menú se parece. Lo que se hace con eso lo decide el router: un
 * comprobante nunca da un pedido por pagado (se verifica con PayPhone) y un producto se busca en el catálogo real.
 */

/** "unreadable": no se pudo descargar o leer la imagen (se le pide que la reenvíe). */
export type ImageReading = { kind: "payment" | "product" | "other" | "unreadable"; query?: string };
export type MediaReading = { type: "image"; reading: ImageReading | null } | { type: "unsupported" };

const MAX_BYTES = 6 * 1024 * 1024;

const PROMPT = `Eres el clasificador de imágenes del bot de pedidos de Boloncity (comida típica ecuatoriana).
Devuelve SOLO JSON: {"kind":"payment|product|other","query":""}
- "payment": comprobante, voucher o captura de un pago, transferencia o tarjeta.
- "product": foto o captura (Instagram, web, menú) de comida o bebida. En "query" pon el nombre del producto del MENÚ que más se parece; si ninguno se parece, descríbelo en 2-4 palabras en español.
- "other": cualquier otra cosa. query vacío.
No inventes. No incluyas precios.`;

/** Descarga el archivo temporal y, si es una imagen, la clasifica. Audios, videos y documentos no se procesan. */
export async function readMedia(url: string, menuNames: string[] = [], timeoutMs = 10000): Promise<MediaReading> {
  let data: Buffer;
  let mime: string;
  try {
    const response = await axios.get(url, { responseType: "arraybuffer", timeout: 8000, maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES, headers: { "User-Agent": "BoloncityBot/1.0 (+https://boloncity.com)" } });
    data = Buffer.from(response.data);
    mime = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  } catch (error) {
    console.warn(`[whatsapp-bot] no pude descargar la imagen: ${error instanceof Error ? error.message : error}`);
    return { type: "image", reading: null };
  }
  if (!mime || mime === "application/octet-stream") mime = guessMime(url, data);
  if (!mime.startsWith("image/")) return { type: "unsupported" };
  if (!env.GEMINI_API_KEY) return { type: "image", reading: null };
  try {
    const menu = menuNames.slice(0, 200).join(" | ");
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: data.toString("base64") } }, { text: menu ? `MENÚ: ${menu}` : "Clasifica la imagen" }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 120, thinkingConfig: { thinkingBudget: 0 } },
      },
      { timeout: timeoutMs }
    );
    const text = String(response.data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "");
    const reading = parseReading(text);
    console.log(`[whatsapp-bot] imagen ${mime} → ${reading.kind}${reading.query ? ` "${reading.query}"` : ""} (IA: ${text.replace(/\s+/g, " ").slice(0, 160)})`);
    return { type: "image", reading };
  } catch (error) {
    console.warn(`[whatsapp-bot] la IA no pudo leer la imagen: ${error instanceof Error ? error.message : error}`);
    return { type: "image", reading: null };
  }
}

/** Valida lo que devolvió la IA: enum cerrado y un query corto. Cualquier cosa rara es "other". */
export function parseReading(raw: string): ImageReading {
  try {
    const parsed = JSON.parse(raw);
    const kind = parsed?.kind === "payment" || parsed?.kind === "product" ? parsed.kind : "other";
    const query = typeof parsed?.query === "string" ? parsed.query.replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    return kind === "product" ? { kind, query: query || undefined } : { kind };
  } catch {
    return { kind: "other" };
  }
}

function guessMime(url: string, data: Buffer) {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
  if (data.slice(0, 4).toString() === "RIFF" && data.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (/\.(jpe?g)(\?|$)/i.test(url)) return "image/jpeg";
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  if (/\.webp(\?|$)/i.test(url)) return "image/webp";
  return "application/octet-stream";
}
