/**
 * Sincroniza las sucursales (stores) de Picker Express con las Branch de Mongo.
 *
 * Uso:
 *   DB_URI=... PICKER_MASTER_KEY=... PICKER_API_BASE_URL=... \
 *     pnpm ts-node-dev --transpile-only src/scripts/syncPickerStores.ts [--apply] [--env=development|production]
 *
 * Sin --apply solo imprime el plan (dry-run).
 *
 * --env=development  -> escribe en pickerStore.storeApiKey
 * --env=production   -> escribe en pickerStore.productionStoreApiKey
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Branch } from "../models/Branch";

interface PickerStore {
  companyName: string;
  token: string;
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const envArg = args.find((a) => a.startsWith("--env="));
const PICKER_ENV = (envArg?.split("=")[1] || process.env.PICKER_ENV || "development").trim();
const IS_PROD = PICKER_ENV === "production";
const KEY_FIELD = IS_PROD ? "productionStoreApiKey" : "storeApiKey";

const DB_URI = requiredEnv("DB_URI");
const MASTER_KEY = requiredEnv("PICKER_MASTER_KEY");
const API_BASE = (process.env.PICKER_API_BASE_URL ||
  (IS_PROD ? "https://api.pickerexpress.com/api" : "https://dev-api.pickerexpress.com/api")
).replace(/\/+$/, "");

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${key}`);
  return value;
}

/** Normaliza para comparar nombres: minusculas, sin tildes, sin puntuacion. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Quita el prefijo "boloncity" y ruido comun para quedarnos con el nombre de la sucursal. */
function branchToken(value: string): string {
  return normalize(value)
    .replace(/^bolon\s*city\s*/, "")
    .replace(/\b(sucursal|local|plaza|ccto|cc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Alias manuales: el nombre comercial en Picker no siempre coincide con el de la Branch.
 * Clave y valor se comparan ya normalizados con branchToken().
 */
const ALIASES: Record<string, string[]> = {
  "via a la costa": ["blue coast", "via costa", "vialacosta"],
  "la joya": ["av leon febres cordero", "leon febres cordero", "av leon febres cordero norte"],
  centro: ["centro"],
  garzota: ["garzota"],
  kennedy: ["kennedy"],
  urdesa: ["urdesa"],
  avalon: ["avalon"],
  republica: ["republica"],
};

function candidatesFor(branchName: string): string[] {
  const token = branchToken(branchName);
  const out = new Set<string>([token]);
  for (const [canonical, aliases] of Object.entries(ALIASES)) {
    if (token === canonical || token.includes(canonical) || canonical.includes(token)) {
      out.add(canonical);
      aliases.forEach((a) => out.add(a));
    }
  }
  return [...out].filter(Boolean);
}

function matchStore(branchName: string, stores: PickerStore[]): PickerStore | null {
  const candidates = candidatesFor(branchName);
  const scored = stores
    .map((store) => {
      const storeToken = branchToken(store.companyName);
      let score = 0;
      for (const candidate of candidates) {
        if (storeToken === candidate) score = Math.max(score, 3);
        else if (storeToken.includes(candidate) || candidate.includes(storeToken)) score = Math.max(score, 2);
      }
      return { store, score, storeToken };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.storeToken.length - b.storeToken.length);

  return scored[0]?.store ?? null;
}

async function fetchPickerStores(): Promise<PickerStore[]> {
  const response = await fetch(`${API_BASE}/getStores`, {
    headers: { Authorization: `Bearer ${MASTER_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`getStores fallo: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as { data?: PickerStore[] };
  return payload.data ?? [];
}

async function main() {
  console.log(`[picker-sync] entorno=${PICKER_ENV} api=${API_BASE} campo=${KEY_FIELD} apply=${APPLY}`);

  const stores = await fetchPickerStores();
  console.log(`[picker-sync] stores en Picker: ${stores.length}`);
  stores.forEach((s) => console.log(`  - ${s.companyName}`));

  await mongoose.connect(DB_URI);
  const dbName = mongoose.connection.name;
  const branches = await Branch.find({ isArchived: { $ne: true } })
    .select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey")
    .sort({ name: 1 });
  console.log(`[picker-sync] db=${dbName} branches: ${branches.length}`);

  const used = new Set<string>();
  let updated = 0;
  const unmatched: string[] = [];

  for (const branch of branches) {
    const store = matchStore(branch.name, stores.filter((s) => !used.has(s.token)));
    if (!store) {
      unmatched.push(branch.name);
      console.log(`  [SIN MATCH] ${branch.name}`);
      continue;
    }
    used.add(store.token);

    const current = (branch.pickerStore as Record<string, unknown> | undefined)?.[KEY_FIELD];
    const alreadyOk = current === store.token;
    console.log(
      `  [${alreadyOk ? "OK " : "SET"}] ${branch.name} <- "${store.companyName}" (${store.token})`
    );
    if (alreadyOk || !APPLY) continue;

    await Branch.updateOne(
      { _id: branch._id },
      {
        $set: {
          [`pickerStore.${KEY_FIELD}`]: store.token,
          "pickerStore.creationStatus": "linked",
          "pickerStore.createdBy": "syncPickerStores",
        },
      }
    );
    updated += 1;
  }

  console.log(`[picker-sync] actualizadas=${updated} sin_match=${unmatched.length}`);
  if (unmatched.length) console.log(`[picker-sync] revisar: ${unmatched.join(", ")}`);
  if (!APPLY) console.log("[picker-sync] dry-run: volver a correr con --apply para escribir");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[picker-sync] error:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
