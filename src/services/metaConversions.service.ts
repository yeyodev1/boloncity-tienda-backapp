import crypto from "crypto";
import { Request } from "express";
import axios from "axios";
import { env } from "../config/env";

/**
 * Conversions API de Meta (el "pixel del lado del servidor").
 *
 * El pixel del navegador se pierde seguido: bloqueadores, iOS, o simplemente una
 * pestaña que se cierra antes de que cargue fbevents.js. Por eso cada evento viaja
 * dos veces —una desde el navegador y otra desde aquí— con el MISMO `event_id`:
 * Meta ve las dos, reconoce que son el mismo hecho y solo cuenta una
 * (deduplicación). Sin ese id compartido cada compra se contaria doble.
 *
 * Nada de lo que pasa aqui puede tumbar un pedido: los errores se registran y
 * se tragan. Vender siempre gana sobre medir.
 */

const GRAPH_VERSION = "v21.0";

/** Los unicos eventos que la tienda envia hoy. Ver docs/meta-pixel.md. */
export type MetaEventName =
  | "PageView"
  | "ViewContent"
  | "AddToCart"
  | "InitiateCheckout"
  | "Purchase";

export const META_EVENT_NAMES: MetaEventName[] = [
  "PageView",
  "ViewContent",
  "AddToCart",
  "InitiateCheckout",
  "Purchase",
];

export interface MetaContent {
  id: string;
  quantity?: number;
  item_price?: number;
}

export interface MetaCustomData {
  currency?: string;
  value?: number;
  content_type?: "product" | "product_group";
  content_ids?: string[];
  content_name?: string;
  content_category?: string;
  contents?: MetaContent[];
  num_items?: number;
  order_id?: string;
  search_string?: string;
}

/** Datos del cliente SIN hashear: este servicio los normaliza y hashea antes de enviarlos. */
export interface MetaUserData {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  externalId?: string;
  /** Cookies del pixel en el navegador; viajan en claro, Meta las espera asi. */
  fbp?: string;
  fbc?: string;
  clientIpAddress?: string;
  clientUserAgent?: string;
}

export interface MetaEventInput {
  eventName: MetaEventName;
  /** Compartido con el navegador para deduplicar. Ej: `purchase-ORD-00095`. */
  eventId: string;
  eventTime?: number;
  eventSourceUrl?: string;
  actionSource?: "website" | "system_generated";
  userData?: MetaUserData;
  customData?: MetaCustomData;
}

export function isMetaConfigured(): boolean {
  return Boolean(env.META_PIXEL_ID && env.META_CAPI_ACCESS_TOKEN);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Meta exige minusculas y sin espacios antes del hash, si no el match no pega. */
function hashPlain(value?: string): string | undefined {
  const clean = String(value || "").trim().toLowerCase();
  return clean ? sha256(clean) : undefined;
}

function hashEmail(value?: string): string | undefined {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean.includes("@")) return undefined;
  return sha256(clean);
}

/**
 * El telefono va solo en digitos y CON codigo de pais. Los numeros ecuatorianos
 * se guardan como "+593 0991234567" o "0991234567"; ambos casos terminan en
 * 593991234567.
 */
function hashPhone(value?: string): string | undefined {
  let digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return undefined;
  if (digits.startsWith("593")) {
    digits = `593${digits.slice(3).replace(/^0+/, "")}`;
  } else {
    digits = `593${digits.replace(/^0+/, "")}`;
  }
  return digits.length >= 8 ? sha256(digits) : undefined;
}

/** Los nombres van sin acentos ni puntuacion: "José Pérez" -> "jose". */
function hashName(value?: string): string | undefined {
  const clean = String(value || "")
    .normalize("NFD")
    .replace(/[^a-zA-Z]/g, "")
    .toLowerCase();
  return clean ? sha256(clean) : undefined;
}

function buildUserDataPayload(userData: MetaUserData = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  const em = hashEmail(userData.email);
  const ph = hashPhone(userData.phone);
  const fn = hashName(userData.firstName);
  const ln = hashName(userData.lastName);
  const ct = hashName(userData.city);
  const st = hashName(userData.state);
  const zp = hashPlain(userData.zip);
  const country = hashPlain(userData.country);
  const externalId = hashPlain(userData.externalId);

  // Meta espera arrays para los campos hasheados de identidad.
  if (em) payload.em = [em];
  if (ph) payload.ph = [ph];
  if (fn) payload.fn = [fn];
  if (ln) payload.ln = [ln];
  if (ct) payload.ct = [ct];
  if (st) payload.st = [st];
  if (zp) payload.zp = [zp];
  if (country) payload.country = [country];
  if (externalId) payload.external_id = [externalId];

  // Estos NO se hashean: son identificadores del navegador, no datos personales.
  if (userData.fbp) payload.fbp = userData.fbp;
  if (userData.fbc) payload.fbc = userData.fbc;
  if (userData.clientIpAddress) payload.client_ip_address = userData.clientIpAddress;
  if (userData.clientUserAgent) payload.client_user_agent = userData.clientUserAgent;

  return payload;
}

function buildCustomDataPayload(customData: MetaCustomData = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  if (customData.currency) payload.currency = customData.currency;
  if (typeof customData.value === "number" && Number.isFinite(customData.value)) {
    payload.value = Math.round(customData.value * 100) / 100;
  }
  if (customData.content_type) payload.content_type = customData.content_type;
  if (customData.content_ids?.length) payload.content_ids = customData.content_ids;
  if (customData.content_name) payload.content_name = customData.content_name;
  if (customData.content_category) payload.content_category = customData.content_category;
  if (customData.contents?.length) payload.contents = customData.contents;
  if (typeof customData.num_items === "number") payload.num_items = customData.num_items;
  if (customData.order_id) payload.order_id = customData.order_id;
  if (customData.search_string) payload.search_string = customData.search_string;

  return payload;
}

/**
 * Saca del request lo que Meta usa para emparejar al visitante: IP real (detras de
 * Vercel viene en x-forwarded-for), user agent y las cookies del pixel.
 */
export function metaUserDataFromRequest(req: Request): MetaUserData {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  const clientIpAddress = forwarded.split(",")[0]?.trim() || req.socket?.remoteAddress || undefined;

  return {
    clientIpAddress: clientIpAddress || undefined,
    clientUserAgent: String(req.headers["user-agent"] || "") || undefined,
  };
}

/**
 * Envia un evento a Meta. Nunca lanza: si el pixel no esta configurado o Meta
 * responde mal, se registra y la vida sigue.
 *
 * @returns true si Meta acepto el evento.
 */
export async function sendMetaEvent(input: MetaEventInput): Promise<boolean> {
  if (!isMetaConfigured()) return false;

  const event: Record<string, unknown> = {
    event_name: input.eventName,
    // Meta rechaza eventos con mas de 7 dias; en segundos, no milisegundos.
    event_time: input.eventTime || Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    action_source: input.actionSource || "website",
    user_data: buildUserDataPayload(input.userData),
  };

  if (input.eventSourceUrl) event.event_source_url = input.eventSourceUrl;

  const customData = buildCustomDataPayload(input.customData);
  if (Object.keys(customData).length > 0) event.custom_data = customData;

  const body: Record<string, unknown> = {
    data: [event],
    access_token: env.META_CAPI_ACCESS_TOKEN,
  };

  // Solo mientras se prueba desde el Events Manager ("Probar eventos").
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;

  try {
    const response = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${env.META_PIXEL_ID}/events`,
      body,
      { timeout: 8000, headers: { "Content-Type": "application/json" } }
    );
    console.log(
      `[meta-capi] ${input.eventName} enviado (event_id=${input.eventId}) recibidos=${response.data?.events_received ?? "?"}`
    );
    return true;
  } catch (error) {
    const detail = axios.isAxiosError(error)
      ? JSON.stringify(error.response?.data?.error || error.message)
      : error instanceof Error
        ? error.message
        : "error desconocido";
    console.error(`[meta-capi] ${input.eventName} fallo (event_id=${input.eventId}): ${detail}`);
    return false;
  }
}
