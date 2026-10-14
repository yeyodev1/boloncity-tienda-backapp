import crypto from "crypto";
import axios from "axios";
import { env } from "../config/env";
import { MetaCustomData, MetaEventName, MetaUserData } from "./metaConversions.service";

/**
 * Events API de TikTok: el espejo servidor del pixel de TikTok, igual que la
 * Conversions API lo es del de Meta.
 *
 * La tienda mide un solo catalogo de eventos (el de Meta) y aqui se traduce a los
 * nombres de TikTok. El navegador dispara `ttq.track(..., { event_id })` con el
 * MISMO id que llega aca, y TikTok deduplica las dos copias.
 *
 * Igual que con Meta: nada de esto puede tumbar un pedido. Los errores se
 * registran y se tragan.
 */

const EVENTS_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

/**
 * PageView no tiene equivalente en la Events API (en el navegador es `ttq.page()`),
 * asi que no se manda desde aca.
 */
const TIKTOK_EVENT_NAMES: Partial<Record<MetaEventName, string>> = {
  ViewContent: "ViewContent",
  AddToCart: "AddToCart",
  InitiateCheckout: "InitiateCheckout",
  Purchase: "CompletePayment",
};

export interface TikTokUserData extends MetaUserData {
  /** Cookie `_ttp` del pixel de TikTok. */
  ttp?: string;
  /** `ttclid` del clic en el anuncio. */
  ttclid?: string;
}

export interface TikTokEventInput {
  eventName: MetaEventName;
  eventId: string;
  eventTime?: number;
  eventSourceUrl?: string;
  userData?: TikTokUserData;
  customData?: MetaCustomData;
}

export function isTikTokConfigured(): boolean {
  return Boolean(env.TIKTOK_PIXEL_ID && env.TIKTOK_ACCESS_TOKEN);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashEmail(value?: string): string | undefined {
  const clean = String(value || "").trim().toLowerCase();
  return clean.includes("@") ? sha256(clean) : undefined;
}

/** TikTok espera E.164 antes del hash: "+593991234567". */
function hashPhone(value?: string): string | undefined {
  let digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return undefined;
  digits = digits.startsWith("593") ? `593${digits.slice(3).replace(/^0+/, "")}` : `593${digits.replace(/^0+/, "")}`;
  return digits.length >= 8 ? sha256(`+${digits}`) : undefined;
}

function buildUser(userData: TikTokUserData = {}): Record<string, unknown> {
  const user: Record<string, unknown> = {};
  const email = hashEmail(userData.email);
  const phone = hashPhone(userData.phone);
  const externalId = String(userData.externalId || "").trim().toLowerCase();

  if (email) user.email = email;
  if (phone) user.phone = phone;
  if (externalId) user.external_id = sha256(externalId);
  if (userData.ttp) user.ttp = userData.ttp;
  if (userData.ttclid) user.ttclid = userData.ttclid;
  if (userData.clientIpAddress) user.ip = userData.clientIpAddress;
  if (userData.clientUserAgent) user.user_agent = userData.clientUserAgent;
  return user;
}

function buildProperties(customData: MetaCustomData = {}): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (customData.currency) properties.currency = customData.currency;
  if (typeof customData.value === "number" && Number.isFinite(customData.value)) {
    properties.value = Math.round(customData.value * 100) / 100;
  }
  if (customData.content_type) properties.content_type = customData.content_type;
  if (customData.order_id) properties.order_id = customData.order_id;

  const contents = customData.contents?.length
    ? customData.contents.map((content) => ({
        content_id: content.id,
        quantity: content.quantity,
        price: content.item_price,
        ...(customData.content_name && customData.contents?.length === 1 ? { content_name: customData.content_name } : {}),
      }))
    : (customData.content_ids || []).map((id) => ({
        content_id: id,
        ...(customData.content_name ? { content_name: customData.content_name } : {}),
      }));
  if (contents.length) properties.contents = contents;

  return properties;
}

/**
 * Envia un evento a TikTok. Nunca lanza.
 *
 * @returns true si TikTok acepto el evento.
 */
export async function sendTikTokEvent(input: TikTokEventInput): Promise<boolean> {
  if (!isTikTokConfigured()) return false;
  const tiktokEvent = TIKTOK_EVENT_NAMES[input.eventName];
  if (!tiktokEvent) return false;
  // Igual que Meta: los pedidos de dev/QA no son compras reales.
  if (env.APP_ENV !== "production" && !env.TIKTOK_TEST_EVENT_CODE) {
    console.log(`[tiktok-events] ${tiktokEvent} omitido (APP_ENV=${env.APP_ENV} sin TIKTOK_TEST_EVENT_CODE, event_id=${input.eventId})`);
    return false;
  }

  const event: Record<string, unknown> = {
    event: tiktokEvent,
    event_time: input.eventTime || Math.floor(Date.now() / 1000),
    event_id: input.eventId,
    user: buildUser(input.userData),
    properties: buildProperties(input.customData),
  };
  if (input.eventSourceUrl) event.page = { url: input.eventSourceUrl };

  const body: Record<string, unknown> = {
    event_source: "web",
    event_source_id: env.TIKTOK_PIXEL_ID,
    data: [event],
  };
  if (env.TIKTOK_TEST_EVENT_CODE) body.test_event_code = env.TIKTOK_TEST_EVENT_CODE;

  try {
    const response = await axios.post(EVENTS_URL, body, {
      timeout: 8000,
      headers: { "Content-Type": "application/json", "Access-Token": env.TIKTOK_ACCESS_TOKEN },
    });
    // TikTok responde 200 incluso cuando rechaza: el veredicto viene en `code`.
    if (response.data?.code !== 0) {
      console.error(`[tiktok-events] ${tiktokEvent} rechazado (event_id=${input.eventId}): ${JSON.stringify(response.data)}`);
      return false;
    }
    console.log(`[tiktok-events] ${tiktokEvent} enviado (event_id=${input.eventId})`);
    return true;
  } catch (error) {
    const detail = axios.isAxiosError(error) ? JSON.stringify(error.response?.data || error.message) : String(error);
    console.error(`[tiktok-events] ${tiktokEvent} fallo (event_id=${input.eventId}): ${detail}`);
    return false;
  }
}
