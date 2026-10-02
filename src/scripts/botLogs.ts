/**
 * Bitácora del bot de WhatsApp (colección BotLog, 30 días).
 *
 *   npm run bot:logs                    últimos 40 mensajes
 *   npm run bot:logs -- 593995254965    conversación de un teléfono
 *   npm run bot:logs -- --errors        solo errores
 *   npm run bot:logs -- --limit 100     cuántos mostrar
 *
 * Usa DB_URI del .env (Atlas). Para leer producción: DOTENV_CONFIG_PATH=.env.production npm run bot:logs
 */
import mongoose from "mongoose";
import { dbConnect } from "../config/mongo";
import { BotLog } from "../models/BotLog";

async function main() {
  const args = process.argv.slice(2);
  const errorsOnly = args.includes("--errors");
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? Math.max(1, Number(args[limitIndex + 1]) || 40) : 40;
  const phoneArg = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--limit");
  const digits = phoneArg ? phoneArg.replace(/\D/g, "") : "";

  await dbConnect();
  const filter: Record<string, unknown> = {};
  if (digits) filter.phone = { $regex: `${digits.slice(-9)}$` };
  if (errorsOnly) filter.error = { $exists: true, $ne: "" };
  const rows: any[] = await BotLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();

  const time = (date: Date) => new Intl.DateTimeFormat("es-EC", { timeZone: "America/Guayaquil", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(date));
  for (const row of rows.reverse()) {
    console.log(`\n${time(row.createdAt)} · ${row.phone} · /${row.endpoint} · ${row.decision} → paso ${row.step || "-"} · ${row.ms}ms${row.aiVoice ? " · voz IA" : ""}${row.media ? ` · ${row.media}` : ""}`);
    console.log(`  👤 ${row.message || "(vacío)"}`);
    if (row.error) console.log(`  ❌ ${row.error}`);
    if (row.reply) console.log(`  🤖 ${String(row.reply).replace(/\n/g, "\n     ")}`);
  }
  console.log(`\n${rows.length} mensajes${digits ? ` de ${digits}` : ""}${errorsOnly ? " con error" : ""}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
