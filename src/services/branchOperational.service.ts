import { BranchWeekday, IBranch, IBranchOpeningHours, IPickerStore } from "../models/Branch";

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
  for (const field of ["storeApiKey", "token", "storeId", "createdBy", "creationStatus"] as const) {
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

export function validateScheduledTime(branch: Pick<IBranch, "timezone" | "openingHours">, scheduledAt: Date | string): { valid: boolean; message?: string } {
  const date = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(date.getTime())) return { valid: false, message: "scheduledAt must be a valid date" };
  return isBranchOpenAt(branch, date) ? { valid: true } : { valid: false, message: "Branch is closed at the scheduled time" };
}

export function toPublicBranch(branch: { toObject?: () => Record<string, unknown> } | Record<string, unknown>): Record<string, unknown> {
  const result = "toObject" in branch && typeof branch.toObject === "function" ? branch.toObject() : { ...branch };
  if (result.pickerStore && typeof result.pickerStore === "object") {
    const pickerStore = { ...(result.pickerStore as Record<string, unknown>) };
    delete pickerStore.storeApiKey;
    delete pickerStore.token;
    result.pickerStore = pickerStore;
  }
  return result;
}
