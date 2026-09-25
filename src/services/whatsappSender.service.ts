import axios from "axios";
import { normalizePhone } from "../utils/phone";

/**
 * ENVIO DE WHATSAPP SALIENTE.
 *
 * Hasta ahora el bot solo RESPONDIA: BuilderBot lo llamaba y el contestaba. Para el carrito
 * abandonado hace falta lo contrario — escribirle primero a alguien que no nos escribio —, y
 * eso no existia en el sistema.
 *
 * Se deja enchufable a proposito: el resto del feature no depende de que canal se use, y el dia
 * que cambien de proveedor se toca solo este archivo.
 *
 * OJO, LA REGLA DE META QUE MANDA SOBRE TODO ESTO: un mensaje que INICIA el negocio fuera de la
 * ventana de 24 horas desde el ultimo mensaje del cliente tiene que ser una PLANTILLA APROBADA
 * por Meta, y se cobra por conversacion. Quien abandona un carrito en la web nunca le escribio al
 * bot, asi que ahi NO hay ventana: siempre es plantilla. Mandar texto libre no falla en nuestro
 * codigo, falla del lado de Meta y el cliente no recibe nada.
 */

export type WhatsappChannel = "builderbot" | "meta" | "none";

export interface WhatsappSendResult {
  sent: boolean;
  channel: WhatsappChannel;
  /** Motivo tecnico cuando no salio. Va a la auditoria del carrito, no al cliente. */
  error?: string;
}

/**
 * Que canal esta configurado. Se resuelve en cada llamada (no al importar) para que encender
 * el canal sea cargar una variable de entorno y redesplegar, sin tocar codigo.
 */
export function whatsappChannel(): WhatsappChannel {
  if (process.env.BUILDERBOT_API_KEY && process.env.BUILDERBOT_SEND_URL) return "builderbot";
  if (process.env.META_WHATSAPP_TOKEN && process.env.META_WHATSAPP_PHONE_ID) return "meta";
  return "none";
}

/** ¿Se puede escribir a ese numero? Un telefono que no normaliza no llega a ningun lado. */
export function isSendablePhone(phone?: string): boolean {
  return Boolean(normalizePhone(phone || "")?.e164);
}

interface SendInput {
  phone: string;
  /** Texto plano. Solo sirve dentro de la ventana de 24h o en canales que no la exigen. */
  message: string;
  /** Plantilla aprobada por Meta. Obligatoria para iniciar conversacion fuera de la ventana. */
  template?: { name: string; language?: string; variables?: string[] };
}

export async function sendWhatsapp({ phone, message, template }: SendInput): Promise<WhatsappSendResult> {
  const channel = whatsappChannel();
  const e164 = normalizePhone(phone)?.e164;
  if (!e164) return { sent: false, channel, error: `Telefono invalido: "${phone}"` };
  // Sin canal no se inventa un exito: el carrito queda pendiente y el tablero lo muestra como
  // "listo para enviar, falta canal". Preferible un contador en cero que una metrica mentirosa.
  if (channel === "none") return { sent: false, channel, error: "Sin canal de WhatsApp configurado" };

  try {
    if (channel === "builderbot") {
      await axios.post(
        String(process.env.BUILDERBOT_SEND_URL),
        { number: e164.replace("+", ""), message },
        {
          headers: {
            "x-api-builderbot": String(process.env.BUILDERBOT_API_KEY),
            "Content-Type": "application/json",
          },
          timeout: 10000,
        }
      );
      return { sent: true, channel };
    }

    // Meta Cloud API. Con plantilla cuando la hay (el caso normal del carrito abandonado);
    // texto plano solo sirve si el cliente escribio en las ultimas 24 horas.
    const body = template
      ? {
          messaging_product: "whatsapp",
          to: e164.replace("+", ""),
          type: "template",
          template: {
            name: template.name,
            language: { code: template.language || "es" },
            components: template.variables?.length
              ? [{ type: "body", parameters: template.variables.map((text) => ({ type: "text", text })) }]
              : undefined,
          },
        }
      : {
          messaging_product: "whatsapp",
          to: e164.replace("+", ""),
          type: "text",
          text: { body: message },
        };

    await axios.post(`https://graph.facebook.com/v21.0/${process.env.META_WHATSAPP_PHONE_ID}/messages`, body, {
      headers: {
        Authorization: `Bearer ${process.env.META_WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
    return { sent: true, channel };
  } catch (error) {
    // El motivo real viene en el cuerpo de la respuesta; "status code 400" no sirve para nada.
    const detalle = axios.isAxiosError(error)
      ? error.response?.data?.error?.message || JSON.stringify(error.response?.data || {}).slice(0, 200)
      : error instanceof Error
        ? error.message
        : "Error desconocido";
    return { sent: false, channel, error: detalle };
  }
}
