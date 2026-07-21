import axios from "axios";
import { env } from "../config/env";

const PICKER_API = "https://dev-api.pickerexpress.com/api";
const COOKTIME_MS = 10 * 60 * 1000;

export interface PreCheckoutInput {
  branchKey: string;
  latitude: number;
  longitude: number;
}

export interface PreCheckoutResponse {
  deliveryFee: number;
  distance: number;
  covered: boolean;
  message?: string;
}

export interface CreateBookingInput {
  branchKey: string;
  latitude: number;
  longitude: number;
  address: string;
  reference: string;
  customerName: string;
  customerLastName: string;
  customerEmail: string;
  customerPhone: string;
  customerCountryCode: string;
  orderAmount: number;
  externalBookingId: string;
  notes?: string;
}

export interface PickerBookingResponse {
  _id: string;
  bookingNumericId: number;
  currentStatus: number;
  statusText: string;
  smrURL: string;
  bookingDetailUrl: string;
  deliveryFee: number;
}

function parsePhone(phone: string): { code: string; number: string } {
  const cleaned = phone.replace(/\s+/g, "").replace(/^\+/, "");
  const match = cleaned.match(/^(\d{1,3})(\d+)$/);
  if (match) {
    return { code: match[1], number: match[2].replace(/^0+/, "") };
  }
  return { code: "593", number: cleaned.replace(/^0+/, "") };
}

async function tryPreCheckout(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  headerName: string
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers[headerName] = headerName === "Authorization" ? `Bearer ${apiKey}` : apiKey;

  console.error(`[pickerexpress/preCheckout] Intentando con header "${headerName}" = ${apiKey.slice(0, 8)}...`);

  return await axios.post(url, body, { headers });
}

export async function preCheckout(
  input: PreCheckoutInput
): Promise<PreCheckoutResponse> {
  const url = `${PICKER_API}/preCheckout`;
  const body = { latitude: input.latitude, longitude: input.longitude, carName: "BIKE" };

  console.error(`[pickerexpress/preCheckout] POST ${url}`);
  console.error(`[pickerexpress/preCheckout] Body:`, body);

  const strategies = [
    { key: input.branchKey, header: "x-api-key" },
    { key: input.branchKey, header: "Authorization" },
    { key: env.PICKER_MASTER_KEY, header: "x-api-key" },
    { key: env.PICKER_MASTER_KEY, header: "Authorization" },
  ];

  for (const s of strategies) {
    if (!s.key) continue;
    try {
      const response = await tryPreCheckout(url, body, s.key, s.header);
      console.error(`[pickerexpress/preCheckout] Estrategia exitosa! header=${s.header}, status=${response.status}`);
      console.error(`[pickerexpress/preCheckout] Response data:`, JSON.stringify(response.data, null, 2));
      const data = response.data?.data || response.data;
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        console.error(`[pickerexpress/preCheckout] Falló con header=${s.header}, status=${err.response.status}`);
        console.error(`[pickerexpress/preCheckout] Data:`, JSON.stringify(err.response.data, null, 2));
        if (err.response.status === 401) continue;
        throw err;
      }
      throw err;
    }
  }

  throw new Error("Picker pre-checkout no autorizado con ninguna estrategia de autenticación");
}

export async function createPickerBooking(
  input: CreateBookingInput
): Promise<PickerBookingResponse> {
  const phone = parsePhone(input.customerPhone);

  const body: Record<string, unknown> = {
    latitude: input.latitude,
    longitude: input.longitude,
    address: input.address,
    reference: input.reference,
    customerName: input.customerName,
    customerLastName: input.customerLastName,
    customerEmail: input.customerEmail,
    customerCountryCode: `+${phone.code}`,
    customerMobile: phone.number,
    paymentMethod: "CARD",
    orderAmount: Math.round(input.orderAmount),
    externalBookingId: input.externalBookingId,
    cookTime: COOKTIME_MS,
    sendTrackingLink: true,
    carName: "BIKE",
  };

  if (input.notes) body.bookingNotes = input.notes;

  const response = await axios.post(
    `${PICKER_API}/createBooking`,
    body,
    {
      headers: {
        Authorization: `Bearer ${input.branchKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const data = response.data?.data || response.data;
  return data;
}

export function getPickerBranchKey(branchName: string): string {
  const normalized = branchName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const map: Record<string, string> = {
    garzota: env.PICKER_KEYS.garzota,
    centro: env.PICKER_KEYS.centro,
    kennedy: env.PICKER_KEYS.kennedy,
    urdesa: env.PICKER_KEYS.urdesa,
    "via a la costa": env.PICKER_KEYS.viaCosta,
    "via costa": env.PICKER_KEYS.viaCosta,
    "la joya": env.PICKER_KEYS.laJoya,
    joya: env.PICKER_KEYS.laJoya,
    avalon: env.PICKER_KEYS.avalon,
    "avalon plaza": env.PICKER_KEYS.avalon,
    republica: env.PICKER_KEYS.republica,
  };

  for (const [key, value] of Object.entries(map)) {
    if (normalized.includes(key) && value) {
      return value;
    }
  }

  return "";
}
