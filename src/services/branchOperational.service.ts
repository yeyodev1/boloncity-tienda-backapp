import { BranchWeekday, IBranch, IBranchOpeningHours, IBranchPayphone, IPickerStore } from "../models/Branch";
import { env } from "../config/env";

const WEEKDAYS: BranchWeekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function defaultOpeningHours(): IBranchOpeningHours[] {
  return WEEKDAYS.map((day) => ({ day, opensAt: "07:00", closesAt: "13:00", isOpen: true }));
}

function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`${field} must be valid JSON`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function normalizeTimezone(value: unknown): string {
  const timezone = typeof value === "string" && value.trim() ? value.trim() : "America/Guayaquil";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    throw new Error("timezone must be a valid IANA timezone");
  }
}

export function normalizeOpeningHours(value: unknown): IBranchOpeningHours[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("openingHours must be valid JSON");
    }
  }
  if (!Array.isArray(value) || value.length !== WEEKDAYS.length) {
    throw new Error("openingHours must define all seven days");
  }

  const hours = value.map((entry) => {
    const item = parseObject(entry, "openingHours entry");
    const day = item.day;
    const opensAt = item.opensAt;
    const closesAt = item.closesAt;
    const isOpen = item.isOpen === undefined ? true : item.isOpen;
    if (!WEEKDAYS.includes(day as BranchWeekday) || typeof opensAt !== "string" || typeof closesAt !== "string" || typeof isOpen !== "boolean") {
      throw new Error("openingHours entries must contain day, opensAt, closesAt, and isOpen");
    }
    if (!TIME_PATTERN.test(opensAt) || !TIME_PATTERN.test(closesAt) || (isOpen && opensAt >= closesAt)) {
      throw new Error("openingHours must use HH:mm times with closesAt after opensAt");
    }
    return { day: day as BranchWeekday, opensAt, closesAt, isOpen };
  });

  if (new Set(hours.map((item) => item.day)).size !== WEEKDAYS.length) {
    throw new Error("openingHours cannot repeat a day");
  }
  return WEEKDAYS.map((day) => hours.find((item) => item.day === day)!);
}

export function normalizePickerStore(value: unknown): IPickerStore {
  const store = parseObject(value, "pickerStore");
  const normalized: IPickerStore = {};
  for (const field of ["storeApiKey", "productionStoreApiKey", "token", "storeId", "createdBy", "creationStatus"] as const) {
    if (store[field] !== undefined) {
      if (typeof store[field] !== "string") throw new Error(`pickerStore.${field} must be a string`);
      normalized[field] = store[field].trim();
    }
  }
  if (store.createdAt !== undefined) {
    const createdAt = new Date(String(store.createdAt));
    if (Number.isNaN(createdAt.getTime())) throw new Error("pickerStore.createdAt must be a valid date");
    normalized.createdAt = createdAt;
  }
  return normalized;
}

export function normalizeBranchPayphone(value: unknown): IBranchPayphone {
  const payphone = parseObject(value, "payphone");
  const normalized: IBranchPayphone = {};
  if (payphone.storeId !== undefined) {
    if (typeof payphone.storeId !== "string") throw new Error("payphone.storeId must be a string");
    normalized.storeId = payphone.storeId.trim();
  }
  return normalized;
}

/**
 * storeId de PayPhone de la sucursal, con fallback a la tienda global mientras se
 * termina de cargar el dato por local.
 */
export function getBranchPayphoneStoreId(payphone?: IBranchPayphone): string {
  return payphone?.storeId?.trim() || env.PAYPHONE_STORE_ID || "";
}

export function getPickerStoreApiKey(pickerStore?: IPickerStore): string {
  return env.PICKER_ENV === "production"
    ? pickerStore?.productionStoreApiKey || ""
    : pickerStore?.storeApiKey || "";
}

export function pickerEnabledBranchFilter(): Record<string, unknown> {
  return env.PICKER_ENV === "production"
    ? { "pickerStore.productionStoreApiKey": { $exists: true, $ne: "" } }
    : { "pickerStore.storeApiKey": { $exists: true, $ne: "" } };
}

function getBranchLocalTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return { day: part("weekday").toLowerCase() as BranchWeekday, time: `${part("hour")}:${part("minute")}` };
}

export function isBranchOpenAt(branch: Pick<IBranch, "timezone" | "openingHours">, date = new Date()): boolean {
  const local = getBranchLocalTime(date, branch.timezone || "America/Guayaquil");
  const hours = branch.openingHours?.find((item) => item.day === local.day);
  return Boolean(hours?.isOpen && local.time >= hours.opensAt && local.time < hours.closesAt);
}

/** Fecha local (YYYY-MM-DD) de la sucursal para un instante dado. */
function getBranchLocalDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Offset de la timezone en esa fecha, en formato +HH:mm (Ecuador siempre -05:00). */
function getTimezoneOffset(date: Date, timezone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = name?.match(/GMT([+-]\d{2}:\d{2})/);
  return match ? match[1] : "-05:00";
}

export interface BranchOpeningWindow {
  /** Fecha local de la sucursal, YYYY-MM-DD */
  date: string;
  opensAt: string;
  closesAt: string;
  /** Instante exacto de la apertura */
  at: Date;
}

/**
 * Proxima ventana de atencion a partir de `from`. Si la sucursal esta abierta ahora,
 * devuelve la ventana en curso. Busca hasta 8 dias; null si nunca abre.
 */
export function getNextOpening(
  branch: Pick<IBranch, "timezone" | "openingHours">,
  from = new Date()
): BranchOpeningWindow | null {
  const timezone = branch.timezone || "America/Guayaquil";
  const local = getBranchLocalTime(from, timezone);

  for (let offset = 0; offset < 8; offset += 1) {
    const cursor = new Date(from.getTime() + offset * 24 * 60 * 60 * 1000);
    const cursorLocal = getBranchLocalTime(cursor, timezone);
    const hours = branch.openingHours?.find((item) => item.day === cursorLocal.day);
    if (!hours?.isOpen) continue;
    // Hoy solo sirve si todavia no cerro.
    if (offset === 0 && local.time >= hours.closesAt) continue;

    const date = getBranchLocalDate(cursor, timezone);
    const at = new Date(`${date}T${hours.opensAt}:00${getTimezoneOffset(cursor, timezone)}`);
    return { date, opensAt: hours.opensAt, closesAt: hours.closesAt, at };
  }

  return null;
}

/** Estado operativo listo para el checkout: abierta ahora y cuando vuelve a abrir. */
export function getBranchAvailability(branch: Pick<IBranch, "timezone" | "openingHours">, now = new Date()) {
  const isOpenNow = isBranchOpenAt(branch, now);
  const nextOpening = getNextOpening(branch, now);
  return {
    isOpenNow,
    timezone: branch.timezone || "America/Guayaquil",
    nextOpening: nextOpening
      ? { date: nextOpening.date, opensAt: nextOpening.opensAt, closesAt: nextOpening.closesAt, at: nextOpening.at.toISOString() }
      : null,
  };
}

export function validateScheduledTime(branch: Pick<IBranch, "timezone" | "openingHours">, scheduledAt: Date | string): { valid: boolean; message?: string } {
  const date = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(date.getTime())) return { valid: false, message: "scheduledAt must be a valid date" };
  if (isBranchOpenAt(branch, date)) return { valid: true };

  const local = getBranchLocalTime(date, branch.timezone || "America/Guayaquil");
  const hours = branch.openingHours?.find((item) => item.day === local.day);
  const message = hours?.isOpen
    ? `La sucursal atiende de ${hours.opensAt} a ${hours.closesAt}. Elige un horario dentro de ese rango.`
    : "La sucursal no atiende el dia que seleccionaste. Elige otra fecha.";
  return { valid: false, message };
}

export function toPublicBranch(branch: { toObject?: () => Record<string, unknown> } | Record<string, unknown>): Record<string, unknown> {
  const result = "toObject" in branch && typeof branch.toObject === "function" ? branch.toObject() : { ...branch };
  if (result.pickerStore && typeof result.pickerStore === "object") {
    const pickerStore = { ...(result.pickerStore as Record<string, unknown>) };
    delete pickerStore.storeApiKey;
    delete pickerStore.productionStoreApiKey;
    delete pickerStore.token;
    result.pickerStore = pickerStore;
  }
  delete result.pickerApiKey;

  // El storeId no es secreto (viaja al navegador en la cajita de pagos), pero el checkout
  // necesita el de la sucursal ya resuelto para que el cobro caiga en la tienda correcta.
  result.payphone = { storeId: getBranchPayphoneStoreId(result.payphone as IBranchPayphone | undefined) };

  // El checkout necesita saber si puede comprar ahora o solo programar, sin recalcular
  // husos horarios en el navegador.
  result.availability = getBranchAvailability({
    timezone: result.timezone as string,
    openingHours: (result.openingHours || []) as IBranchOpeningHours[],
  });

  return result;
}
