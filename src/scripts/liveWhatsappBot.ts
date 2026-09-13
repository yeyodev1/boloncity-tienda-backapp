/**
 * Prueba EN VIVO del bot contra los servicios reales del entorno (Mongo, Gemini, Picker),
 * SIN crear órdenes ni guardar sesiones. `createOrder` está simulado: no se toca RunFood,
 * PayPhone, Meta ni correos.
 *
 *   DOTENV_CONFIG_PATH=.env.local npm run test:bot:live
 *
 * Imprime cada turno con la regla que decidió, el paso siguiente y cuánto tardó.
 */
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { env } from "../config/env";
import { Branch } from "../models/Branch";
import { buildDeps } from "../controllers/whatsappBot.controller";
import { listCategories, loadCatalog } from "../services/whatsappBot/catalog";
import { createInitialState, handleTurn } from "../services/whatsappBot/router";
import { pickerEnabledBranchFilter } from "../services/branchOperational.service";

// Teléfono de prueba que no pertenece a ningún cliente real.
const TEST_PHONE = "+593900000001";

async function main() {
  await dbConnect();
  console.log(`APP_ENV=${env.APP_ENV} · PICKER_ENV=${env.PICKER_ENV} · Gemini=${env.GEMINI_API_KEY ? env.GEMINI_MODEL : "SIN KEY (usa reglas)"}`);

  const catalog = await loadCatalog();
  console.log(`Catálogo vendible: ${catalog.length} productos · ${listCategories(catalog).length} categorías`);

  const branch = await Branch.findOne({ isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter(), "coordinates.lat": { $ne: null } });
  if (!branch?.coordinates) throw new Error("No hay sucursal activa con Picker y coordenadas en este entorno");
  // Un punto a ~500 m de la sucursal, dentro de cualquier zona razonable.
  const location = { lat: branch.coordinates.lat + 0.004, lng: branch.coordinates.lng + 0.002 };
  console.log(`Ubicación de prueba cerca de: ${branch.name}\n`);

  // BOT_FORCE_OPEN=1 simula el local abierto para recorrer el flujo completo fuera de horario. Solo en este script.
  const forceOpen = process.env.BOT_FORCE_OPEN === "1";
  if (forceOpen) console.log("⚠️ BOT_FORCE_OPEN=1: se simula que el local está abierto\n");

  const deps = buildDeps({
    ...(forceOpen ? { branchStatus: async () => ({ open: true }) } : {}),
    createOrder: async (state) => ({
      ok: true,
      orderNumber: "ORD-PRUEBA",
      total: 0,
      paymentLink: state.paymentMethod === "card" ? "https://(link de prueba, no se creó orden)" : undefined,
    }),
  });

  const turns: Array<string | { location: { lat: number; lng: number } }> = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
        "hola buenas",
        "quisiera 2 bolones mixtos de verde y un cafecito",
        "el primero",
        "que sean 3 bolones mejor",
        "para delivery porfa",
        { location },
        "Cdla. Kennedy Norte, calle 5, casa esquinera blanca",
        "Diego Reyes",
        "diego.prueba@bakano.ec",
        "pago por transferencia",
        "ok entonces efectivo",
        "confirmo",
      ];

  let state = createInitialState(TEST_PHONE);
  for (const turn of turns) {
    const input = typeof turn === "string" ? { message: turn } : { message: "", location: turn.location };
    const started = Date.now();
    const result = await handleTurn(state, input, deps);
    const ms = Date.now() - started;
    state = result.state;
    console.log(`👤 ${input.message || `[ubicación ${input.location!.lat.toFixed(4)},${input.location!.lng.toFixed(4)}]`}`);
    console.log(`🤖 ${result.decision} → ${result.step} · ${ms} ms${ms > 15000 ? " ⚠️ LENTO" : ""}`);
    console.log(`${result.reply.split("\n").map((line) => `   ${line}`).join("\n")}\n`);
  }
  console.log("Carrito final:", state.cart.map((item) => `${item.quantity} x ${item.name}`).join(", ") || "(vacío)");
}

main()
  .catch((error) => {
    console.error("❌", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
