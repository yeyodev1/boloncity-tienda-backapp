/**
 * Deja el catalogo visible en todas las sucursales.
 *
 * El catalogo se filtra con: `branches` vacio = disponible en todas, o `branches`
 * contiene la sucursal. Los 251 productos quedaron apuntando a "Sucursal Principal"
 * (archivada), asi que ninguna sucursal activa mostraba nada.
 *
 * Este script vacia `branches` en los productos que solo apuntan a sucursales
 * archivadas o inexistentes, con lo que pasan a estar disponibles en todas.
 * Los productos que ya apuntan a sucursales activas no se tocan.
 *
 * Uso:
 *   DB_URI=... pnpm products:fix-branches            # dry-run
 *   DB_URI=... pnpm products:fix-branches --apply
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Branch } from "../models/Branch";
import { Product } from "../models/Product";

const APPLY = process.argv.includes("--apply");
const DB_URI = process.env.DB_URI?.trim();
if (!DB_URI) throw new Error("Falta la variable de entorno DB_URI");

async function main() {
  await mongoose.connect(DB_URI!);
  console.log(`[products] db=${mongoose.connection.name} apply=${APPLY}`);

  const activeBranches = await Branch.find({ isActive: true, isArchived: { $ne: true } }).select("_id name");
  const activeIds = new Set(activeBranches.map((branch) => String(branch._id)));
  console.log(`[products] sucursales activas: ${activeBranches.length}`);
  if (!activeBranches.length) throw new Error("No hay sucursales activas; aborto para no dejar el catalogo huerfano");

  const products = await Product.find({}).select("name branches unavailableBranches");
  let huerfanos = 0;
  let yaOk = 0;
  let limpiados = 0;

  for (const product of products) {
    const assigned = (product.branches || []).map(String);
    const apuntaAActiva = assigned.some((id: string) => activeIds.has(id));

    if (!assigned.length) { yaOk += 1; continue; }
    if (apuntaAActiva) { yaOk += 1; continue; }

    huerfanos += 1;
    if (!APPLY) continue;

    // `branches: []` significa "disponible en todas las sucursales" en el filtro del catalogo.
    await Product.updateOne({ _id: product._id }, { $set: { branches: [] } });
    limpiados += 1;
  }

  console.log(`[products] revisados=${products.length} ya_visibles=${yaOk} huerfanos=${huerfanos} corregidos=${limpiados}`);

  // Las sucursales archivadas tampoco deben quedar en unavailableBranches.
  const stale = await Product.updateMany(
    { unavailableBranches: { $exists: true, $ne: [] } },
    { $pull: { unavailableBranches: { $nin: [...activeIds].map((id) => new mongoose.Types.ObjectId(id)) } } }
  );
  if (APPLY) console.log(`[products] unavailableBranches depurados en ${stale.modifiedCount} productos`);

  if (APPLY) {
    console.log("\n[products] verificacion por sucursal:");
    for (const branch of activeBranches) {
      const count = await Product.countDocuments({
        isAvailable: true,
        $or: [
          { branches: { $size: 0 }, unavailableBranches: { $ne: branch._id } },
          { branches: branch._id },
        ],
      });
      console.log(`  ${branch.name.padEnd(26)} ${count} productos`);
    }
  } else {
    console.log("[products] dry-run: volver a correr con --apply para escribir");
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[products] error:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
