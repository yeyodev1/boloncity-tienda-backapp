/**
 * Sincroniza el catalogo de los POS RunFood hacia los productos de Boloncity.
 *
 * El enlace es el SKU: `product.code` nuestro == `sku` del POS (verificado el
 * 2026-08-27: los 191 productos de Boloncity existen con ese codigo en los 1790
 * del catalogo de cada local).
 *
 * Lo que RunFood manda:
 *   - `name`   -> SOLO con `--names`, y solo si todos los locales vivos coinciden.
 *                 Apagado por defecto a proposito: el POS nombra para la comanda de
 *                 cocina, no para la vitrina ("PASADO" por "CAFE AMERICANO PASADO",
 *                 "CHOCOLANTE CALIENTE" con typo). Sin el flag se listan y ya.
 *   - `active` -> SOLO para ocultar, nunca para reactivar. Verificado el 2026-08-27:
 *                 los locales devuelven catalogos IDENTICOS entre si y sin un solo
 *                 producto inactivo, o sea que RunFood sirve el catalogo de la
 *                 cadena y `active` no dice nada del local. Reactivar con ese dato
 *                 borraria lo que el personal oculto a mano en cada sucursal.
 *
 *   - `price`  -> precio de venta en la web. El POS manda el PVP1 SIN impuesto, asi
 *                 que se le suma el IVA para obtener el precio que ve el cliente
 *                 (1.73913 -> $2.00). Tambien se alinea `hasIva`/`ivaRate` con
 *                 `tax_applicable`, o el IVA que le mandamos de vuelta al POS en el
 *                 pedido no cuadraria con el precio que cobramos.
 *
 * Decision del dueno (2026-08-27): la web cobra el PVP1. RunFood no expone el PVP2
 * por API (no hay campo pvp/price_2, `/price-lists` da 404 y `?price_list=2`/`?pvp=2`
 * se ignoran), asi que el precio de mostrador pasa a ser tambien el de la web.
 * Antes de escribir se guarda un respaldo de los precios actuales en un JSON.
 *
 * Lo que NUNCA se toca (es de Boloncity y se conserva aunque el POS no lo tenga):
 *   fotos, descripcion, categorias, puntos, destacados y orden.
 *
 * Productos NUEVOS del POS: se listan como pendientes, no se crean. La API no
 * distingue articulos de venta de los de compra (no hay `type` ni `category`), y
 * de los 1790 del POS la gran mayoria son insumos.
 *
 * Uso:
 *   DB_URI=... RUNFOOD_API_KEY=... \
 *     pnpm ts-node --transpile-only src/scripts/syncRunfoodProducts.ts [--apply] [--names] [--only=urdesa]
 *
 * Sin --apply es dry-run: imprime el plan y no escribe nada.
 */
import "dotenv/config";
import fs from "fs";
import axios from "axios";
import mongoose from "mongoose";
import { Branch } from "../models/Branch";
import { Product } from "../models/Product";
import { getOrCreateSettings } from "../models/Setting";

interface PosProduct {
  sku: string;
  name: string;
  price: number;
  tax_applicable?: boolean;
  active?: boolean;
}

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
/**
 * Los nombres solo se pisan si se pide explicitamente. El POS los usa para la
 * comanda de cocina, no para la vitrina: hoy tiene "PASADO" por "CAFE AMERICANO
 * PASADO" y "CHOCOLANTE CALIENTE" con typo. Sin este flag se listan y no se tocan.
 */
const NAMES = args.includes("--names");
const ONLY = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1]?.trim() || "";

const DB_URI = requiredEnv("DB_URI");
const API_KEY = requiredEnv("RUNFOOD_API_KEY");

const TIMEOUT_MS = 20_000; // El catalogo entero son ~1790 productos por local.

/**
 * Los nombres del POS traen espacios dobles ("BOLON CORAZON  12CM"). Comparar en
 * crudo convertiria eso en un "renombre" y ensuciaria el nombre que ve el cliente,
 * asi que se compara con los espacios colapsados.
 */
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${key}`);
  return value;
}

/** Baja el catalogo completo del local. El POS ignora `page`/`limit` y lo manda entero. */
async function fetchCatalog(baseUrl: string): Promise<Map<string, PosProduct>> {
  const { data } = await axios.get(`${baseUrl.replace(/\/+$/, "")}/products`, {
    timeout: TIMEOUT_MS,
    headers: { "X-Api-Key": API_KEY },
  });
  const items: PosProduct[] = data?.data || [];
  return new Map(items.map((item) => [String(item.sku).trim(), item]));
}

async function main() {
  await mongoose.connect(DB_URI);
  console.log(`modo: ${APPLY ? "APPLY" : "dry-run"} | filtro=${ONLY || "(todas)"}`);

  // Solo `+runfood.apiKey`: pedir tambien `runfood` entero choca con la subruta
  // ("Path collision at runfood.apiKey") y Mongo rechaza la consulta.
  const branches = await Branch.find({ isArchived: false, "runfood.baseUrl": { $ne: "" } }).select("+runfood.apiKey");
  const objetivo = branches.filter((branch) => !ONLY || branch.slug.includes(ONLY));
  if (!objetivo.length) {
    console.log("Ninguna sucursal tiene RunFood configurado todavia (corre runfood:sync primero).");
    await mongoose.disconnect();
    return;
  }

  /** Catalogo por sucursal, solo de los locales que respondieron. */
  const catalogos = new Map<string, Map<string, PosProduct>>();
  for (const branch of objetivo) {
    try {
      const catalog = await fetchCatalog(branch.runfood!.baseUrl!);
      catalogos.set(String(branch._id), catalog);
      console.log(`OK    ${branch.name.padEnd(26)} ${catalog.size} productos en el POS`);
    } catch (err) {
      const detail = axios.isAxiosError(err) ? err.code || `HTTP ${err.response?.status}` : String(err);
      console.log(`CAIDO ${branch.name.padEnd(26)} ${detail} — se omite (no se toca nada de esta sucursal)`);
    }
  }
  if (!catalogos.size) {
    console.log("Ningun local respondio: no hay nada que sincronizar.");
    await mongoose.disconnect();
    return;
  }

  const productos = await Product.find({ code: { $nin: [null, ""] } });
  const conocidos = new Set(productos.map((product) => String(product.code).trim()));
  const settings = await getOrCreateSettings();
  const tasaGlobal = settings.ivaRate || 15;

  // Respaldo de los precios antes de pisarlos: revertir tiene que ser posible.
  if (APPLY) {
    const respaldo = productos.map((product) => ({
      code: product.code,
      name: product.name,
      price: product.price,
      hasIva: product.hasIva,
      ivaRate: product.ivaRate,
    }));
    const ruta = `runfood-precios-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(ruta, JSON.stringify(respaldo, null, 2));
    console.log(`respaldo de precios: ${ruta}`);
  }

  let renombrados = 0;
  let disponibilidad = 0;
  let recotizados = 0;
  let deltaTotal = 0;

  for (const product of productos) {
    const sku = String(product.code).trim();

    // ── Disponibilidad por sucursal ──────────────────────────────────────────
    // Solo se decide sobre los locales que respondieron: un local caido no puede
    // significar "este producto ya no se vende ahi".
    const sinStock: string[] = [];
    const conStock: string[] = [];
    const nombresPos = new Set<string>();
    const preciosPos = new Set<number>();
    let gravaEnPos = false;

    for (const branch of objetivo) {
      const catalog = catalogos.get(String(branch._id));
      if (!catalog) continue;
      const pos = catalog.get(sku);
      if (pos?.active) {
        conStock.push(branch.name);
        nombresPos.add(tidy(pos.name));
        preciosPos.add(Number(pos.price));
        if (pos.tax_applicable) gravaEnPos = true;
      } else {
        sinStock.push(branch.name);
      }
    }

    const idsSinStock = objetivo
      .filter((branch) => catalogos.has(String(branch._id)) && sinStock.includes(branch.name))
      .map((branch) => branch._id);

    // Solo se OCULTA, nunca se reactiva. Verificado el 2026-08-27: los cuatro
    // locales devuelven catalogos identicos (mismos SKU, mismo precio, mismo
    // `active`) y ninguno tiene un producto inactivo. O sea que RunFood sirve el
    // catalogo de la CADENA, no el del local: `active` no dice nada sobre lo que
    // se vende en cada sucursal. Reactivar con ese dato borraria las ocultaciones
    // que el personal puso a mano (hoy 65, casi todas en Republica y Avalon).
    const previas: string[] = (product.unavailableBranches || []).map((id: unknown) => String(id));
    const siguientes = [...new Set([...previas, ...idsSinStock.map(String)])];

    if (previas.slice().sort().join() !== siguientes.slice().sort().join()) {
      disponibilidad += 1;
      // Importa distinguir que se apaga de que se PRENDE: prender es pisar una
      // decision que alguien tomo a mano en el admin.
      const nombrePorId = new Map(objetivo.map((branch) => [String(branch._id), branch.name]));
      const seApagan = siguientes.filter((id) => !previas.includes(id)).map((id) => nombrePorId.get(id) || id);
      console.log(`  disponibilidad ${sku.padEnd(10)} ${product.name.slice(0, 30).padEnd(30)} se oculta en ${seApagan.join(", ")}`);
      if (APPLY) product.set("unavailableBranches", siguientes);
    }

    // Igual que arriba: solo se baja, nunca se sube. Que el POS lo tenga activo no
    // significa que la tienda deba publicarlo — esa es una decision de Boloncity.
    if (product.isAvailable && conStock.length === 0 && catalogos.size > 0) {
      console.log(`  isAvailable    ${sku.padEnd(10)} ${product.name.slice(0, 30).padEnd(30)} true -> false (no está en ningún POS)`);
      if (APPLY) product.isAvailable = false;
    }

    // ── Precio ───────────────────────────────────────────────────────────────
    // El POS manda la base sin impuesto; el cliente ve el precio con IVA.
    // Si dos locales cotizan distinto no se toca: no hay un precio unico que poner.
    if (preciosPos.size === 1) {
      const base = [...preciosPos][0];
      const tasa = gravaEnPos ? tasaGlobal : 0;
      const nuevo = Math.round(base * (1 + tasa / 100) * 100) / 100;

      if (Math.abs(nuevo - product.price) >= 0.005) {
        recotizados += 1;
        deltaTotal += nuevo - product.price;
        console.log(
          `  precio         ${sku.padEnd(10)} ${product.name.slice(0, 30).padEnd(30)} $${product.price.toFixed(2)} -> $${nuevo.toFixed(2)}`
        );
        if (APPLY) product.price = nuevo;
      }

      // `hasIva`/`ivaRate` tienen que reflejar como se armo ese precio: el pedido
      // los usa para desglosar el IVA que le mandamos de vuelta al POS.
      if (product.hasIva !== gravaEnPos) {
        console.log(`  hasIva         ${sku.padEnd(10)} ${product.name.slice(0, 30).padEnd(30)} ${product.hasIva} -> ${gravaEnPos}`);
        if (APPLY) product.hasIva = gravaEnPos;
      }
      const tasaEsperada = gravaEnPos ? tasaGlobal : 0;
      if (product.ivaRate !== tasaEsperada) {
        if (APPLY) product.ivaRate = tasaEsperada;
      }
    } else if (preciosPos.size > 1) {
      console.log(`  PRECIO DISPAR  ${sku.padEnd(10)} los locales cotizan distinto: ${[...preciosPos].join(" / ")} — no se toca`);
    }

    // ── Nombre ───────────────────────────────────────────────────────────────
    // Solo si todos los locales vivos que lo tienen coinciden en como se llama.
    if (nombresPos.size === 1) {
      const nombrePos = [...nombresPos][0];
      if (nombrePos && nombrePos !== tidy(product.name)) {
        renombrados += 1;
        console.log(
          `  nombre         ${sku.padEnd(10)} "${product.name}" -> "${nombrePos}"${NAMES ? "" : "   (no se aplica: falta --names)"}`
        );
        if (APPLY && NAMES) product.name = nombrePos;
      }
    } else if (nombresPos.size > 1) {
      console.log(`  NOMBRE DISPAR  ${sku.padEnd(10)} los locales no coinciden: ${[...nombresPos].join(" | ")} — no se toca`);
    }

    if (APPLY && product.isModified()) await product.save();
  }

  // ── Productos nuevos en el POS ─────────────────────────────────────────────
  // No se crean: la API no distingue venta de compra y la mayoria son insumos.
  const nuevos = new Map<string, { name: string; branches: string[] }>();
  for (const branch of objetivo) {
    const catalog = catalogos.get(String(branch._id));
    if (!catalog) continue;
    for (const [sku, pos] of catalog) {
      if (conocidos.has(sku) || !pos.active) continue;
      const previo = nuevos.get(sku);
      if (previo) previo.branches.push(branch.name);
      else nuevos.set(sku, { name: pos.name, branches: [branch.name] });
    }
  }

  console.log(
    `\nresumen: ${recotizados} precios · ${disponibilidad} cambios de disponibilidad · ${renombrados} renombrados` +
      (recotizados ? ` | cambio promedio $${(deltaTotal / recotizados).toFixed(3)} por producto` : "")
  );
  console.log(`productos en el POS que NO existen en la web: ${nuevos.size} (no se crean: revisar cuales son de venta)`);
  console.log(APPLY ? "cambios aplicados" : "dry-run: no se escribio nada (agrega --apply)");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
