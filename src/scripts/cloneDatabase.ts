/**
 * Clona colecciones de una base Mongo a otra (para sembrar el entorno de desarrollo
 * a partir de produccion). Sobrescribe por _id, no borra lo que ya existe salvo --drop.
 *
 * Uso:
 *   SOURCE_DB_URI=... TARGET_DB_URI=... \
 *     npx ts-node --transpile-only src/scripts/cloneDatabase.ts \
 *       --collections=branches,categories,products,settings,users,counters [--apply] [--drop]
 */
import "dotenv/config";
import mongoose from "mongoose";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const DROP = args.includes("--drop");
const collectionsArg = args.find((a) => a.startsWith("--collections="));
const COLLECTIONS = (collectionsArg?.split("=")[1] || "branches,categories,products,settings,users,counters")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${key}`);
  return value;
}

async function main() {
  const sourceUri = requiredEnv("SOURCE_DB_URI");
  const targetUri = requiredEnv("TARGET_DB_URI");

  const source = await mongoose.createConnection(sourceUri).asPromise();
  const target = await mongoose.createConnection(targetUri).asPromise();

  console.log(`[clone] origen=${source.name} destino=${target.name} apply=${APPLY} drop=${DROP}`);

  for (const name of COLLECTIONS) {
    const docs = await source.db!.collection(name).find({}).toArray();
    const existing = await target.db!.collection(name).countDocuments().catch(() => 0);
    console.log(`  ${name}: origen=${docs.length} destino=${existing}`);

    if (!APPLY || docs.length === 0) continue;

    if (DROP && existing > 0) {
      await target.db!.collection(name).deleteMany({});
    }

    const operations = docs.map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    }));
    const result = await target.db!.collection(name).bulkWrite(operations, { ordered: false });
    console.log(`    -> upserted=${result.upsertedCount} modified=${result.modifiedCount}`);
  }

  if (!APPLY) console.log("[clone] dry-run: volver a correr con --apply para escribir");

  await source.close();
  await target.close();
}

main().catch(async (error) => {
  console.error("[clone] error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
