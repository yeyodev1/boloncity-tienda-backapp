/**
 * Asigna a cada sucursal su tienda de PayPhone (branches.payphone.storeId).
 *
 * El token de PayPhone es de la cuenta (uno solo, en PAYPHONE_TOKEN); lo que separa la
 * plata por local es el storeId que recibe la cajita de pagos. Sin esto todos los cobros
 * caen en la tienda global de PAYPHONE_STORE_ID.
 *
 * Uso:
 *   DB_URI=... pnpm payphone:sync            # dry-run, solo imprime el plan
 *   DB_URI=... pnpm payphone:sync --apply
 *
 * Los storeId son los mismos en desarrollo y produccion.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Branch } from "../models/Branch";
import { slugify } from "../utils/slugify";

const APPLY = process.argv.includes("--apply");

const DB_URI = process.env.DB_URI?.trim();
if (!DB_URI) throw new Error("Falta la variable de entorno DB_URI");

/** slug de la sucursal -> storeId de PayPhone */
const PAYPHONE_STORES: Record<string, string> = {
  "boloncity-urdesa": "f7ef521b-fc78-4154-a337-6ea80aea4d1f",
  "boloncity-la-joya": "0465fc96-a9c9-40b1-8a02-a29a08195954",
  "boloncity-kennedy": "d003edcf-850c-49da-b239-8630b9f9b9cd",
  "boloncity-republica": "b7cc506e-01bc-41d7-b5ef-f15c99b9381d",
  // slugify() no translitera tildes: "República" quedo guardado como "rep-blica".
  "boloncity-rep-blica": "b7cc506e-01bc-41d7-b5ef-f15c99b9381d",
  "boloncity-centro": "5788c77c-7aec-4ea7-9a4f-bcfc381a9e6b",
  "boloncity-garzota": "0572cdaa-ff28-4dd4-a79b-fff89a9119bb",
  "boloncity-avalon-plaza": "77fc181a-f500-4b9d-8a9e-dddcc9f3506a",
  // "Blue Coast" es el nombre del local en PayPhone y en Picker produccion.
  "boloncity-via-a-la-costa": "18cffea1-a7a7-4aab-b6da-3b49563c7671",
  "boloncity-v-a-a-la-costa": "18cffea1-a7a7-4aab-b6da-3b49563c7671",
};

/** Slugs equivalentes: solo cuenta como "sin sucursal" si falta el grupo entero. */
const SLUG_ALIASES: string[][] = [
  ["boloncity-republica", "boloncity-rep-blica"],
  ["boloncity-via-a-la-costa", "boloncity-v-a-a-la-costa"],
];

async function main() {
  await mongoose.connect(DB_URI!);
  console.log(`[payphone-sync] db=${mongoose.connection.name} apply=${APPLY}`);

  const branches = await Branch.find({ isArchived: { $ne: true } }).sort({ name: 1 });
  const used = new Set<string>();
  let updated = 0;
  const unmatched: string[] = [];

  for (const branch of branches) {
    const slug = branch.slug || slugify(branch.name);
    const storeId = PAYPHONE_STORES[slug];

    if (!storeId) {
      unmatched.push(`${branch.name} (${slug})`);
      console.log(`  [SIN MAPA] ${branch.name} — slug "${slug}" no esta en PAYPHONE_STORES`);
      continue;
    }
    used.add(slug);

    const current = branch.payphone?.storeId || "";
    if (current === storeId) {
      console.log(`  [OK ] ${branch.name} <- ${storeId}`);
      continue;
    }
    console.log(`  [SET] ${branch.name} <- ${storeId}${current ? ` (reemplaza ${current})` : ""}`);
    if (!APPLY) continue;

    await Branch.updateOne({ _id: branch._id }, { $set: { "payphone.storeId": storeId } });
    updated += 1;
  }

  const aliasOf = (slug: string) => SLUG_ALIASES.find((group) => group.includes(slug)) || [slug];
  const missing = Object.keys(PAYPHONE_STORES).filter((slug) => !aliasOf(slug).some((alias) => used.has(alias)));
  console.log(`\n[payphone-sync] actualizadas=${updated} sin_mapa=${unmatched.length}`);
  if (missing.length) console.log(`[payphone-sync] storeIds sin sucursal en esta db: ${missing.join(", ")}`);
  if (!APPLY) console.log("[payphone-sync] dry-run: volver a correr con --apply para escribir");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[payphone-sync] error:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
