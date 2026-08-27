/**
 * Carga la configuracion de RunFood (POS on-premise) en cada Branch de Mongo.
 *
 * RunFood entrego UNA sola API key para los ocho locales: lo que separa un local
 * de otro es la URL base, porque el servidor vive dentro del restaurante. Por eso
 * el mapeo de abajo es slug de sucursal -> IP del local, y equivocarse imprime la
 * comanda en la cocina de otra sucursal.
 *
 * Uso:
 *   DB_URI=... RUNFOOD_API_KEY=... \
 *     pnpm ts-node --transpile-only src/scripts/syncRunfoodBranches.ts [--apply] [--enable] [--only=garzota]
 *
 * Sin --apply solo imprime el plan (dry-run).
 *
 * --enable  enciende el envio (runfood.enabled = true). Por defecto las credenciales
 *           se cargan APAGADAS: primero se sondea el local y despues se enciende,
 *           uno por uno. Un local caido con enabled=true solo suma reintentos.
 * --only=   filtra por slug (subcadena), para encender de a poco.
 *
 * Antes de --enable, corre --verify: golpea /health, /identity y /apps/me de cada
 * local y avisa si la IP responde con el nombre de OTRA sucursal, que es el fallo
 * mas caro de todos.
 */
import "dotenv/config";
import axios from "axios";
import mongoose from "mongoose";
import { Branch } from "../models/Branch";

/** slug de la sucursal en Mongo -> URL base del servidor RunFood de ese local. */
const LOCAL_BASE_URLS: Record<string, string> = {
  "boloncity-la-joya": "http://186.3.149.51:1000/api/v1",
  "boloncity-kennedy": "http://181.198.203.171:1000/api/v1",
  "boloncity-centro": "http://181.39.245.89:1000/api/v1",
  "boloncity-garzota": "http://181.198.245.112:1000/api/v1",
  "boloncity-urdesa": "http://186.101.243.150:1000/api/v1",
  "boloncity-republica": "http://186.4.130.151:1000/api/v1",
  "boloncity-avalon-plaza": "http://186.3.235.200:1000/api/v1",
  "boloncity-via-a-la-costa": "http://181.39.229.202:1000/api/v1",
};

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ENABLE = args.includes("--enable");
const VERIFY = args.includes("--verify");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1]?.trim() || "";

const DB_URI = requiredEnv("DB_URI");
const API_KEY = requiredEnv("RUNFOOD_API_KEY");

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${key}`);
  return value;
}

/** Normaliza para comparar el nombre que devuelve el POS con el de la sucursal. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface ProbeResult {
  reachable: boolean;
  posName?: string;
  vatRate?: number;
  scopes?: string[];
  detail: string;
}

/** Sondeo de solo lectura: nunca crea pedidos (imprimiria una comanda real). */
async function probeLocal(baseUrl: string): Promise<ProbeResult> {
  const http = axios.create({
    baseURL: baseUrl.replace(/\/+$/, ""),
    timeout: 8_000,
    headers: { "X-Api-Key": API_KEY },
  });
  try {
    await http.get("/health");
    const { data: identity } = await http.get("/identity");
    let scopes: string[] | undefined;
    try {
      const { data: me } = await http.get("/apps/me");
      scopes = me?.scopes;
    } catch {
      // /apps/me es informativo: que falle no invalida la conexion.
    }
    return {
      reachable: true,
      posName: identity?.name || identity?.business?.name,
      vatRate: Number(identity?.taxes?.vat_rate),
      scopes,
      detail: "ok",
    };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const detail = err.response ? `HTTP ${err.response.status}` : err.code || err.message;
      return { reachable: false, detail };
    }
    return { reachable: false, detail: err instanceof Error ? err.message : "error desconocido" };
  }
}

async function main() {
  await mongoose.connect(DB_URI);
  console.log(`modo: ${APPLY ? "APPLY" : "dry-run"} | enabled=${ENABLE} | verify=${VERIFY} | filtro=${ONLY || "(todas)"}`);

  let updated = 0;
  let unreachable = 0;

  for (const [slug, baseUrl] of Object.entries(LOCAL_BASE_URLS)) {
    if (ONLY && !slug.includes(ONLY)) continue;

    const branch = await Branch.findOne({ slug }).select("+runfood.apiKey");
    if (!branch) {
      console.log(`SIN SUCURSAL   ${slug} — no existe en esta base, se omite`);
      continue;
    }
    if (branch.isArchived) {
      console.log(`ARCHIVADA      ${branch.name} — se omite`);
      continue;
    }

    let probeNote = "";
    if (VERIFY) {
      const probe = await probeLocal(baseUrl);
      if (!probe.reachable) {
        unreachable += 1;
        probeNote = `  [POS NO RESPONDE: ${probe.detail}]`;
      } else {
        // El local devuelve su propio nombre: si no se parece al de la sucursal,
        // esta IP es de otro local y las comandas saldrian en la cocina equivocada.
        const posName = probe.posName || "";
        const looksCrossed =
          posName && !normalize(posName).includes(normalize(branch.name).replace("boloncity ", ""));
        probeNote = `  [POS "${posName}" IVA ${probe.vatRate ?? "?"}% scopes ${probe.scopes?.join(",") || "?"}${looksCrossed ? " ⚠ NOMBRE NO COINCIDE" : ""}]`;
      }
    }

    const current = branch.runfood || {};
    const same = current.enabled === ENABLE && current.baseUrl === baseUrl && current.apiKey === API_KEY;

    console.log(
      `${same ? "SIN CAMBIO    " : "ACTUALIZAR    "} ${branch.name.padEnd(26)} ${baseUrl}  enabled ${current.enabled ?? false} -> ${ENABLE}  key ${current.apiKey ? "ya cargada" : "nueva"}${probeNote}`
    );
    if (same || !APPLY) continue;

    branch.set("runfood", { enabled: ENABLE, baseUrl, apiKey: API_KEY });
    await branch.save();
    updated += 1;
  }

  console.log(APPLY ? `sucursales actualizadas: ${updated}` : "dry-run: no se escribio nada (agrega --apply)");
  if (VERIFY && unreachable) console.log(`locales sin responder: ${unreachable}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
