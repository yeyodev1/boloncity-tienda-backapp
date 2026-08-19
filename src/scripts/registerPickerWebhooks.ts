/**
 * Registra en Picker Express los webhooks de estado por sucursal (store), para que
 * DRIVER_ASSIGNED y UPDATE_BOOKING_STATUS lleguen automáticamente a nuestro backend.
 *
 * Picker guarda un webhook por tópico y store: POST /webhooks lo crea o reemplaza.
 * Correr después de picker:sync cuando se agregue una sucursal nueva.
 *
 * Uso:
 *   DB_URI=... pnpm webhooks:register:dev    (dev  -> boloncity-api-dev.vercel.app)
 *   DB_URI=... pnpm webhooks:register:prod   (prod -> api.boloncity.com)
 *
 * --base=https://otra-url anula el destino del webhook.
 */
import "dotenv/config";
import axios from "axios";
import mongoose from "mongoose";
import { Branch } from "../models/Branch";

const TYPES = ["UPDATE_BOOKING_STATUS", "DRIVER_ASSIGNED"] as const;

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith("--env="));
const PICKER_ENV = (envArg?.split("=")[1] || process.env.PICKER_ENV || "development").trim();
const IS_PROD = PICKER_ENV === "production";
const KEY_FIELD = IS_PROD ? "productionStoreApiKey" : "storeApiKey";

const API_BASE = (process.env.PICKER_API_BASE_URL ||
  (IS_PROD ? "https://api.pickerexpress.com/api" : "https://dev-api.pickerexpress.com/api")
).replace(/\/+$/, "");

const baseArg = args.find((a) => a.startsWith("--base="));
const WEBHOOK_BASE = (baseArg?.split("=")[1] ||
  (IS_PROD ? "https://api.boloncity.com" : "https://boloncity-api-dev.vercel.app")
).replace(/\/+$/, "");

const DB_URI = process.env.DB_URI?.trim();
if (!DB_URI) throw new Error("Falta la variable de entorno DB_URI");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await mongoose.connect(DB_URI as string);
  const branches = await Branch.find({ isActive: true }).select(
    "+pickerStore.storeApiKey +pickerStore.productionStoreApiKey"
  );

  console.log(`Registrando webhooks (${PICKER_ENV}) hacia ${WEBHOOK_BASE}/api/webhooks/picker/<evento>`);
  for (const branch of branches) {
    const key = ((branch.pickerStore as Record<string, unknown> | undefined)?.[KEY_FIELD] as string) || "";
    if (!key) {
      console.log(`- ${branch.name}: sin llave de Picker (${KEY_FIELD}); omitida`);
      continue;
    }
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // Picker exige Content-Language en /webhooks.
      "Content-Language": "es",
    };
    for (const type of TYPES) {
      const url = `${WEBHOOK_BASE}/api/webhooks/picker/${type}`;
      const res = await axios.post(`${API_BASE}/webhooks`, { url, type }, { headers, timeout: 15000, validateStatus: () => true });
      console.log(`- ${branch.name} ${type}: ${res.status === 200 ? "ok" : `HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`}`);
      // dev-api aplica rate limit agresivo; sin pausa devuelve 429 a mitad de corrida.
      await sleep(2000);
    }
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
