/**
 * Carga el horario de atencion en las sucursales que lo tengan vacio o distinto.
 *
 * Sin openingHours una sucursal se considera CERRADA siempre: no se puede programar
 * pedidos en ella y (desde el bloqueo por horario) tampoco comprar de inmediato.
 *
 * Uso:
 *   DB_URI=... npx ts-node --transpile-only src/scripts/setBranchHours.ts \
 *     [--opens=07:00] [--closes=13:00] [--days=all] [--only=slug1,slug2] [--force] [--apply]
 *
 * Sin --apply solo imprime el plan (dry-run).
 * Sin --force solo toca las sucursales con horario vacio o incompleto.
 * --days acepta "all" o una lista: monday,tuesday,...  (los dias no listados quedan cerrados)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Branch, BranchWeekday } from "../models/Branch";

const WEEKDAYS: BranchWeekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const FORCE = args.includes("--force");

function argValue(name: string, fallback: string): string {
  return (args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] || fallback).trim();
}

const OPENS_AT = argValue("opens", "07:00");
const CLOSES_AT = argValue("closes", "13:00");
const DAYS_ARG = argValue("days", "all").toLowerCase();
const ONLY = argValue("only", "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const OPEN_DAYS: BranchWeekday[] =
  DAYS_ARG === "all" ? WEEKDAYS : (DAYS_ARG.split(",").map((day) => day.trim()) as BranchWeekday[]);

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${key}`);
  return value;
}

function buildHours() {
  return WEEKDAYS.map((day) => ({
    day,
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    isOpen: OPEN_DAYS.includes(day),
  }));
}

/** Un horario esta incompleto si falta algun dia de la semana. */
function isIncomplete(hours: { day: string }[] | undefined): boolean {
  if (!hours || hours.length !== WEEKDAYS.length) return true;
  return new Set(hours.map((item) => item.day)).size !== WEEKDAYS.length;
}

function describe(hours: { day: string; opensAt: string; closesAt: string; isOpen: boolean }[] | undefined): string {
  if (!hours?.length) return "SIN HORARIO";
  const open = hours.filter((item) => item.isOpen);
  if (!open.length) return "cerrada los 7 dias";
  const ranges = new Set(open.map((item) => `${item.opensAt}-${item.closesAt}`));
  return `${open.length}/7 dias  ${[...ranges].join(" / ")}`;
}

async function main() {
  if (!TIME_PATTERN.test(OPENS_AT) || !TIME_PATTERN.test(CLOSES_AT)) {
    throw new Error("--opens y --closes deben usar formato HH:mm");
  }
  if (OPENS_AT >= CLOSES_AT) {
    throw new Error("--closes debe ser posterior a --opens");
  }
  const invalidDay = OPEN_DAYS.find((day) => !WEEKDAYS.includes(day));
  if (invalidDay) {
    throw new Error(`--days contiene un dia invalido: ${invalidDay}`);
  }

  await mongoose.connect(requiredEnv("DB_URI"));

  const query: Record<string, unknown> = { isArchived: { $ne: true } };
  if (ONLY.length) query.slug = { $in: ONLY };

  const branches = await Branch.find(query).sort({ name: 1 });
  const hours = buildHours();

  console.log(`[hours] horario=${OPENS_AT}-${CLOSES_AT} dias=${OPEN_DAYS.length} apply=${APPLY} force=${FORCE}`);
  console.log(`[hours] sucursales no archivadas encontradas: ${branches.length}\n`);

  let changed = 0;

  for (const branch of branches) {
    const needsHours = isIncomplete(branch.openingHours);
    const target = FORCE || needsHours;

    if (!target) {
      console.log(`  = ${branch.name.padEnd(28)} ya configurada  (${describe(branch.openingHours)})`);
      continue;
    }

    console.log(`  ${APPLY ? "*" : "~"} ${branch.name.padEnd(28)} ${describe(branch.openingHours)}  ->  ${OPEN_DAYS.length}/7 dias  ${OPENS_AT}-${CLOSES_AT}`);
    changed += 1;

    if (!APPLY) continue;

    branch.openingHours = hours;
    if (!branch.timezone) branch.timezone = "America/Guayaquil";
    await branch.save();
  }

  console.log(`\n[hours] ${APPLY ? "actualizadas" : "por actualizar"}: ${changed}/${branches.length}`);
  if (!APPLY && changed > 0) console.log("[hours] dry-run: volve a correr con --apply para escribir");

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(`[hours] error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
