/**
 * Auditoria de sucursales: revisa que cada Branch este lista para operar.
 *
 * Uso:
 *   DB_URI=... pnpm branches:audit
 *   DB_URI=... PICKER_MASTER_KEY=... pnpm branches:audit --env=production
 *
 * --env=development (default) -> valida pickerStore.storeApiKey contra dev-api
 * --env=production            -> valida pickerStore.productionStoreApiKey contra api
 *
 * Con PICKER_MASTER_KEY ademas contrasta las llaves guardadas contra /getStores
 * y avisa si una sucursal apunta a un store que ya no existe.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Branch, IBranch } from "../models/Branch";

const envArg = process.argv.find((arg) => arg.startsWith("--env="));
const PICKER_ENV = (envArg?.split("=")[1] || process.env.PICKER_ENV || "development").trim();
const IS_PROD = PICKER_ENV === "production";
const KEY_FIELD = IS_PROD ? "productionStoreApiKey" : "storeApiKey";
// Con --env explicito manda el flag: el PICKER_API_BASE_URL del .env apunta al otro entorno.
const API_BASE = (
  (envArg ? "" : process.env.PICKER_API_BASE_URL) ||
  (IS_PROD ? "https://api.pickerexpress.com/api" : "https://dev-api.pickerexpress.com/api")
).replace(/\/+$/, "");
const MASTER_KEY = process.env.PICKER_MASTER_KEY?.trim() || "";

const DB_URI = process.env.DB_URI?.trim();
if (!DB_URI) throw new Error("Falta la variable de entorno DB_URI");

interface PickerStore {
  companyName: string;
  token: string;
}

interface Issue {
  level: "ERROR" | "WARN";
  message: string;
}

/** Picker exige un celular ecuatoriano de 9 digitos que empiece en 9. */
function isPickerPhone(phone: string): boolean {
  const normalized = (phone || "").replace(/[\s()-]/g, "");
  const mobile = normalized.startsWith("+593")
    ? normalized.slice(4)
    : normalized.startsWith("593")
      ? normalized.slice(3)
      : normalized.startsWith("0")
        ? normalized.slice(1)
        : normalized;
  return /^9\d{8}$/.test(mobile);
}

async function fetchPickerStores(): Promise<PickerStore[] | null> {
  if (!MASTER_KEY) return null;
  const response = await fetch(`${API_BASE}/getStores`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  });
  if (!response.ok) {
    console.log(`[audit] getStores fallo (${response.status}); se omite la validacion contra Picker`);
    return null;
  }
  const payload = (await response.json()) as { data?: PickerStore[] };
  return payload.data ?? [];
}

function auditBranch(branch: IBranch, stores: PickerStore[] | null): Issue[] {
  const issues: Issue[] = [];
  const pickerStore = (branch.pickerStore || {}) as Record<string, string | undefined>;
  const pickerKey = pickerStore[KEY_FIELD]?.trim() || "";

  if (!pickerKey) {
    issues.push({ level: "ERROR", message: `sin pickerStore.${KEY_FIELD} — el delivery cobraria la tarifa por km en vez de la de Picker` });
  } else if (stores && !stores.some((store) => store.token === pickerKey)) {
    issues.push({ level: "ERROR", message: `pickerStore.${KEY_FIELD} no corresponde a ningun store de ${API_BASE}` });
  }

  if (!branch.payphone?.storeId?.trim()) {
    issues.push({ level: "ERROR", message: "sin payphone.storeId — el cobro caeria en la tienda global, no en la sucursal" });
  }

  if (branch.coordinates?.lat == null || branch.coordinates?.lng == null) {
    issues.push({ level: "ERROR", message: "sin coordenadas — no se puede calcular la sucursal mas cercana" });
  }

  const openDays = (branch.openingHours || []).filter((hours) => hours.isOpen);
  if (!branch.openingHours?.length) {
    issues.push({ level: "ERROR", message: "sin openingHours" });
  } else if (!openDays.length) {
    issues.push({ level: "ERROR", message: "todos los dias marcados como cerrados" });
  }

  if (!isPickerPhone(branch.phone || "")) {
    issues.push({ level: "WARN", message: `telefono "${branch.phone || ""}" no es un celular EC valido — Picker lo rechaza al crear el store` });
  }
  if (!branch.email?.trim()) issues.push({ level: "WARN", message: "sin email de contacto" });
  if (!branch.address?.trim()) issues.push({ level: "WARN", message: "sin direccion" });
  if (!branch.googleMapsUrl?.trim()) issues.push({ level: "WARN", message: "sin googleMapsUrl" });
  if (!branch.imageUrl?.trim()) issues.push({ level: "WARN", message: "sin imagen" });

  return issues;
}

async function main() {
  console.log(`[audit] entorno=${PICKER_ENV} api=${API_BASE} campo=${KEY_FIELD}`);

  const stores = await fetchPickerStores();
  if (stores) console.log(`[audit] stores en Picker: ${stores.length}`);

  await mongoose.connect(DB_URI!);
  console.log(`[audit] db=${mongoose.connection.name}`);

  const branches = (await Branch.find({ isArchived: { $ne: true } })
    .select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey")
    .sort({ name: 1 })) as IBranch[];

  let blocked = 0;
  let warned = 0;

  for (const branch of branches) {
    const issues = auditBranch(branch, stores);
    const errors = issues.filter((issue) => issue.level === "ERROR");
    const warnings = issues.filter((issue) => issue.level === "WARN");
    const badge = !branch.isActive ? "INACTIVA" : errors.length ? "BLOQUEADA" : warnings.length ? "REVISAR " : "OK      ";

    if (branch.isActive && errors.length) blocked += 1;
    if (branch.isActive && !errors.length && warnings.length) warned += 1;

    console.log(`\n[${badge}] ${branch.name}`);
    for (const issue of issues) console.log(`    ${issue.level === "ERROR" ? "x" : "!"} ${issue.message}`);
  }

  const active = branches.filter((branch) => branch.isActive).length;
  console.log(
    `\n[audit] ${branches.length} sucursales (${active} activas) — bloqueadas=${blocked} con_avisos=${warned} listas=${active - blocked - warned}`
  );

  await mongoose.disconnect();
  if (blocked) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("[audit] error:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
