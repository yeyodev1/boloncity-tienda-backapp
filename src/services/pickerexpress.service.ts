import axios from "axios";
import { env } from "../config/env";

const PICKER_API = "https://dev-api.pickerexpress.com/api";

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
  businessDeliveryFee: number;
  paymentMethod: "CARD" | "CASH";
  externalBookingId: string;
  notes?: string;
  cookTime?: number;
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

export type StartSearchResponse = Record<string, unknown>;

export interface CreatePickerStoreInput {
  addressReference: string;
  email: string;
  mobile: string;
  countryCode: string;
  companyName: string;
  longitude: number;
  latitude: number;
  fullAddress: string;
}

export interface CreatePickerStoreResponse {
  token: string;
  storeId?: string;
}

function parsePhone(phone: string): { code: string; number: string } {
  const cleaned = phone.replace(/\s+/g, "").replace(/^\+/, "");
  const match = cleaned.match(/^(\d{1,3})(\d+)$/);
  if (match) {
    return { code: match[1], number: match[2].replace(/^0+/, "") };
  }
  return { code: "593", number: cleaned.replace(/^0+/, "") };
}

export async function createPickerStore(
  input: CreatePickerStoreInput
): Promise<CreatePickerStoreResponse> {
  try {
    const response = await axios.post(`${PICKER_API}/createStore`, input, {
      headers: {
        Authorization: `Bearer ${env.PICKER_MASTER_KEY}`,
        "Content-Type": "application/json",
      },
    });
    const data = response.data?.data || response.data;
    const token = typeof data?.token === "string" ? data.token.trim() : "";

    if (!token) {
      throw new Error("Picker createStore response did not include a token");
    }

    const storeId = typeof data?._id === "string"
      ? data._id
      : typeof data?.storeId === "string"
        ? data.storeId
        : undefined;
    return { token, storeId };
  } catch (error) {
    if (error instanceof Error && error.message === "Picker createStore response did not include a token") {
      throw error;
    }
    throw new Error("Picker store creation failed");
  }
}

async function tryPreCheckout(
  url: string,
  body: Record<string, unknown>,
  apiKey: string,
  headerName: string
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers[headerName] = headerName === "Authorization" ? `Bearer ${apiKey}` : apiKey;

  console.error(`[pickerexpress/preCheckout] Intentando con header "${headerName}"`);

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
  const orderAmount = Math.round((input.orderAmount + Number.EPSILON) * 100) / 100;

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
    paymentMethod: input.paymentMethod,
    orderAmount,
    businessDeliveryFee: Math.round((input.businessDeliveryFee + Number.EPSILON) * 100) / 100,
    externalBookingId: input.externalBookingId,
    sendTrackingLink: true,
    carName: "BIKE",
  };

  if (input.notes && input.notes.trim().length >= 3) body.bookingNotes = input.notes.trim();
  if (typeof input.cookTime === "number" && Number.isFinite(input.cookTime) && input.cookTime >= 0) {
    body.cookTime = Math.round(input.cookTime);
  }

  console.log(`[Picker] Creating booking order=${input.externalBookingId} amount=${orderAmount.toFixed(2)} address="${input.address}"`);

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

export async function startSearch(bookingId: string, branchApiKey: string): Promise<StartSearchResponse> {
  const response = await axios.post(
    `${PICKER_API}/startSearch`,
    { bookingID: bookingId },
    {
      headers: {
        Authorization: `Bearer ${branchApiKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data?.data || response.data || {};
}
