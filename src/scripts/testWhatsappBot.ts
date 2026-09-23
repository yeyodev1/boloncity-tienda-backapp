/**
 * Pruebas del bot de WhatsApp sin base de datos ni internet.
 *
 *   npm run test:bot
 *
 * Usa el menú real (seeds/menuItems.ts) con el buscador real y el router real. Solo se
 * reemplazan Mongo, Picker y Gemini por datos falsos, así cada conversación es
 * repetible. La extracción usa las reglas (sin IA): si pasa sin IA, con IA entiende más.
 */
process.env.DB_URI = process.env.DB_URI || "mongodb://test-sin-conexion";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test";
process.env.GEMINI_API_KEY = "";

import assert from "node:assert/strict";
import { menuSeedItems } from "../seeds/menuItems";
import { CatalogProduct, findCategory, listCategories, rankProducts } from "../services/whatsappBot/catalog";
import { pickChoice } from "../services/whatsappBot/choice";
import { faqTopic } from "../services/whatsappBot/intents";
import axios from "axios";
import { env } from "../config/env";
import { aiExtract, Extractor, heuristicExtract } from "../services/whatsappBot/extractor";
import { claimsPaid, classifyConfirmReply, extractDocNumber, extractOrderNumber, isPlainConfirmation, isQuestion, isSmallTalk, splitItemPhrases, titleCaseName, wantsHuman, wantsTracking } from "../services/whatsappBot/intents";
import { botResponseRoute, isDuplicateTurn, isOtherHttpNode, isRetry, latestUserMessage, pendingKey, toE164, turnHash, turnRecord } from "../controllers/whatsappBot.controller";
import { decideFromSale } from "../services/cardPaymentSettlement.service";
import { FALLBACK_MESSAGE } from "../controllers/whatsappBot.controller";
import { WhatsAppSession } from "../models/WhatsAppSession";
import { isBotPath } from "../app";
import { BotDeps, BotState, classifyRoute, cleanQueryLabel, createInitialState, handleTurn, LastOrder, PaymentSettlement, sameProductQuery, TurnResult } from "../services/whatsappBot/router";

const MENU: CatalogProduct[] = menuSeedItems
  .filter((item) => item.price > 0)
  .map((item) => ({ productId: `p${item.sourceId}`, name: item.name, price: item.price, categoryNames: [item.line], tags: [] }));

const byName = (name: string) => MENU.find((product) => product.name === name)!;

interface FakeOptions {
  lastOrder?: LastOrder | null;
  closed?: boolean;
  covered?: boolean;
  unavailableAtBranch?: string[];
  /** Solo estas sucursales están cerradas. */
  closedBranches?: string[];
  /** Picker cobra distinto en efectivo. */
  cashFee?: number;
  /** Qué contesta PayPhone (a través del caso de uso compartido) cuando el cliente escribe "pagado". */
  settlement?: PaymentSettlement | PaymentSettlement[];
  extract?: Extractor;
}

/** Próxima apertura falsa: mañana a las 07:00 en Guayaquil. Siempre futura, como la real. */
function fakeNextOpening() {
  const tomorrow = new Date(Date.now() + 86_400_000);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guayaquil" }).format(tomorrow);
  const label = `mañana ${new Intl.DateTimeFormat("es-EC", { timeZone: "America/Guayaquil", weekday: "long", day: "numeric" }).format(tomorrow)}`;
  return { at: `${date}T07:00:00-05:00`, opensAt: "07:00", closesAt: "13:00", label };
}

const FAKE_BRANCHES = [
  { branchId: "b-urdesa", name: "Urdesa", address: "Av. Víctor Emilio Estrada", distance: 3.1, fee: 2.5 },
  { branchId: "b-samborondon", name: "Samborondón", address: "Km 2.5", distance: 9.4, fee: 5.9 },
];

function fakeDeps(options: FakeOptions = {}) {
  const created: BotState[] = [];
  const settled: string[] = [];
  const isClosed = (branchId: string) => Boolean(options.closed || options.closedBranches?.includes(branchId));
  const opening = fakeNextOpening();
  const deps: BotDeps = {
    search: async (query, branchId) => rankProducts(query, branchId ? MENU.filter((p) => !options.unavailableAtBranch?.includes(p.name)) : MENU),
    catalog: async (branchId) => (branchId ? MENU.filter((p) => !options.unavailableAtBranch?.includes(p.name)) : MENU),
    lastOrder: async () => options.lastOrder ?? null,
    resolveMapsUrl: async () => ({ lat: -2.15, lng: -79.9 }),
    quoteLocation: async (_coords, paymentMethod, preferBranchId) => {
      if (options.covered === false) return { covered: false, reason: "Todavía no llegamos a esa dirección con delivery" };
      // Gana la MÁS CERCANA que cubra (Urdesa), abierta o cerrada; salvo que el cliente haya elegido otra.
      const winner = FAKE_BRANCHES.find((branch) => branch.branchId === preferBranchId) || FAKE_BRANCHES[0];
      const alternative = FAKE_BRANCHES.find((branch) => !isClosed(branch.branchId) && branch.branchId !== winner.branchId);
      const fee = winner.branchId === "b-urdesa" && paymentMethod === "cash" && options.cashFee ? options.cashFee : winner.fee;
      return {
        covered: true,
        branchId: winner.branchId,
        branchName: winner.name,
        deliveryFee: fee,
        distance: winner.distance,
        open: !isClosed(winner.branchId),
        nextOpening: isClosed(winner.branchId) ? opening : null,
        openAlternative: alternative ? { branchId: alternative.branchId, branchName: alternative.name, deliveryFee: alternative.fee, distance: alternative.distance } : null,
      };
    },
    pickupBranches: async () =>
      FAKE_BRANCHES.map((branch) => ({
        branchId: branch.branchId,
        name: branch.name,
        address: branch.address,
        open: !isClosed(branch.branchId),
        // Como en producción: una sucursal ABIERTA también trae su ventana (la que está en curso).
        nextOpening: opening,
      })),
    branchStatus: async (branchId) =>
      isClosed(branchId)
        ? { open: false, branchName: FAKE_BRANCHES.find((b) => b.branchId === branchId)?.name || "Urdesa", nextOpening: opening, message: "Urdesa está cerrada en este momento. Abre a las 07:00" }
        : { open: true, branchName: FAKE_BRANCHES.find((b) => b.branchId === branchId)?.name },
    quote: async (state) => {
      const lines = state.cart.map((item) => ({ name: item.name, quantity: item.quantity, unitPrice: MENU.find((p) => p.productId === item.productId)!.price }));
      const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
      const deliveryFee = state.deliveryType === "delivery" ? state.deliveryFee || 0 : 0;
      return { lines, subtotal, promoAmount: 0, deliveryFee, total: subtotal + deliveryFee };
    },
    createOrder: async (state) => {
      created.push(JSON.parse(JSON.stringify(state)));
      return { ok: true, orderNumber: `ORD-0099${created.length}`, total: 12.5, paymentLink: state.paymentMethod === "card" ? "https://boloncity.com/pago/ORD-00991?email=x" : undefined };
    },
    // PayPhone simulado: nunca se llama a la API real. `settled` cuenta los llamados efectivos para
    // comprobar que dos "pagado" seguidos no disparan dos cierres.
    settlePayment: async (orderNumber) => {
      settled.push(orderNumber);
      const configured = options.settlement;
      const fallback: PaymentSettlement = { outcome: "pending" };
      if (!configured) return fallback;
      if (Array.isArray(configured)) return configured[Math.min(settled.length - 1, configured.length - 1)] || fallback;
      return configured;
    },
    trackOrder: async () => "Pedido ORD-00123 · En camino",
    extract: options.extract || heuristicExtract,
    menuUrl: "https://boloncity.com/catalogo",
    supportPhone: "+593 99 315 7333",
  };
  return { deps, created, settled };
}

/** Simula una conversación y devuelve cada turno para revisar paso a paso. */
async function chat(deps: BotDeps, turns: Array<string | { message?: string; location?: { lat: number; lng: number }; senderName?: string }>, phone = "+593987654321") {
  let state = createInitialState(phone);
  const results: TurnResult[] = [];
  for (const turn of turns) {
    const input = typeof turn === "string" ? { message: turn } : { message: turn.message || "", location: turn.location, senderName: turn.senderName };
    const result = await handleTurn(state, input, deps);
    if (process.env.VERBOSE) console.log(`\n👤 ${input.message || "[ubicación]"}\n🤖 (${result.decision} → ${result.step})\n${result.reply}`);
    state = result.state;
    results.push(result);
  }
  return { results, state, last: results[results.length - 1] };
}

const tests: Array<[string, () => Promise<void>]> = [];
const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);

// ─── Buscador ────────────────────────────────────────────────────────────────

test("buscador: nombre completo entra directo, aunque venga en plural y con tildes", async () => {
  const result = rankProducts("2 bolones mixtos de verde", MENU);
  assert.equal(result.kind, "exact");
  assert.equal(result.kind === "exact" && result.product.name, "BOLON MIXTO VERDE");
  const tigrillo = rankProducts("tigrillo mixto maduro", MENU);
  assert.equal(tigrillo.kind === "exact" && tigrillo.product.name, "TIGRILLO MADURO MIXTO");
});

test("buscador: 'bolón de queso' pregunta verde / maduro / pintón (no adivina)", async () => {
  const result = rankProducts("bolón de queso", MENU);
  assert.equal(result.kind, "ambiguous");
  const names = result.kind === "ambiguous" ? result.options.map((o) => o.name) : [];
  assert.ok(names.includes("BOLON QUESO VERDE") && names.includes("BOLON MADURO QUESO") && names.includes("BOLON PINTON DE QUESO"));
  assert.ok(!names.some((name) => /AGRANDAR|COMBO|CONGELADO|UBER/.test(name)), `no debe ofrecer variantes: ${names.join(" | ")}`);
});

test("buscador: tolera errores de tipeo ('chicharon', 'capuchino')", async () => {
  assert.equal(rankProducts("bolon de chicharon", MENU).kind, "ambiguous");
  const capuccino = rankProducts("capuchino", MENU);
  assert.equal(capuccino.kind === "exact" && capuccino.product.name, "CAPUCCINO");
});

test("buscador: 'café' no ofrece combos de Uber", async () => {
  const result = rankProducts("cafe", MENU);
  const names = result.kind === "ambiguous" ? result.options.map((o) => o.name) : [];
  assert.ok(!names.some((name) => /UBER/.test(name)), names.join(" | "));
});

test("buscador: 'algo de tomar' ofrece bebidas por categoría", async () => {
  const result = rankProducts("algo de tomar", MENU);
  assert.equal(result.kind, "ambiguous");
  assert.ok(result.kind === "ambiguous" && result.options.every((o) => /BEBIDAS/.test(MENU.find((p) => p.productId === o.productId)!.categoryNames[0])));
});

test("buscador: una variante única se confirma, no se agrega sola", async () => {
  // En el menú de prueba 'mini bolón' solo existe como combo.
  assert.equal(rankProducts("mini bolon", MENU).kind, "ambiguous");
});

test("partir el mensaje en productos con cantidades", async () => {
  assert.deepEqual(splitItemPhrases("quiero 2 bolones mixtos de verde y un café americano, 3 humitas"), [
    { query: "bolones mixtos de verde", quantity: 2 },
    { query: "cafe americano", quantity: 1 },
    { query: "humitas", quantity: 3 },
  ]);
});

// ─── Conversaciones completas ────────────────────────────────────────────────

test("pedido completo: delivery + efectivo, con elección de café y aviso de deuda", async () => {
  const { deps, created } = fakeDeps();
  const { results, state } = await chat(deps, [
    "hola",
    "quiero 2 bolones mixtos de verde y un café americano",
    "2",
    "delivery",
    { location: { lat: -2.15, lng: -79.9 } },
    "Av. Las Monjas 123, casa verde junto al parque",
    "Ana Pérez",
    "ana@test.com",
    "efectivo",
    "confirmo",
    "confirmo",
  ]);
  const [hola, pide, elige, entrega, ubicacion, direccion, nombre, correo, pago, confirmo, confirmoOtraVez] = results;

  assert.equal(hola.step, "idle");
  assert.doesNotMatch(hola.reply, /no tenemos/i, "un saludo no se busca como producto");
  assert.match(pide.reply, /Agregué 2 x Bolon Mixto Verde/);
  assert.equal(pide.step, "choosing", "café americano tiene 2 opciones: debe preguntar");
  assert.match(pide.reply, /1\. Cafe Americano Maquina/);
  assert.match(elige.reply, /Agregué 1 x Cafe Americano Pasado/);
  assert.equal(elige.step, "delivery_type");
  assert.equal(entrega.step, "location");
  assert.match(ubicacion.reply, /sucursal Urdesa/);
  assert.equal(ubicacion.step, "address");
  assert.equal(direccion.step, "name", "la dirección no debe buscarse como producto");
  assert.equal(nombre.step, "email");
  assert.equal(correo.step, "payment");
  assert.equal(pago.step, "confirm");
  assert.match(pago.reply, /Resumen de tu pedido/);
  assert.match(pago.reply, /se sumará a tu próxima compra/, "efectivo + delivery muestra el aviso");
  assert.doesNotMatch(pago.reply, /\n\n\n/, "el resumen no tiene líneas en blanco dobles");
  assert.match(pago.reply, /Subtotal \$12\.72\nDelivery \$2\.50\n\*Total \$15\.22\*/);
  assert.equal(confirmo.decision, "R7:orden_creada");
  assert.match(confirmo.reply, /ORD-00991/);
  assert.equal(confirmoOtraVez.decision, "R7:ya_confirmado", "un segundo confirmo no crea otra orden");
  assert.equal(created.length, 1);
  assert.equal(created[0].deliveryAddress, "Av. Las Monjas 123, casa verde junto al parque");
  assert.deepEqual(
    created[0].cart.map((item) => [item.name, item.quantity]),
    [["BOLON MIXTO VERDE", 2], ["CAFE AMERICANO PASADO", 1]]
  );
  assert.equal(state.stage, "ordered");
});

test("repetir lo de la última vez + retiro en local + tarjeta", async () => {
  const lastOrder: LastOrder = {
    orderNumber: "ORD-00120",
    createdAt: new Date("2026-09-01"),
    items: [
      { productId: byName("TIGRILLO MIXTO VERDE").productId, name: "TIGRILLO MIXTO VERDE", quantity: 1 },
      { productId: byName("CAPUCCINO").productId, name: "CAPUCCINO", quantity: 2 },
    ],
    customerName: "Luis Mora",
    customerEmail: "luis@test.com",
    deliveryType: "pickup",
  };
  const { deps, created } = fakeDeps({ lastOrder });
  const { results } = await chat(deps, ["buenos días", "sí", "retiro en el local", "2", "tarjeta", "confirmo"]);
  const [saludo, si, retiro, local, tarjeta, confirmo] = results;

  assert.match(saludo.reply, /Hola Luis/);
  assert.match(saludo.reply, /Tu último pedido \(ORD-00120\)/);
  assert.match(si.reply, /1 x Tigrillo Mixto Verde\n2 x Capuccino/);
  assert.equal(si.step, "delivery_type");
  assert.equal(retiro.step, "choosing", "debe listar los locales");
  assert.match(local.reply, /Lo retiras en Samborondón/);
  assert.equal(local.step, "payment", "nombre y correo vienen del pedido anterior");
  assert.match(tarjeta.reply, /Retiro en: Samborondón/);
  assert.doesNotMatch(tarjeta.reply, /próxima compra/, "sin aviso de deuda en retiro");
  assert.match(confirmo.reply, /https:\/\/boloncity\.com\/pago/);
  assert.equal(created[0].paymentMethod, "card");
  assert.equal(created[0].branchId, "b-samborondon");
});

test("'lo mismo de la última vez' a mitad de la conversación", async () => {
  const lastOrder: LastOrder = {
    orderNumber: "ORD-00050",
    createdAt: new Date(),
    items: [{ productId: byName("HUMITA").productId, name: "HUMITA", quantity: 3 }],
  };
  const { deps } = fakeDeps({ lastOrder });
  // El saludo ya ofrece repetir; el cliente dice que no, pide un producto y después cambia de idea.
  const { results, state } = await chat(deps, ["hola", "no", "una tostada mixta", "mejor lo mismo de la última vez", "sí"]);
  assert.equal(results[1].decision, "R4:eleccion_repetir_no");
  assert.equal(results[3].decision, "R5:repetir_pedido");
  assert.deepEqual(state.cart.map((item) => [item.name, item.quantity]), [["TOSTADA MIXTA", 1], ["HUMITA", 3]]);
});

test("editar el carrito: quitar, cambiar cantidad y ver resumen", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["una humita, un corviche y una tostada mixta", "quita el corviche", "que sean 3 humitas", "qué llevo"]);
  assert.match(results[1].reply, /Quité Corviche/);
  assert.match(results[2].reply, /Ahora son 3 x Humita/);
  // La vista del carrito ahora trae precios y total ("¿cuánto es todo?" preguntaba justo eso).
  assert.match(results[3].reply, /3 x Humita \$[\d.]+\n1 x Tostada Mixta \$[\d.]+/);
  assert.match(results[3].reply, /\*Total \$[\d.]+\*/);
  assert.deepEqual(state.cart.map((item) => item.name), ["HUMITA", "TOSTADA MIXTA"]);
});

// ─── Elegir hablando normal (queja del dueño, 2026-09-22) ────────────────────

/** La lista que el bot muestra para "un bolón de queso": verde, maduro, pintón, crunch. */
const ELECCIONES_NATURALES: Array<[string, string]> = [
  // La frase EXACTA de la queja: el bot repetía la lista en vez de entender "verde".
  ["boon de queso verde porf avor, me encantaria", "BOLON QUESO VERDE"],
  ["el verde", "BOLON QUESO VERDE"],
  ["verde porfa", "BOLON QUESO VERDE"],
  ["quiero el maduro", "BOLON MADURO QUESO"],
  ["prefiero el maduro porfa", "BOLON MADURO QUESO"],
  ["dame el crunch", "BOLON CRUNCH VERDE QUESO"],
  ["mejor el crunch", "BOLON CRUNCH VERDE QUESO"],
  ["el pinton", "BOLON PINTON DE QUESO"],
  ["el pintón porfa, gracias", "BOLON PINTON DE QUESO"],
  ["el verde pero que sea grande", "BOLON QUESO VERDE"],
  // Diminutivos y muletillas mal escritas: el bot repetía la lista IDÉNTICA (queja del dueño).
  ["el madurito porfa", "BOLON MADURO QUESO"],
  ["kero el maduro", "BOLON MADURO QUESO"],
  ["el verdecito", "BOLON QUESO VERDE"],
  ["dame el crunchcito nomás", "BOLON CRUNCH VERDE QUESO"],
  ["el primero", "BOLON QUESO VERDE"],
  ["la segunda opción", "BOLON MADURO QUESO"],
  ["el último", "BOLON CRUNCH VERDE QUESO"],
  // Los números siguen funcionando para quien sí quiere responder con el número.
  ["2", "BOLON MADURO QUESO"],
  ["la 2", "BOLON MADURO QUESO"],
  ["opción 2", "BOLON MADURO QUESO"],
  ["#2", "BOLON MADURO QUESO"],
];

test("elección: el cliente responde hablando normal y se entiende (queja 2026-09-22)", async () => {
  for (const [mensaje, esperado] of ELECCIONES_NATURALES) {
    const { deps } = fakeDeps();
    const { results, state } = await chat(deps, ["un bolón de queso", mensaje]);
    assert.match(results[0].reply, /¿Cuál bolon de queso quieres/);
    assert.deepEqual(
      state.cart.map((item) => item.name),
      [esperado],
      `"${mensaje}" debía agregar ${esperado} y agregó [${state.cart.map((item) => item.name).join(", ")}] · ${results[1].reply.slice(0, 120)}`
    );
  }
});

test("elección: ninguna pregunta le pide al cliente responder con el número", async () => {
  const { deps } = fakeDeps({ lastOrder: { orderNumber: "ORD-00777", createdAt: new Date(), items: [{ productId: byName("HUMITA").productId, name: "HUMITA", quantity: 1 }] } });
  const { results } = await chat(deps, ["hola", "no", "un bolón de queso", "el verde", "para llevar", "urdesa"]);
  for (const result of results) {
    assert.doesNotMatch(result.reply, /con el número/i, `sigue pidiendo el número: ${result.reply.slice(0, 120)}`);
    assert.doesNotMatch(result.reply, /Respóndeme con/i, `sigue sonando a formulario: ${result.reply.slice(0, 120)}`);
  }
  // La lista numerada se queda: ayuda a quien sí quiere responder con el número.
  assert.match(results[2].reply, /1\. Bolon Queso Verde/);
  assert.match(results[2].reply, /Dime cuál prefieres/);
});

test("elección: si sigue ambiguo se repregunta SOLO con lo que las diferencia", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["un bolón de queso", "el de queso", "el maduro"]);
  const repregunta = results[1].reply;
  assert.match(repregunta, /parecidas/i, "debe repreguntar, no agregar a ciegas");
  assert.doesNotMatch(repregunta, /Bolon Queso Verde/, "no repite el nombre completo, solo lo que las diferencia");
  assert.match(repregunta, /1\. Verde/);
  assert.equal(results[1].step, "choosing");
  assert.deepEqual(state.cart.map((item) => item.name), ["BOLON MADURO QUESO"]);
});

test("elección: 'los dos' y 'uno de cada uno' agregan todas las opciones mostradas", async () => {
  const dos = fakeDeps();
  const { state } = await chat(dos.deps, ["una coca cola", "los dos porfa"]);
  assert.deepEqual(state.cart.map((item) => item.name), ["COCA COLA ORIGINAL", "COCA COLA ZERO"]);
  const cada = fakeDeps();
  const { state: state2 } = await chat(cada.deps, ["una coca cola", "uno de cada uno"]);
  assert.equal(state2.cart.length, 2);
});

test("ADV-NEG-1: 'el verde no' / 'el que no sea maduro' NUNCA agregan lo que el cliente rechazó", async () => {
  const bolones = ["BOLON QUESO VERDE", "BOLON MADURO QUESO", "BOLON PINTON DE QUESO", "BOLON CRUNCH VERDE QUESO"];
  const opciones = bolones.map((name) => ({ name, price: byName(name).price }));
  const verde = pickChoice("el verde no", opciones);
  assert.equal(verde.kind, "several", `'el verde no' no debe elegir una a ciegas: ${JSON.stringify(verde)}`);
  assert.equal(verde.kind === "several" && verde.options.some((option) => /VERDE/.test(option.name)), false, "no puede quedar ninguna verde");
  const maduro = pickChoice("el que no sea maduro", opciones);
  assert.equal(maduro.kind === "several" && maduro.options.some((option) => /MADURO/.test(option.name)), false);

  // Y en conversación: el carrito jamás termina con lo negado.
  for (const [mensaje, rechazado] of [["el verde no", /VERDE/], ["el que no sea maduro", /MADURO/], ["cualquiera menos el pinton", /PINTON/], ["no quiero el maduro", /MADURO/]] as const) {
    const { deps } = fakeDeps();
    const { results, state } = await chat(deps, ["un bolón de queso", mensaje]);
    assert.equal(state.cart.some((item) => rechazado.test(item.name)), false, `"${mensaje}" agregó lo que el cliente descartó: ${state.cart.map((i) => i.name).join(", ")}`);
    assert.notEqual(results[1].reply, results[0].reply, `"${mensaje}" repite el mismo mensaje palabra por palabra`);
  }
  // Una bebida: "la zero no" tampoco agrega la zero.
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una coca cola", "la zero no"]);
  assert.equal(state.cart.some((item) => /ZERO/.test(item.name)), false);
});

test("ADV-NEG-2: 'urdesa no' descarta ese local en vez de fijarlo para el retiro", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["una humita", "yo paso a retirarlo", "urdesa no"]);
  assert.notEqual(state.branchId, "b-urdesa", `fijó justo el local que el cliente descartó: ${results[2].reply.slice(0, 140)}`);
  assert.doesNotMatch(results[2].reply, /Lo retiras en Urdesa/);
  assert.match(results[2].reply, /descartamos|Samborond/i, `debe seguir preguntando con los que quedan: ${results[2].reply.slice(0, 140)}`);
});

test("F1: 'cualquiera está bien' elige una y lo dice, en vez de repetir la lista", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["un bolón de queso", "cualquiera esta bien"]);
  assert.equal(state.cart.length, 1, `debía elegir una: ${results[1].reply.slice(0, 140)}`);
  assert.match(results[1].reply, /Agregué 1 x Bolon/);
});

test("F1: el bot NUNCA repite la misma lista palabra por palabra (queja del dueño)", async () => {
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["un bolón de queso", "mmm no se jaja", "eeeh"]);
  assert.notEqual(results[1].reply, results[0].reply, "repitió la lista idéntica");
  assert.notEqual(results[2].reply, results[1].reply, "repitió la lista idéntica en el segundo intento");
  assert.match(results[1].reply, /Perdona/);
});

test("F3: 'quita uno de los bolones, con uno basta' baja de 2 a 1 (no borra los dos)", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["2 humitas y un café con leche", "quita uno de los humitas, con uno basta", "qué llevo"]);
  const humita = state.cart.find((item) => item.name === "HUMITA");
  assert.equal(humita?.quantity, 1, `debía quedar 1 humita y quedó ${humita?.quantity ?? 0} · ${results[1].reply.slice(0, 140)}`);
  assert.match(results[2].reply, /1 x Humita/);
});

test("F2/F4: pedir un producto con una pregunta abierta lo agrega EN EL MISMO TURNO", async () => {
  // F2: quitar y agregar en el mismo mensaje, con la pregunta del café todavía abierta.
  const dos = fakeDeps();
  const { results, state } = await chat(dos.deps, [
    "quisiera un bolón de queso y un café",
    "prefiero el crunch",
    "ay no, mejor quita el bolon crunch y ponme el de queso verde",
    "qué llevo",
  ]);
  assert.match(results[2].reply, /Quité Bolon Crunch Verde Queso/);
  // En el MISMO turno reconoce lo que le pidieron: o lo agrega, o dice que lo anotó (nunca lo calla).
  assert.match(results[2].reply, /Agregué 1 x Bolon Queso Verde|Anotado lo de "el de queso verde"/, `no reconoció el pedido: ${results[2].reply.slice(0, 200)}`);
  // Y "qué llevo" no puede decir "está vacío" cuando hay algo a medias.
  assert.doesNotMatch(results[3].reply, /carrito está vacío/, `le dice al cliente que perdió todo: ${results[3].reply.slice(0, 200)}`);
  assert.match(results[3].reply, /Bolon Queso Verde|queso verde/i);

  // Con la extracción de Gemini el producto llega completo ("bolon de queso verde") y se agrega en el turno.
  const conIa = fakeDeps({ extract: async (message, context) => ({ ...(await heuristicExtract(message, context)), items: [{ query: "bolon de queso verde", quantity: 1 }], remove: ["bolon crunch"], source: "ai" as const }) });
  const { results: rIa, state: sIa } = await chat(conIa.deps, ["quisiera un bolón de queso", "prefiero el crunch", "un café", "ay no, mejor quita el bolon crunch y ponme el de queso verde"]);
  assert.match(rIa[3].reply, /Agregué 1 x Bolon Queso Verde/, `el producto exacto debía entrar en el turno: ${rIa[3].reply.slice(0, 200)}`);
  assert.deepEqual(sIa.cart.map((item) => item.name), ["BOLON QUESO VERDE"]);

  // F4: con la pregunta del local abierta, el pedido se reconoce en vez de repetir los locales tal cual.
  const cuatro = fakeDeps();
  const { results: r4, state: s4 } = await chat(cuatro.deps, ["una humita", "yo paso a retirarlo", "ah y agregame otra vez la humita porfa"]);
  assert.match(r4[2].reply, /Agregué|Ahora son|Anotado/, `ignoró el pedido y repitió la lista: ${r4[2].reply.slice(0, 200)}`);
  assert.equal(s4.cart.find((item) => item.name === "HUMITA")?.quantity, 2);
});

test("elección: nombrar otro producto no se fuerza a la lista mostrada", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["un bolón de queso", "mejor un tigrillo mixto verde"]);
  assert.equal(state.cart.some((item) => /BOLON/.test(item.name)), false, "no debe elegir un bolón que el cliente no eligió");
  assert.match(results[1].reply, /Tigrillo Mixto Verde/, `debía pasar al producto nuevo: ${results[1].reply.slice(0, 160)}`);
});

test("elección de local: 'el de urdesa' / 'el más cercano' se entienden sin números", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["una humita", "paso por ahí mejor", "el más cercano", "el de urdesa"]);
  assert.equal(results[1].step, "choosing", "retiro pide el local");
  assert.match(results[2].reply, /ubicación|sector/i, "'el más cercano' no se puede adivinar: se pide la ubicación o el sector");
  assert.equal(state.branchId, "b-urdesa");
});

test("conversación completa hablando como persona: delivery, sin usar un número", async () => {
  const { deps, created } = fakeDeps();
  const { results, state } = await chat(deps, [
    "buenas, quiero un bolón de queso",
    "boon de queso verde porf avor, me encantaria",
    "me lo mandan a la casa porfa",
    { location: { lat: -2.15, lng: -79.9 } },
    "Av. Las Monjas 123, casa verde junto al parque",
    "Ana Pérez",
    "ana@test.com",
    "con tarjeta",
    "confirmo",
  ]);
  assert.deepEqual(state.cart.map((item) => item.name), ["BOLON QUESO VERDE"]);
  assert.equal(created.length, 1);
  assert.equal(created[0].deliveryType, "delivery");
  assert.equal(created[0].paymentMethod, "card");
  assert.match(results[results.length - 1].reply, /ORD-0099/);
});

test("el nombre dicho hablando ('me llamo Diego Reyes') no queda como 'Me Llamo Diego'", async () => {
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, [
    "una humita",
    "me lo mandan a la casa",
    { location: { lat: -2.15, lng: -79.9 } },
    "Av. Las Monjas 123, casa verde",
    "me llamo Diego Reyes",
    "diego@test.com",
    "con tarjeta",
    "confirmo",
  ]);
  assert.equal(state.customerName, "Diego Reyes");
  assert.equal(created[0].customerName, "Diego Reyes");
});

test("conversación completa hablando como persona: retiro, sin usar un número", async () => {
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, [
    "hola, quiero un tigrillo mixto verde",
    "yo paso por ahí a recogerlo",
    "el de samborondón",
    "Luis Mora",
    "luis@test.com",
    "pago en efectivo cuando llegue",
    "dale confirmo",
  ]);
  assert.equal(created.length, 1);
  assert.equal(created[0].deliveryType, "pickup");
  assert.equal(created[0].branchId, "b-samborondon");
  assert.equal(created[0].paymentMethod, "cash");
  assert.equal(state.stage, "ordered");
});

test("otras preguntas con opciones se contestan hablando: repetir pedido y misma dirección", async () => {
  const lastOrder: LastOrder = {
    orderNumber: "ORD-00321",
    createdAt: new Date(),
    items: [{ productId: byName("HUMITA").productId, name: "HUMITA", quantity: 2 }],
    customerName: "Ana Pérez",
    customerEmail: "ana@test.com",
    deliveryType: "delivery",
    deliveryAddress: "Av. Las Monjas 123",
    deliveryCoordinates: { lat: -2.15, lng: -79.9 },
  };
  const { deps } = fakeDeps({ lastOrder });
  const { results, state } = await chat(deps, ["hola", "dale repite lo mismo", "me lo mandan a domicilio", "la misma de siempre"]);
  assert.match(results[1].reply, /2 x Humita/);
  assert.match(results[3].reply, /sucursal Urdesa/);
  assert.equal(state.deliveryAddress, "Av. Las Monjas 123");
});

test("formas de decir delivery, retiro y pago que usa la gente", async () => {
  const entregas: Array<[string, "delivery" | "pickup"]> = [
    ["a domicilio", "delivery"],
    ["me lo mandan", "delivery"],
    ["que me lo traigan a la casa", "delivery"],
    ["para llevar", "pickup"],
    ["paso por ahí", "pickup"],
    ["yo lo recojo", "pickup"],
    ["me acerco al local", "pickup"],
  ];
  for (const [mensaje, esperado] of entregas) {
    const { deps } = fakeDeps();
    const { state } = await chat(deps, ["una humita", mensaje]);
    assert.equal(state.deliveryType, esperado, `"${mensaje}" debía ser ${esperado}`);
  }
  const pagos: Array<[string, "card" | "cash"]> = [
    ["con tarjeta", "card"],
    ["mándame el link de pago", "card"],
    ["efectivo", "cash"],
    ["le pago al motorizado", "cash"],
    ["en efectivo cuando llegue", "cash"],
  ];
  for (const [mensaje, esperado] of pagos) {
    const { deps } = fakeDeps();
    const { state } = await chat(deps, ["una humita", "a domicilio", { location: { lat: -2.15, lng: -79.9 } }, "Av. Las Monjas 123, casa verde", "Ana Pérez", "ana@test.com", mensaje]);
    assert.equal(state.paymentMethod, esperado, `"${mensaje}" debía ser ${esperado}`);
  }
  // La transferencia sigue rechazándose.
  const { deps } = fakeDeps();
  const { last } = await chat(deps, ["una humita", "te hago una transferencia"]);
  assert.match(last.reply, /no recibimos transferencias/);
});

test("varias ambigüedades en un mensaje: pregunta una por una sin perder productos", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["un bolón de queso y una coca cola", "maduro", "zero"]);
  assert.match(results[0].reply, /¿Cuál bolon de queso quieres/);
  assert.match(results[1].reply, /Agregué 1 x Bolon Maduro Queso/);
  assert.match(results[1].reply, /¿Cuál coca cola quieres/);
  assert.deepEqual(state.cart.map((item) => item.name), ["BOLON MADURO QUESO", "COCA COLA ZERO"]);
});

test("transferencia: se rechaza y se ofrecen tarjeta o efectivo", async () => {
  const { deps } = fakeDeps();
  const { last, state } = await chat(deps, ["una humita", "1", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy", "Ana", "ana@test.com", "pago por transferencia"]);
  assert.match(last.reply, /no recibimos transferencias/);
  assert.equal(state.paymentMethod, undefined);
  assert.equal(last.step, "payment");
});

test("fuera de cobertura: ofrece retiro en el local", async () => {
  const { deps } = fakeDeps({ covered: false });
  const { last, state } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.5, lng: -80.5 } }]);
  assert.match(last.reply, /lo puedes retirar en el local/);
  assert.equal(state.deliveryType, undefined);
});

test("sucursal cerrada: no se crea la orden, se ofrece programar", async () => {
  const { deps, created } = fakeDeps({ closed: true });
  const { results, last } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo", "confirmo"]);
  assert.match(results[2].reply, /cerrad[ao]/, "al elegir el local avisa que está cerrado");
  // "confirmo" con el local cerrado acepta lo único ofrecido (programar) y sigue pidiendo los datos.
  assert.match(last.reply, /queda programado para/i, last.reply);
  assert.equal(created.length, 0, "todavía no se crea la orden");
});

test("producto no disponible en la sucursal: se quita al fijar la sucursal", async () => {
  const { deps } = fakeDeps({ unavailableAtBranch: ["CORVICHE"] });
  const { results, state } = await chat(deps, ["un corviche y una humita", "delivery", { location: { lat: -2.15, lng: -79.9 } }]);
  assert.match(results[2].reply, /no hay disponible: Corviche/);
  assert.deepEqual(state.cart.map((item) => item.name), ["HUMITA"]);
});

test("menú: categorías, y 'bebidas' muestra opciones elegibles", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["menú", "qué bebidas tienen", "1"]);
  assert.match(results[0].reply, /esto es lo que tenemos/);
  assert.equal(results[1].step, "choosing");
  assert.equal(state.cart.length, 1);
});

test("consultar pedido y pedir humano van por su propia ruta", async () => {
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["dónde está mi pedido", "quiero hablar con un asesor"]);
  assert.equal(results[0].route, "tracking");
  assert.equal(results[0].intent, "consultar_pedido");
  assert.equal(results[1].route, "human");
  assert.equal(results[1].intent, "dudas");
  assert.match(results[1].reply, /\+593 99 315 7333/);
});

test("intención para las Rules de BuilderBot en cada situación", async () => {
  const { deps } = fakeDeps();
  const pedido = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo", "confirmo"]);
  assert.equal(pedido.results[0].intent, "conversar");
  assert.equal(pedido.last.intent, "orden_creada");
  const menu = await chat(deps, ["menú"]);
  assert.equal(menu.last.intent, "menu");
});

test("router de la Bienvenida: cada mensaje va al flow correcto", async () => {
  const nuevo = null;
  assert.equal(classifyRoute(nuevo, "hola"), "conversation");
  assert.equal(classifyRoute(nuevo, "2 bolones mixtos"), "conversation");
  assert.equal(classifyRoute(nuevo, "menú"), "catalog");
  assert.equal(classifyRoute(nuevo, "qué bebidas tienen"), "catalog");
  assert.equal(classifyRoute(nuevo, "dónde está mi pedido"), "search_order");
  assert.equal(classifyRoute(nuevo, "quiero hablar con un asesor"), "human");
  assert.equal(classifyRoute(nuevo, "tengo un reclamo"), "human");
  assert.equal(classifyRoute(nuevo, "", true), "conversation", "ubicación");

  const pagando = { ...createInitialState("+593987654321"), stage: "payment" as const };
  assert.equal(classifyRoute(pagando, "quiero pagar con tarjeta"), "conversation", "antes del resumen, pagar es un dato del pedido");
  assert.equal(classifyRoute(pagando, "confirmo"), "conversation");

  const resumen = { ...createInitialState("+593987654321"), stage: "confirm" as const };
  assert.equal(classifyRoute(resumen, "confirmo"), "checkout");
  assert.equal(classifyRoute(resumen, "sí"), "checkout");
  assert.equal(classifyRoute(resumen, "mejor quita el café"), "conversation");

  const eligiendo = { ...createInitialState("+593987654321"), stage: "choosing" as const, pendingChoice: { kind: "product" as const, query: "cafe", quantity: 1, options: [] } };
  assert.equal(classifyRoute(eligiendo, "2"), "conversation", "responder una opción no es ir al menú");
});

test("router y conversación coinciden: lo que el router manda a checkout, la conversación lo confirma", async () => {
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo"]);
  assert.equal(classifyRoute(state, "confirmo"), "checkout");
  const result = await handleTurn(state, { message: "confirmo" }, deps);
  assert.equal(result.decision, "R7:orden_creada");
  assert.equal(created.length, 1);
});

test("mensajes que no se entienden NO derivan a una persona: el bot sigue ofreciendo ayuda", async () => {
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["asdfgh", "¿ustedes hacen catering para 200 personas?", "qwerty", "zxcvb"]);
  for (const result of results) {
    assert.equal(result.intent, "conversar", result.reply);
    assert.notEqual(result.route, "human", result.reply);
    assert.doesNotMatch(result.reply, /\+593 99 315 7333/, "solo un reclamo pasa a soporte");
  }
  // Una pregunta que el bot no puede responder se contesta sin derivar a nadie.
  assert.equal(results[1].decision, "R11:fuera_de_alcance");
  assert.match(results[1].reply, /no tengo info/i);
  // Y los mensajes ininteligibles siguen ofreciendo ayuda concreta.
  assert.equal(results[3].decision, "R11:ayuda");
  assert.match(results[3].reply, /men\u00fa/);
});

test("querer comprar nunca deriva a una persona; un reclamo sí", async () => {
  for (const text of [
    "hola quisiera comprar",
    "quiero comprar",
    "quiero hacer un pedido",
    "necesito ayuda para pedir",
    "me ayudas con un pedido",
    "quiero ordenar 2 bolones",
    "human",
  ]) {
    assert.ok(!wantsHuman(text), text);
  }
  for (const text of [
    "quiero hablar con una persona",
    "pasame un asesor",
    "tengo un reclamo",
    "el pedido llegó frío",
    "no llegó mi pedido",
    "quiero un reembolso",
    "atencion al cliente",
  ]) {
    assert.ok(wantsHuman(text), text);
  }
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["hola quisiera comprar"]);
  assert.notEqual(results[0].route, "human");
  assert.equal(classifyRoute(createInitialState("+593999"), "hola quisiera comprar"), "conversation");
});

test("después de crear la orden, un mensaje nuevo arranca otro pedido conservando los datos", async () => {
  const { deps } = fakeDeps();
  const { state, last } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo", "confirmo", "quiero un corviche"]);
  assert.deepEqual(state.cart.map((item) => item.name), ["CORVICHE"]);
  assert.equal(state.customerEmail, "ana@test.com");
  assert.equal(last.step, "delivery_type");
});

// ─── Regresiones de las pruebas en vivo (QA 2026-09-22) ─────────────────────

test("resumen: 'sí, pero agrégale una humita' aplica el cambio y NO crea la orden", async () => {
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, ["una tostada mixta", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  assert.equal(classifyRoute(state, "si, pero agregale una humita"), "conversation", "no va al flow de checkout");
  assert.equal(classifyRoute(state, "sí, confirmo porfa"), "checkout");
  const result = await handleTurn(state, { message: "si, pero agregale una humita" }, deps);
  assert.equal(created.length, 0);
  assert.equal(result.step, "confirm", "vuelve a mostrar el resumen");
  assert.deepEqual(result.state.cart.map((item) => item.name), ["TOSTADA MIXTA", "HUMITA"]);
  const confirmo = await handleTurn(result.state, { message: "ok dale" }, deps);
  assert.equal(confirmo.decision, "R7:orden_creada");
});

test("saludos y cortesías no derivan a soporte", async () => {
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["hola", "buenas tardes, cómo están?", "😀😀", "gracias"]);
  assert.ok(results.every((result) => result.intent !== "dudas"), results.map((r) => r.decision).join(", "));
  assert.equal(results[0].decision, "R10:saludo");
  assert.match(results[0].reply, /Hola/);
  assert.equal(results[3].state.misunderstood || 0, 0);
});

test("dirección: si la IA la pone en notes, igual queda como dirección de entrega", async () => {
  const addressAsNotes: Extractor = async (message, context) =>
    context.lastBotQuestion.includes("dirección") ? { items: [], remove: [], setQuantity: [], notes: message, source: "ai" } : heuristicExtract(message, context);
  const { deps } = fakeDeps({ extract: addressAsNotes });
  const { state, last } = await chat(deps, ["2 humitas a domicilio", { location: { lat: -2.16, lng: -79.89 } }, "Av. San Jorge 123, edificio azul piso 2"]);
  assert.equal(state.deliveryAddress, "Av. San Jorge 123, edificio azul piso 2");
  assert.equal(state.notes, undefined, "la dirección no va a Indicaciones");
  assert.equal(last.step, "name");
});

test("efectivo en delivery: el resumen usa la tarifa de efectivo (la que se cobra)", async () => {
  const { deps } = fakeDeps({ cashFee: 1.9 });
  const { state, last } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "Ana", "ana@test.com", "2"]);
  assert.equal(state.deliveryFee, 1.9);
  assert.match(last.reply, /Delivery \$1\.90/);
});

test("ubicación mientras se elige local: sirve para elegir el MÁS CERCANO, no para cambiar a delivery", async () => {
  const { deps } = fakeDeps();
  const { state, results } = await chat(deps, ["una humita", "retiro", { location: { lat: -2.15, lng: -79.89 } }]);
  assert.equal(state.deliveryType, "pickup", "el cliente ya había dicho retiro");
  assert.equal(results[2].decision, "R1:local_mas_cercano");
  assert.match(results[2].reply, /más cerca es/i, results[2].reply);
  assert.ok(state.branchId, "queda elegido un local");
  // Y si en realidad quería delivery, lo dice y se cambia.
  const cambio = await handleTurn(state, { message: "mejor delivery" }, deps);
  assert.equal(cambio.state.deliveryType, "delivery");
});

test("el local nombrado en el mensaje se toma directo (sin lista ni producto fantasma)", async () => {
  const { deps } = fakeDeps();
  const { state, last } = await chat(deps, ["hola, quiero una humita para retirar en Boloncity Samborondón"]);
  assert.equal(state.branchId, "b-samborondon");
  assert.doesNotMatch(last.reply, /¿En qué local/);
  assert.doesNotMatch(last.reply, /samborond[oó]n" tal cual|No tenemos/i);
  const lista = await chat(deps, ["una humita", "retiro", "retiro en Boloncity Samborondón"]);
  assert.equal(lista.state.branchId, "b-samborondon");
});

test("después de la orden: 'gracias', '👍' y 'el link no me abre' no borran el pedido ni el link", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "confirmo"]);
  const gracias = await handleTurn(state, { message: "gracias" }, deps);
  assert.equal(gracias.step, "ordered");
  assert.match(gracias.reply, /ORD-00991/);
  const pulgar = await handleTurn(gracias.state, { message: "👍" }, deps);
  assert.notEqual(pulgar.intent, "dudas");
  const link = await handleTurn(pulgar.state, { message: "el link no me abre" }, deps);
  assert.match(link.reply, /https:\/\/boloncity\.com\/pago/);
  assert.equal(link.paymentLink, state.lastPaymentLink);
  const efectivo = await handleTurn(link.state, { message: "mejor pago en efectivo" }, deps);
  assert.equal(efectivo.state.lastOrderNumber, "ORD-00991");
  assert.match(efectivo.reply, /\+593 99 315 7333/);
});

test("local cerrado en retiro: 'otro local' vuelve a mostrar los locales", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { results, state } = await chat(deps, ["una humita", "retiro", "1", "otro local", "2"]);
  assert.equal(results[2].step, "closed");
  assert.equal(results[3].step, "choosing");
  assert.equal(state.branchId, "b-samborondon");
});

test("cédula con dígito verificador inválido se rechaza", async () => {
  assert.equal(extractDocNumber("0912345678"), "");
  assert.equal(extractDocNumber("0912345675"), "0912345675");
  assert.equal(extractDocNumber("0912345675001"), "0912345675001");
  const { deps } = fakeDeps();
  const { last, state } = await chat(deps, ["una humita con factura", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "0912345678"]);
  assert.equal(state.billingDocNumber, undefined);
  assert.match(last.reply, /no es una cédula o RUC válido/);
});

test("detectores: consulta de pedido, reclamos, saludos y confirmación", async () => {
  assert.equal(extractOrderNumber("orden 17"), "ORD-00017");
  assert.equal(extractOrderNumber("pedido #17"), "ORD-00017");
  assert.equal(extractOrderNumber("17"), "", "un número suelto solo cuenta en 'consultar orden'");
  assert.equal(extractOrderNumber("#17", { allowBare: true }), "ORD-00017");
  assert.equal(extractOrderNumber("mi número es 0991234567", { allowBare: true }), "");
  assert.ok(wantsTracking("orden 17"));
  assert.ok(!wantsTracking("agrega un café americano a mi pedido"), "editar el carrito no es consultar");
  assert.ok(wantsHuman("el pedido llegó frío y feo"));
  assert.ok(!wantsHuman("necesito ayuda"), "pedir ayuda no es un reclamo: casi siempre quiere pedir");
  assert.ok(!wantsHuman("el nombre está mal"), "corregir un dato no es un reclamo");
  assert.ok(isSmallTalk("Buenas tardes!") && isSmallTalk("👍") && !isSmallTalk("hola quiero 2 humitas"));
  assert.ok(isPlainConfirmation("Sí, confirmo porfa") && !isPlainConfirmation("si pero sin cebolla"));
});

test("menú: sin categorías internas y 'menú de jugos' elige JUGOS, no JUGO DE BISTEC", async () => {
  const products: CatalogProduct[] = [
    { productId: "a", name: "JUGO DE BISTEC", price: 1.86, categoryNames: ["JUGO DE BISTEC"], tags: [] },
    { productId: "b", name: "JUGO NARANJA", price: 3, categoryNames: ["JUGOS"], tags: [] },
    { productId: "c", name: "JUGO MORA", price: 3, categoryNames: ["JUGOS"], tags: [] },
    { productId: "d", name: "CAJA", price: 0.5, categoryNames: ["CAJA", "EMPAQUES PARA REGALO"], tags: [] },
    { productId: "e", name: "AGUA", price: 1, categoryNames: ["BEBIDAS-STOCKEABLES", "COCINA"], tags: [] },
  ];
  const names = listCategories(products).map((category) => category.name);
  assert.deepEqual(names, ["JUGO DE BISTEC", "JUGOS"]);
  assert.equal(findCategory("menu de jugos", listCategories(products))?.name, "JUGOS");
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["menú", "bebidas"]);
  assert.equal(results[0].reply.match(/¿Qué te gustaría pedir hoy\?/g), null, "una sola pregunta al final del menú");
  assert.equal(results[1].intent, "menu");
  assert.doesNotMatch(results[1].reply, /¿Cuál BEBIDAS/);
});

test("nombre de perfil: '{name}', '~' o emojis no se usan como nombre del pedido", async () => {
  const { deps } = fakeDeps();
  for (const senderName of ["{name}", "~", "💕✨"]) {
    const { state } = await chat(deps, [{ message: "una humita", senderName }, "retiro", "1"]);
    assert.equal(state.customerName, undefined, senderName);
    assert.equal(state.stage, "name");
  }
  const { state } = await chat(deps, [{ message: "una humita", senderName: "Carla Prueba 🌸" }]);
  assert.equal(state.customerName, "Carla Prueba");
});

test("ubicación ilegible y audios: mensaje claro, sin sumar 'no entendido'", async () => {
  const { deps } = fakeDeps();
  const ubicacion = await handleTurn(createInitialState("+593987654321"), { message: "", locationInvalid: true }, deps);
  assert.equal(ubicacion.decision, "R1:ubicacion_invalida");
  assert.match(ubicacion.reply, /no pude leer esa ubicación/);
  const audio = await handleTurn(createInitialState("+593987654321"), { message: "", unsupportedMedia: true }, deps);
  assert.match(audio.reply, /solo puedo leer mensajes de texto/);
  assert.equal(audio.state.misunderstood || 0, 0);
});

// ─── Regresiones de la verificación adversarial (VR/N, 2026-09-22) ──────────

/** Conversación hasta el resumen (retiro + tarjeta). */
async function atSummary(deps: BotDeps) {
  const { state } = await chat(deps, ["una tostada mixta", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  return state;
}

test("VR-01: en el resumen 'gracias', 'ya', 'por favor', 'hola', 'nada más' NO crean la orden", async () => {
  const { deps, created } = fakeDeps();
  const state = await atSummary(deps);
  for (const message of ["gracias", "ya", "por favor", "hola", "nada mas", "nada más", "🙏"]) {
    assert.equal(classifyRoute(state, message), "conversation", `router: ${message}`);
    const result = await handleTurn(state, { message }, deps);
    assert.equal(created.length, 0, `no crea la orden con "${message}"`);
    assert.equal(result.decision, "R7:cortesia_en_resumen", message);
    assert.equal(result.step, "confirm");
    assert.match(result.reply, /Resumen de tu pedido/);
    assert.match(result.reply, /Escribe \*confirmo\*/);
    assert.equal(result.state.misunderstood || 0, 0, "no suma 'no entendido'");
  }
});

test("VR-02: confirmaciones naturales confirman, y router y conversación coinciden", async () => {
  const confirmations = ["si", "Sí.", "ok", "dale", "listo", "confirmo", "Confirmo el pedido", "confirmo mi pedido", "si esta bien asi", "Así está bien",
    "correcto", "perfecto", "de una", "va", "todo bien", "adelante", "hazlo", "está perfecto", "sí confirmo", "✅", "👍", "ok gracias"];
  for (const message of confirmations) {
    const { deps, created } = fakeDeps();
    const state = await atSummary(deps);
    assert.equal(classifyConfirmReply(message), "confirm", message);
    assert.equal(classifyRoute(state, message), "checkout", `router: ${message}`);
    const result = await handleTurn(state, { message }, deps);
    assert.equal(result.decision, "R7:orden_creada", `conversación: ${message} → ${result.decision}`);
    assert.equal(created.length, 1);
  }
  // Un cambio NO confirma (RB-01): se aplica y se vuelve a mostrar el resumen.
  for (const message of ["si, pero agrégale un café", "mejor sin cebolla", "otro bolón", "en vez de la tostada una humita", "2 humitas más", "no"]) {
    assert.equal(classifyConfirmReply(message), "other", message);
  }
  const { deps, created } = fakeDeps();
  const state = await atSummary(deps);
  assert.equal(classifyRoute(state, "confirmo mi pedido"), "checkout", "en el resumen no es consultar un pedido");
  const cambio = await handleTurn(state, { message: "si, pero agregale una humita" }, deps);
  assert.equal(created.length, 0);
  assert.equal(cambio.step, "confirm");
});

test("RL-03: los 6 cambios de VR-02 pasan por handleTurn y el cambio SE APLICA (sin crear la orden)", async () => {
  // Lo que devolvería la IA para las frases que las reglas no entienden solas.
  const scripted: Record<string, Partial<Awaited<ReturnType<Extractor>>>> = {
    "mejor sin cebolla": { notes: "sin cebolla" },
    "en vez de la tostada una humita": { remove: ["tostada"], items: [{ query: "humita", quantity: 1 }] },
  };
  const extract: Extractor = async (message, context) =>
    scripted[message] ? { items: [], remove: [], setQuantity: [], source: "ai", ...scripted[message] } : heuristicExtract(message, context);
  const { deps, created } = fakeDeps({ extract });
  const state = await atSummary(deps);
  const run = (message: string) => handleTurn(state, { message }, deps);

  const cafe = await run("si, pero agrégale un café");
  assert.equal(cafe.step, "choosing", "pregunta qué café");
  assert.equal(cafe.state.pendingChoice?.kind === "product" && /caf/.test(cafe.state.pendingChoice.query), true);
  const elegido = await handleTurn(cafe.state, { message: "1" }, deps);
  assert.equal(elegido.step, "confirm");
  assert.equal(elegido.state.cart.length, 2, "el café quedó en el pedido");

  const cebolla = await run("mejor sin cebolla");
  assert.equal(cebolla.step, "confirm");
  assert.match(cebolla.reply, /Indicaciones: sin cebolla/);

  const bolon = await run("otro bolón");
  assert.equal(bolon.step, "choosing", "pregunta qué bolón");

  const cambio = await run("en vez de la tostada una humita");
  assert.deepEqual(cambio.state.cart.map((item) => item.name), ["HUMITA"]);
  assert.match(cambio.reply, /Resumen de tu pedido\*\n1 x Humita \$/);

  const mas = await run("2 humitas más");
  assert.deepEqual(mas.state.cart.map((item) => [item.name, item.quantity]), [["TOSTADA MIXTA", 1], ["HUMITA", 2]]);
  assert.equal(mas.step, "confirm");

  const no = await run("no");
  assert.equal(no.step, "confirm");
  assert.deepEqual(no.state.cart, state.cart, "'no' no cambia el pedido");
  assert.notEqual(no.intent, "dudas");
  assert.equal(created.length, 0, "ningún cambio crea la orden");
});

test("VR-03: en el paso de dirección una pregunta no se guarda como dirección", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["2 humitas a domicilio", { location: { lat: -2.16, lng: -79.89 } }]);
  assert.equal(state.stage, "address");
  for (const message of ["cuanto cuesta el envio?", "¿cuánto se demora?", "hacen delivery a Samborondón?", "cuanto se demora"]) {
    assert.ok(isQuestion(message), message);
    assert.equal(classifyRoute(state, message), "conversation", `router: ${message}`);
    const result = await handleTurn(state, { message }, deps);
    assert.equal(result.state.deliveryAddress, undefined, message);
    assert.equal(result.step, "address");
    assert.match(result.reply, /Escríbeme la dirección/);
  }
  const costo = await handleTurn(state, { message: "cuanto cuesta el envio?" }, deps);
  assert.match(costo.reply, /cuesta \$2\.50/);
  for (const address of ["Av. San Jorge 123, edificio azul piso 2", "Urdesa central calle 3ra mz 5 villa 2"]) {
    assert.ok(!isQuestion(address), address);
    const result = await handleTurn(state, { message: address }, deps);
    assert.equal(result.state.deliveryAddress, address);
  }
});

test("VR-04: el mismo '1' que responde OTRA pregunta no es un reintento", async () => {
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["2 tigrillos y una coca cola", "1"]);
  const [antes, despues] = results;
  assert.equal(antes.step, "choosing");
  assert.equal(despues.step, "choosing", "ahora pregunta por la coca cola");
  assert.equal(antes.state.stage, despues.state.stage);
  assert.notEqual(pendingKey(antes.state), pendingKey(despues.state), "misma etapa, distinta pregunta: distinta clave");
  assert.equal(pendingKey(despues.state), pendingKey(JSON.parse(JSON.stringify(despues.state))), "estable tras guardar en Mongo");
});

test("RL-02: VR-04 por la decisión de duplicado de runTurn (sesión guardada → isDuplicateTurn)", async () => {
  // Simula lo que runTurn guarda (turnRecord) y lo que decide al llegar el siguiente mensaje (isDuplicateTurn).
  const { deps } = fakeDeps();
  const start = createInitialState("+593900020001");
  const t0 = 1_000_000;
  const pedido = await handleTurn(start, { message: "2 tigrillos y una coca cola" }, deps);
  let session: any = turnRecord(start, pedido, turnHash("2 tigrillos y una coca cola", null, null), new Date(t0));
  // "1" a "¿cuál tigrillo?" (primer "1": no hay turno anterior igual).
  const hash1 = turnHash("1", null, null);
  assert.equal(isDuplicateTurn(session, hash1, t0 + 1000, t0 + 1000), false);
  const tigrillo = await handleTurn(session.state, { message: "1" }, deps);
  session = turnRecord(session.state, tigrillo, hash1, new Date(t0 + 1500));
  assert.equal(tigrillo.step, "choosing", "ahora pregunta por la coca cola");
  // "1" a "¿cuál coca cola?" 2 s después: mismo texto, OTRA pregunta → no es reintento, se procesa.
  assert.equal(isDuplicateTurn(session, hash1, t0 + 3500, t0 + 3500), false, "otra pregunta: no es un reintento");
  const cola = await handleTurn(session.state, { message: "1" }, deps);
  assert.equal(cola.state.cart.length, 2, "se agregó la coca cola");
  // Reintento real de BuilderBot: el mismo "1" llegó mientras se procesaba (arrivedAt <= lastAt) → duplicado.
  assert.equal(isDuplicateTurn(session, hash1, t0 + 1400, t0 + 1600), true, "llegó mientras se procesaba");
  // Mismo mensaje con la misma pregunta abierta en < 5 s → duplicado; pasados 5 s → mensaje nuevo.
  const again: any = { ...session, state: session.state, lastStageBefore: pendingKey(session.state) };
  assert.equal(isDuplicateTurn(again, hash1, t0 + 3000, t0 + 3000), true);
  assert.equal(isDuplicateTurn(again, hash1, t0 + 9000, t0 + 9000), false);
  // Tras crear la orden, repetir el "sí" en < 5 s es el mismo envío aunque la clave cambie (confirm → ordered).
  const resumen = await atSummary(deps);
  const creada = await handleTurn(resumen, { message: "si" }, deps);
  const guardada = turnRecord(resumen, creada, turnHash("si", null, null), new Date(t0));
  assert.equal(isDuplicateTurn(guardada, turnHash("si", null, null), t0 + 2000, t0 + 2000), true);
  assert.equal(isDuplicateTurn(guardada, turnHash("sí", null, null), t0 + 2000, t0 + 2000), false, "otro texto no es reintento");
});

test("VR-05: después de la orden, 'hola' saluda (no '¡Gracias a ti!')", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "confirmo"]);
  const hola = await handleTurn(state, { message: "hola" }, deps);
  assert.match(hola.reply, /^¡Hola de nuevo!/);
  assert.doesNotMatch(hola.reply, /Gracias a ti/);
  assert.match(hola.reply, /ORD-00991/);
  assert.equal(hola.step, "ordered");
  const gracias = await handleTurn(state, { message: "gracias" }, deps);
  assert.match(gracias.reply, /Gracias a ti/);
});

test("N1: en el paso del nombre, 'retiro', 'sí' o 'tarjeta' no son un nombre", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1"]);
  assert.equal(state.stage, "name");
  for (const message of ["retiro", "si", "tarjeta", "menú", "confirmo", "delivery"]) {
    const result = await handleTurn(state, { message }, deps);
    assert.equal(result.state.customerName, undefined, message);
    assert.notEqual(result.intent, "dudas", message);
  }
  const retiro = await handleTurn(state, { message: "retiro" }, deps);
  assert.equal(retiro.step, "name");
  assert.match(retiro.reply, /nombre/);
  const nombre = await handleTurn(state, { message: "Rosa Prueba" }, deps);
  assert.equal(nombre.state.customerName, "Rosa Prueba");
});

test("N2: pedir más del tope dice la cantidad real agregada", async () => {
  const { deps } = fakeDeps();
  const { state, last } = await chat(deps, ["hola", "60 humitas"]);
  assert.equal(state.cart[0].quantity, 50);
  assert.match(last.reply, /Agregué 50 x Humita/);
  assert.match(last.reply, /máximo por producto es 50/);
});

test("N6: razón social conserva siglas y mayúsculas del cliente", async () => {
  assert.equal(titleCaseName("Rosa Prueba SA"), "Rosa Prueba SA");
  assert.equal(titleCaseName("rosa prueba s.a."), "Rosa Prueba S.A.");
  assert.equal(titleCaseName("comercial XYZ cia ltda"), "Comercial XYZ CIA LTDA");
  assert.equal(titleCaseName("ROSA PRUEBA"), "Rosa Prueba", "todo en mayúsculas se normaliza");
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita con factura", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "0912345675001", "Rosa Prueba SA"]);
  assert.equal(state.billingName, "Rosa Prueba SA");
});

test("N4: un JID '@lid' se guarda como 'lid:<id>', no como teléfono", async () => {
  assert.equal(toE164("593991234567:12@s.whatsapp.net"), "+593991234567");
  assert.equal(toE164("123456789012345@lid"), "lid:123456789012345");
  assert.equal(toE164("lid:123456789012345"), "lid:123456789012345", "idempotente");
});

test("CL-01: un 'sí' repetido después de crear la orden no borra el pedido ni el link", async () => {
  for (const repeated of ["si", "sí", "claro", "correcto", "de una", "exacto", "si esta bien asi"]) {
    const { deps, created } = fakeDeps();
    const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "si"]);
    assert.equal(state.stage, "ordered");
    const otra = await handleTurn(state, { message: repeated }, deps);
    assert.equal(otra.decision, "R7:ya_confirmado", `'${repeated}' → ${otra.decision}`);
    assert.equal(otra.step, "ordered");
    assert.equal(otra.state.lastOrderNumber, "ORD-00991");
    assert.match(otra.reply, /https:\/\/boloncity\.com\/pago/);
    assert.equal(created.length, 1, "no se crea otra orden");
    assert.equal(classifyRoute(state, repeated), "checkout", "router y conversación coinciden");
    const link = await handleTurn(otra.state, { message: "el link no me abre" }, deps);
    assert.match(link.reply, /https:\/\/boloncity\.com\/pago/);
  }
  // Un pedido nuevo después de la orden sigue arrancando uno nuevo.
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "si"]);
  const nuevo = await handleTurn(state, { message: "quiero 2 humitas" }, deps);
  assert.notEqual(nuevo.step, "ordered");
});

test("CL-01: reintento del mismo mensaje en 5 s tras crear la orden es R0 (aunque cambie la clave)", async () => {
  const base = { arrivedAt: 2000, lastAt: 1000, now: 2000, currentKey: "ordered|x", keyBefore: "confirm|y" };
  assert.equal(isRetry({ ...base, createdOrder: true }), true);
  assert.equal(isRetry({ ...base, createdOrder: false }), false, "VR-04: otra pregunta no es reintento");
  assert.equal(isRetry({ ...base, now: 7000, createdOrder: true }), false, "pasados 5 s es un mensaje nuevo");
  assert.equal(isRetry({ ...base, currentKey: "confirm|y", createdOrder: false }), true);
});

test("F-01: cambiar a delivery descarta '¿En qué local lo retiras?' y pide la ubicación", async () => {
  const { deps } = fakeDeps();
  for (const cambio of ["mejor delivery", "quiero delivery a mi casa", "no, mejor delivery"]) {
    const { state, last } = await chat(deps, ["2 humitas", "retiro", cambio]);
    assert.equal(state.deliveryType, "delivery", cambio);
    assert.equal(state.pendingChoice?.kind === "branch", false, `${cambio}: la elección de local se descarta`);
    assert.doesNotMatch(last.reply, /¿En qué local/, cambio);
    assert.match(last.reply, /ubicaci[oó]n/i, cambio);
  }
});

test("F-01: 'mejor delivery' no es un producto y la IA no quita productos que el cliente no nombró", async () => {
  const ctx = { lastBotQuestion: "¿En qué local lo retiras?", cartNames: ["Humita"] };
  for (const m of ["mejor delivery", "no, mejor delivery", "quiero delivery a mi casa", "sí, delivery por favor", "mejor con tarjeta"]) {
    const e = await heuristicExtract(m, ctx);
    assert.deepEqual(e.items, [], `${m}: ${JSON.stringify(e.items)}`);
  }
  assert.equal((await heuristicExtract("quiero delivery, 2 bolones y una coca", ctx)).items.length, 2, "los productos siguen separándose");
  assert.equal((await heuristicExtract("mejor 2 cafés", ctx)).setQuantity.length, 1, "'mejor 2 cafés' sigue cambiando la cantidad");
  // IA simulada que devuelve remove:["Humita"] para "no, mejor delivery".
  const originalPost = axios.post;
  const originalKey = env.GEMINI_API_KEY;
  const fakeAi = (json: object) =>
    (async () => ({ data: { candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] } })) as any;
  try {
    (env as any).GEMINI_API_KEY = "test";
    (axios as any).post = fakeAi({ items: [], remove: ["Humita"], setQuantity: [], deliveryType: "delivery" });
    const cambio = await aiExtract("no, mejor delivery", ctx);
    assert.deepEqual(cambio.remove, [], "sin verbo de quitar ni el producto nombrado, no se quita nada");
    assert.equal(cambio.deliveryType, "delivery");
    (axios as any).post = fakeAi({ items: [], remove: ["Humita"], setQuantity: [] });
    assert.deepEqual((await aiExtract("quítala", ctx)).remove, ["Humita"], "'quítala' sí quita");
    assert.deepEqual((await aiExtract("ya no quiero la humita", ctx)).remove, ["Humita"]);
  } finally {
    (axios as any).post = originalPost;
    (env as any).GEMINI_API_KEY = originalKey;
  }
});

// ─── Regresiones CL/F/V (verificación en localhost, 2026-09-22) ─────────────

test("CL-02: en el resumen, confirmaciones con typos confirman; lo que no cambia nada NO deriva a soporte", async () => {
  for (const message of ["esta bien todo", "todo esta bien", "confirmoo", "confimo", "siii confirmo", "si porfavor", "ok dale", "listo gracias", "si todo bien gracias", "sip", "okis", "conffirmo", "perfeto"]) {
    assert.equal(classifyConfirmReply(message), "confirm", message);
    const { deps, created } = fakeDeps();
    const state = await atSummary(deps);
    assert.equal(classifyRoute(state, message), "checkout", `router: ${message}`);
    const result = await handleTurn(state, { message }, deps);
    assert.equal(result.decision, "R7:orden_creada", `${message} → ${result.decision}`);
    assert.equal(created.length, 1);
  }
  for (const message of ["si pero agregale un cafe", "si, y agregale un cafe", "sin cebolla", "envio", "otro bolon"]) assert.equal(classifyConfirmReply(message), "other", message);
  for (const message of ["gracias", "ya", "por favor", "grasias"]) assert.equal(classifyConfirmReply(message), "courtesy", message);
  // Dos mensajes seguidos que no cambian nada: se reimprime el resumen, sin "no entendido" ni derivar.
  const { deps, created } = fakeDeps();
  let state = await atSummary(deps);
  for (const message of ["okey dokey", "mmm", "asdfgh"]) {
    const result = await handleTurn(state, { message }, deps);
    assert.equal(result.decision, "R7:resumen_sin_cambios", message);
    assert.equal(result.step, "confirm");
    assert.equal(result.route, "summary");
    assert.notEqual(result.intent, "dudas");
    assert.equal(result.state.misunderstood || 0, 0);
    assert.match(result.reply, /Resumen de tu pedido[\s\S]*Escribe \*confirmo\*/);
    state = result.state;
  }
  assert.equal(created.length, 0);
});

test("CL-03: un número suelto en el resumen no cambia el carrito (ni pasa por la IA)", async () => {
  let aiCalls = 0;
  // IA que leería "1" como "que sea 1 tostada" (lo que pasaba en vivo).
  const extract: Extractor = async (message, context) => {
    aiCalls += 1;
    return /^\d+$/.test(message) ? { items: [], remove: [], setQuantity: [{ query: "tostada mixta", quantity: Number(message) }], source: "ai" } : heuristicExtract(message, context);
  };
  const { deps, created } = fakeDeps({ extract });
  const state = await atSummary(deps);
  const calls = aiCalls;
  for (const message of ["1", "2", "3"]) {
    const result = await handleTurn(state, { message }, deps);
    assert.equal(result.decision, "R10:numero_suelto", message);
    assert.deepEqual(result.state.cart, state.cart, message);
    assert.equal(result.step, "confirm");
    assert.match(result.reply, /Escribe \*confirmo\*/);
    assert.equal(result.state.misunderstood || 0, 0);
  }
  assert.equal(aiCalls, calls, "no se llamó a la IA");
  assert.equal(created.length, 0);
});

test("CL-04: route='checkout' solo con la orden creada; el resumen y la cortesía son 'summary'", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["una tostada mixta", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(results[results.length - 1].route, "summary", "mostrar el resumen no es checkout");
  assert.ok(results.every((result) => result.route !== "checkout"));
  for (const message of ["gracias", "1", "okey dokey", "si pero agregale una humita"]) {
    const result = await handleTurn(state, { message }, deps);
    assert.notEqual(result.route, "checkout", message);
    assert.equal(result.orderNumber, undefined, message);
  }
  const creada = await handleTurn(state, { message: "confirmo" }, deps);
  assert.equal(creada.route, "checkout");
  assert.ok(creada.orderNumber);
  assert.equal((await handleTurn(creada.state, { message: "si" }, deps)).route, "checkout", "orden ya existente");
});

test("F-02/V-02: con delivery, un '1' a la lista vieja de locales no elige local; 'delivery' repite la ubicación sin R11", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["2 humitas", "retiro", "mejor delivery"]);
  assert.equal(state.stage, "location");
  const uno = await handleTurn(state, { message: "1" }, deps);
  assert.equal(uno.state.branchId, undefined, "no elige local en delivery");
  assert.doesNotMatch(uno.reply, /lo retiras en/);
  assert.deepEqual(uno.state.cart, state.cart, "el '1' no cambia cantidades");
  assert.equal(uno.step, "location");
  // Aunque quede una lista de locales residual en el estado, en delivery no se usa.
  const residual = await handleTurn({ ...state, pendingChoice: { kind: "branch", options: await deps.pickupBranches() } }, { message: "1" }, deps);
  assert.equal(residual.state.branchId, undefined);
  assert.equal(residual.state.deliveryType, "delivery");
  let current = state;
  for (const message of ["delivery", "quiero delivery a mi casa", "mejor para delivery"]) {
    const result = await handleTurn(current, { message }, deps);
    assert.ok(!result.decision.startsWith("R11"), `${message} → ${result.decision}`);
    assert.equal(result.step, "location");
    assert.doesNotMatch(result.reply, /no tenemos/i);
    assert.match(result.reply, /ubicación/);
    current = result.state;
  }
  const mejor = await chat(deps, ["2 humitas", "mejor para delivery"]);
  assert.doesNotMatch(mejor.last.reply, /no tenemos "mejor/i);
});

test("F-03: si el envío cambia al elegir efectivo, se dice explícitamente (y en la pregunta de costo)", async () => {
  const { deps } = fakeDeps({ cashFee: 2.8 });
  const { state } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }]);
  const costo = await handleTurn(state, { message: "cuanto cuesta el envio?" }, deps);
  assert.match(costo.reply, /\$2\.50 pagando con tarjeta y \$2\.80 pagando en efectivo/);
  const { last } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "Ana", "ana@test.com", "efectivo"]);
  assert.match(last.reply, /el envío pagando en efectivo cuesta \$2\.80/);
  assert.match(last.reply, /Delivery \$2\.80/);
  const igual = await chat(fakeDeps().deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "Ana", "ana@test.com", "efectivo"]);
  assert.doesNotMatch(igual.last.reply, /el envío pagando/i, "si no cambia, no se avisa");
});

test("V-01: 'no, mejor para retirar' con una elección de producto pendiente aplica el retiro", async () => {
  const { deps } = fakeDeps();
  const { state, last } = await chat(deps, ["una humita y un bolón de queso", "no, mejor para retirar"]);
  assert.equal(state.deliveryType, "pickup");
  assert.match(last.reply, /no lo agrego/);
  assert.match(last.reply, /¿En qué local/);
  assert.deepEqual(state.cart.map((item) => item.name), ["HUMITA"]);
  const solo = await chat(deps, ["un bolón de queso", "no"]);
  assert.equal(solo.last.decision, "R4:eleccion_producto_descartado");
});

test("V-03: tras crear la orden, 'sí, y agrégale un café' avisa que la orden no se modifica", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "confirmo"]);
  const result = await handleTurn(state, { message: "si, y agregale un cafe" }, deps);
  assert.match(result.reply, /ORD-00991 ya está registrado y no lo puedo modificar/);
  assert.equal(result.state.lastOrderNumber, undefined);
});

test("V-04: delivery → retiro → delivery reusa la ubicación y recotiza", async () => {
  const { deps } = fakeDeps();
  const { state, last } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "retiro", "delivery"]);
  assert.deepEqual(state.deliveryCoordinates, { lat: -2.1, lng: -79.9 });
  assert.equal(state.branchId, "b-urdesa");
  assert.equal(state.deliveryFee, 2.5);
  assert.notEqual(last.step, "location", "no vuelve a pedir la ubicación");
  assert.match(last.reply, /Uso la ubicación que me compartiste/);
});

test("F-04: los datos adelantados se confirman con un acuse corto", async () => {
  const { deps } = fakeDeps();
  const { last } = await chat(deps, ["2 humitas para retirar, pago en efectivo"]);
  assert.match(last.reply, /Anoté: efectivo ✅/);
  const pago = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo"]);
  assert.doesNotMatch(pago.last.reply, /Anoté/, "respondió lo que se preguntó: sin acuse");
});

test("RL-01: las rutas del bot se reconocen sin importar mayúsculas (X-Bot-Token no se salta)", async () => {
  assert.equal(isBotPath("/api/orders/whatsapp-bot/router"), true);
  assert.equal(isBotPath("/api/orders/WHATSAPP-BOT/search-order"), true);
  assert.equal(isBotPath("/api/orders/WhatsApp-Bot/brain"), true);
  assert.equal(isBotPath("/api/orders/whatsapp%2Dbot/brain"), true);
  assert.equal(isBotPath("/api/orders/123"), false);
});

test("ADV-01/02: negaciones, palabras parecidas y preguntas NO confirman; los typos sí", async () => {
  for (const text of ["incorrecto", "todo incorrecto", "incorrecto gracias", "imperfecto", "inexacto", "limon", "visto", "buenos", "seguidos", "confirmas", "pagas", "mandas", "sigues", "ya lo enviaron", "confirmaron"]) {
    assert.notEqual(classifyConfirmReply(text), "confirm", text);
  }
  for (const text of ["¿confirmo?", "confirma?", "¿esta bien?", "perfecto?", "¿de acuerdo?", "confirmas?", "lo confirmas?", "¿sigues?", "pagas?", "¿mandas?", "enviado?", "confirmaron?", "procedo?", "lo mando?", "bueno?", "¿ya lo enviaron?"]) {
    assert.notEqual(classifyConfirmReply(text), "confirm", text);
  }
  for (const text of ["confimo", "confirmoo", "conffirmo", "perfeto", "corecto", "confirmdo", "siii", "si", "ok dale", "todo correcto"]) {
    assert.equal(classifyConfirmReply(text), "confirm", text);
  }
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  for (const text of ["incorrecto", "todo incorrecto", "¿confirmo?", "¿ya lo enviaron?"]) {
    const result = await handleTurn(state, { message: text }, deps);
    assert.notEqual(result.decision, "R7:orden_creada", text);
    assert.notEqual(classifyRoute(state, text), "checkout", text);
  }
  assert.equal((await handleTurn(state, { message: "todo incorrecto" }, deps)).decision, "R7:pedir_cambio");
  assert.equal(created.length, 0);
});

test("CONF-01: en el resumen, 'cuánto se demora' / 'dónde está mi pedido' responden del pedido sin confirmar", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  for (const text of ["cuanto se demora", "cuanto se demora?", "donde esta mi pedido", "en cuanto tiempo esta listo", "a que hora llega?"]) {
    assert.equal(classifyRoute(state, text), "conversation", text);
    const result = await handleTurn(state, { message: text }, deps);
    assert.equal(result.decision, "R7:pregunta_en_resumen", text);
    assert.match(result.reply, /todavía no está enviado/, text);
    assert.match(result.reply, /confirmo/i, text);
    assert.equal(result.step, "confirm");
  }
  // Con un número de orden explícito sigue siendo una consulta de un pedido anterior.
  assert.equal(classifyRoute(state, "donde esta mi pedido ORD-00012"), "search_order");
});

test("ADV-04: en el resumen se puede corregir la dirección y una duda no dice 'No vi ningún cambio'", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  const cases: Array<[string, string]> = [
    ["cambia la direccion a calle 8 casa 2", "calle 8 casa 2"],
    ["mi direccion es calle 8 casa 2", "calle 8 casa 2"],
    ["la dirección está mal, es Urdesa calle 8", "Urdesa calle 8"],
  ];
  for (const [text, address] of cases) {
    const result = await handleTurn(state, { message: text }, deps);
    assert.equal(result.decision, "R7:direccion_cambiada", text);
    assert.equal(result.state.deliveryAddress, address);
    assert.equal(result.step, "confirm");
  }
  const vague = await handleTurn(state, { message: "la direccion esta mal" }, deps);
  assert.equal(vague.state.deliveryAddress, undefined);
  assert.equal(vague.step, "address");
  const doubt = await handleTurn(state, { message: "aceptan cupones?" }, deps);
  assert.equal(doubt.decision, "R7:duda_en_resumen");
  assert.doesNotMatch(doubt.reply, /No vi ningún cambio/);
});

test("E2E-01: 'qué llevo' con el carrito vacío responde y no suma 'no entendido'", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["qué llevo en mi carrito", "que llevo"]);
  for (const result of results) {
    assert.equal(result.decision, "R8:carrito_vacio");
    assert.match(result.reply, /carrito está vacío/);
  }
  assert.equal(state.misunderstood || 0, 0);
});

test("ADV-03: 'nop, ninguno' / 'no, ninguno de esos' descartan sin sumar 'no entendido'", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["una humita, un cafe y un bolon mixto", "no, ninguno de esos", "nop, ninguno", "ehh"]);
  assert.equal(results[1].decision, "R4:eleccion_producto_descartado");
  assert.equal(results[2].decision, "R4:eleccion_producto_descartado");
  assert.notEqual(results[3].decision, "R11:derivado_a_persona");
  assert.ok(state.cart.some((item) => item.name === "HUMITA"));
});

test("R6-01: en el resumen, lo que no es una dirección no reemplaza la dirección de entrega", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  for (const text of [
    "la direccion esta bien, cambia el pago a efectivo",
    "la direccion es correcta",
    "la direccion es la misma",
    "la direccion esta bien pero agregale un cafe a mi pedido",
  ]) {
    const result = await handleTurn(state, { message: text }, deps);
    assert.notEqual(result.decision, "R7:direccion_cambiada", text);
    assert.equal(result.state.deliveryAddress, "Cdla. Kennedy mz 1", text);
  }
});

test("R6-03: palabras cortas parecidas a una confirmación no crean la orden ('parar', 'pasar', 'hablo')", async () => {
  for (const text of ["parar", "pasar", "hablo", "pagas", "adelgaste", "visto", "limon", "claros"]) {
    assert.notEqual(classifyConfirmReply(text), "confirm", text);
  }
  for (const text of ["confimo", "confirmoo", "conffirmo", "confirmr", "perfeto", "corecto", "adelnte", "confirmo el pedido"]) {
    assert.equal(classifyConfirmReply(text), "confirm", text);
  }
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  for (const text of ["parar", "pasar", "hablo"]) {
    assert.notEqual(classifyRoute(state, text), "checkout", text);
    assert.notEqual((await handleTurn(state, { message: text }, deps)).decision, "R7:orden_creada", text);
  }
  assert.equal(created.length, 0);
});

test("R6-02: en el resumen, 'cancela mi pedido' / 'ya no quiero mi pedido' / 'cancelar' vacían el carrito sin crear orden", async () => {
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  for (const text of ["cancela mi pedido", "ya no quiero mi pedido", "cancelar"]) {
    assert.equal(classifyRoute(state, text), "conversation", text);
    const result = await handleTurn(state, { message: text }, deps);
    assert.equal(result.decision, "R6:vaciar_carrito", text);
    assert.equal(result.state.cart.length, 0, text);
    assert.match(result.reply, /borré tu pedido/, text);
  }
  assert.equal(created.length, 0);
});

test("R6-04: 'no quiero ninguno' / 'no quiero ese' descartan la elección sin sumar 'no entendido'", async () => {
  for (const text of ["no quiero ninguno", "no quiero ese"]) {
    const { deps } = fakeDeps();
    const { results, state } = await chat(deps, ["una humita y un bolon mixto", text, "ehh"]);
    assert.equal(results[1].decision, "R4:eleccion_producto_descartado", text);
    assert.doesNotMatch(results[1].reply, /No te entendí/, text);
    assert.notEqual(results[2].decision, "R11:derivado_a_persona", text);
    assert.ok(state.cart.some((item) => item.name === "HUMITA"), text);
  }
});

test("R6-05: 'no confirmo' / 'todavia no' / 'espera' en el resumen piden confirmar cuando quiera", async () => {
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta"]);
  for (const text of ["no confirmo", "todavia no", "todavía no", "espera", "espérame un momento", "no confirmo todavia"]) {
    assert.notEqual(classifyRoute(state, text), "checkout", text);
    const result = await handleTurn(state, { message: text }, deps);
    assert.equal(result.decision, "R7:espera_en_resumen", text);
    assert.match(result.reply, /Cuando quieras escribe \*confirmo\*/, text);
    assert.doesNotMatch(result.reply, /No vi ningún cambio/, text);
  }
  // "espera, agrégale un café" sí trae un cambio.
  const change = await handleTurn(state, { message: "espera, agregale un cafe" }, deps);
  assert.notEqual(change.decision, "R7:espera_en_resumen");
  assert.equal(created.length, 0);
});

test("R6-06: 'ver carrito' / 'carrito' con el carrito vacío responden que está vacío", async () => {
  const { deps } = fakeDeps();
  const { results, state } = await chat(deps, ["ver carrito", "carrito", "mi carrito"]);
  for (const result of results) assert.equal(result.decision, "R8:carrito_vacio");
  assert.equal(state.misunderstood || 0, 0);
  const full = await chat(deps, ["una humita", "ver carrito"]);
  assert.equal(full.results[1].decision, "R8:ver_carrito");
});

test("F1: 'mi dirección es la que te di, pero ponme 2 humitas' no cambia la dirección y agrega las humitas", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  for (const text of [
    "mi direccion es la que te di, pero ponme 2 humitas",
    "mi direccion es la de siempre, pero ponme 2 humitas",
    "la direccion es la de antes y 1 cafe",
    "mi direccion es la anterior, agregame 2 cafes",
    "mi direccion es calle 5, ponme 2 humitas",
  ]) {
    const result = await handleTurn(state, { message: text }, deps);
    assert.notEqual(result.decision, "R7:direccion_cambiada", text);
    assert.equal(result.state.deliveryAddress, "Cdla. Kennedy mz 1", text);
  }
  const humitas = await handleTurn(state, { message: "mi direccion es la que te di, pero ponme 2 humitas" }, deps);
  assert.ok(humitas.state.cart.some((item) => item.name === "HUMITA" && item.quantity >= 2), JSON.stringify(humitas.state.cart));
  // Las correcciones reales siguen funcionando.
  const real = await handleTurn(state, { message: "mi direccion es Urdesa calle 8 casa 2" }, deps);
  assert.equal(real.decision, "R7:direccion_cambiada");
  assert.equal(real.state.deliveryAddress, "Urdesa calle 8 casa 2");
});

test("F3: en el paso de dirección 'la misma' / 'no se' / 'otra direccion' no se guardan como dirección", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }, "Cdla. Kennedy mz 1", "Ana", "ana@test.com", "tarjeta"]);
  assert.equal(state.stage, "confirm");
  const wrong = await handleTurn(state, { message: "la direccion esta mal" }, deps);
  assert.equal(wrong.step, "address");
  assert.equal(wrong.state.deliveryAddress, undefined);
  for (const text of ["no se", "no sé", "otra direccion", "otra dirección por favor", "ni idea", "cambiar la direccion"]) {
    const result = await handleTurn(wrong.state, { message: text }, deps);
    assert.equal(result.state.deliveryAddress, undefined, text);
    assert.equal(result.step, "address", text);
    assert.match(result.reply, /Escríbeme la dirección/, text);
  }
  // "la misma" / "igual que antes" recuperan la dirección que tenía.
  for (const text of ["la misma", "igual que antes", "la que te di", "la de antes"]) {
    const result = await handleTurn(wrong.state, { message: text }, deps);
    assert.equal(result.state.deliveryAddress, "Cdla. Kennedy mz 1", text);
    assert.equal(result.step, "confirm", text);
    assert.match(result.reply, /Delivery a: Cdla\. Kennedy mz 1/, text);
  }
  // Sin dirección anterior, "la misma" no se guarda.
  const fresh = await chat(deps, ["una humita", "delivery", { location: { lat: -2.1, lng: -79.9 } }]);
  assert.equal(fresh.state.stage, "address");
  for (const text of ["la misma", "igual que antes", "no se", "otra direccion"]) {
    const result = await handleTurn(fresh.state, { message: text }, deps);
    assert.equal(result.state.deliveryAddress, undefined, text);
    assert.equal(result.step, "address", text);
  }
  // Una dirección real sin número sigue aceptándose.
  const real = await handleTurn(wrong.state, { message: "casa verde, junto al parque" }, deps);
  assert.equal(real.state.deliveryAddress, "casa verde, junto al parque");
  assert.equal(real.state.previousDeliveryAddress, undefined);
});

test("flow tipo Sorbito: el mensaje sale del {history} cuando no llega rawMessage", async () => {
  const lastIsHumitas = [
    [{ role: "assistant", content: "Hola, ¿qué deseas?" }, { role: "user", content: "quiero 2 humitas" }],
    JSON.stringify([{ role: "user", content: "hola" }, { role: "assistant", content: "Hola!" }, { role: "user", content: "quiero 2 humitas" }]),
    { messages: [{ role: "user", content: "hola" }, { role: "user", content: "quiero 2 humitas" }] },
    "user: hola\nassistant: ¿Qué te gustaría pedir?\nuser: quiero 2 humitas",
    "Cliente: hola\nAsistente: dime\nCliente: quiero 2 humitas",
    "quiero 2 humitas",
  ];
  for (const history of lastIsHumitas) assert.equal(latestUserMessage(history), "quiero 2 humitas", JSON.stringify(history));
  assert.equal(latestUserMessage("user: una humita\ny un cafe\nassistant: listo"), "una humita\ny un cafe");
  for (const empty of [undefined, null, "", "{history}", [], [{ role: "assistant", content: "hola" }]]) {
    assert.equal(latestUserMessage(empty), "", JSON.stringify(empty));
  }
});

test("a BuilderBot solo salen 5 rutas: conversation, catalog, checkout, search_order, human", async () => {
  const PERMITIDAS = ["conversation", "catalog", "checkout", "search_order", "human"];
  const { deps } = fakeDeps();
  const mensajes = [
    "hola quisiera comprar", "quisiera 2 bolones de queso", "2", "retiro", "1", "ana@test.com", "1",
    "menu", "que llevo", "confirmo", "gracias", "mi pedido", "asdfgh", "tengo un reclamo, llego frio",
  ];
  const { results, state } = await chat(deps, mensajes);
  for (const result of results) {
    assert.ok(PERMITIDAS.includes(botResponseRoute(result.route)), `ruta interna ${result.route} no se traduce`);
  }
  for (const message of mensajes) {
    assert.ok(PERMITIDAS.includes(classifyRoute(state, message)), `classifyRoute devolvió algo nuevo con "${message}"`);
  }
});

test("la cantidad dicha al elegir se respeta ('y verde quiero 3'), y un número solo sigue siendo la opción", async () => {
  const { deps } = fakeDeps();
  const casos: Array<[string, string, number]> = [
    ["bolon de queso y verde quiero 3", "BOLON QUESO VERDE", 3],
    ["ponme 2 del maduro", "BOLON MADURO QUESO", 2],
    ["dame tres del verde porfa", "BOLON QUESO VERDE", 3],
    ["el verde porfa", "BOLON QUESO VERDE", 1],
  ];
  for (const [texto, nombre, cantidad] of casos) {
    const { state } = await chat(deps, ["quiero un bolon de queso", texto]);
    const item = state.cart.find((producto) => producto.name === nombre);
    assert.ok(item, `${texto} → no agregó ${nombre}`);
    assert.equal(item?.quantity, cantidad, texto);
  }
  // "2" solo elige la opción 2: no son 2 unidades.
  const { state } = await chat(deps, ["quiero un bolon de queso", "2"]);
  assert.equal(state.cart[0]?.quantity, 1);
});

test("dos nodos HTTP de BuilderBot con el mismo mensaje = un solo turno", async () => {
  const sesion = { lastMessageHash: "abc", lastReply: "respuesta", lastMessageAt: new Date(1000), lastStageBefore: "choosing|aaa", lastEndpoint: "assistant", state: { stage: "delivery_type" } };
  // /assistant ya lo atendió y cambió el paso; el otro nodo llega a /brain con el mismo texto: misma respuesta.
  assert.equal(isDuplicateTurn(sesion, "abc", 2200, 2200, "brain"), true);
  // Pasados 20 s ya no se agrupan aunque sean endpoints distintos.
  assert.equal(isDuplicateTurn(sesion, "abc", 25000, 25000, "brain"), false);
  // Mismo endpoint respondiendo OTRA pregunta: sigue siendo un mensaje nuevo (VR-04 protegido).
  assert.equal(isDuplicateTurn({ ...sesion, state: { stage: "choosing" }, lastStageBefore: "choosing|zzz" }, "abc", 2200, 2200, "assistant"), false);
});

test("DN-01: el turno del OTRO nodo HTTP con el MISMO texto no se procesa dos veces", async () => {
  // Producción: un nodo manda rawMessage={body} y el otro solo history={history}. Misma burbuja = mismo texto,
  // o el nodo de {history} sin texto legible (hash vacío).
  const hash = turnHash("la zero", null, null);
  const vacio = turnHash("", null, null);
  const sesion = { lastMessageHash: hash, lastReply: "respuesta", lastMessageAt: new Date(1000), lastStageBefore: "choosing|aaa", lastEndpoint: "brain", state: { stage: "choosing" } };
  assert.equal(isDuplicateTurn(sesion, hash, 2200, 2200, "assistant"), true, "otro nodo, mismo texto, segundos después: misma burbuja");
  assert.equal(isDuplicateTurn(sesion, vacio, 2200, 2200, "assistant"), true, "el nodo de {history} sin texto legible no trae nada nuevo");
  // Pasada la ventana ya es una burbuja nueva aunque venga por el otro nodo.
  assert.equal(isDuplicateTurn(sesion, hash, 30000, 30000, "assistant"), false);
  // Dos burbujas DE VERDAD del cliente llegan por el MISMO endpoint: se procesan las dos.
  assert.equal(isDuplicateTurn({ ...sesion, lastMessageHash: "otro" }, hash, 2200, 2200, "brain"), false, "mismo nodo, texto nuevo: se procesa");
  // Sin endpoint guardado (sesión vieja) la defensa no inventa duplicados.
  assert.equal(isDuplicateTurn({ ...sesion, lastEndpoint: "" }, "OTRO-hash", 2200, 2200, "assistant"), false);
  assert.equal(isOtherHttpNode({ endpoint: "brain", endpointBefore: "assistant", lastAt: 1000, now: 2000 }), true);
  assert.equal(isOtherHttpNode({ endpoint: "brain", endpointBefore: "brain", lastAt: 1000, now: 2000 }), false);
});

test("DN-04: el pin (/location) y el menú (/catalog) NUNCA son el 'otro nodo': son pasos del mismo flow", async () => {
  // El cliente manda el pin a los 3 s de que el bot se lo pide: con la ventana de 20 s se descartaba y el
  // delivery quedaba imposible (el turno tragado ni siquiera escribe la sesión: el bucle duraba 20 s).
  const pin = turnHash("", { lat: -2.1709, lng: -79.9224 }, null);
  const sesion = { lastMessageHash: turnHash("a domicilio", null, null), lastReply: "Mándame tu ubicación desde el clip 📎", lastMessageAt: new Date(1000), lastStageBefore: "location|aaa", lastEndpoint: "brain", state: { stage: "location" } };
  assert.equal(isDuplicateTurn(sesion, pin, 4000, 4000, "location"), false, "el pin se procesa aunque llegue a los 3 s");
  assert.equal(isOtherHttpNode({ endpoint: "location", endpointBefore: "brain", lastAt: 1000, now: 4000 }), false);
  const menu = { ...sesion, lastMessageHash: turnHash("hola", null, null), lastReply: "¡Hola! 👋", lastStageBefore: "idle|aaa", state: { stage: "idle" } };
  assert.equal(isDuplicateTurn(menu, turnHash("quiero ver el menu", null, null), 2000, 2000, "catalog"), false, "el menú se procesa");
  assert.equal(isOtherHttpNode({ endpoint: "catalog", endpointBefore: "brain", lastAt: 1000, now: 2000 }), false);
});

test("DN-05: con los dos nodos en orden alternado, la burbuja NUEVA no recibe la respuesta vieja", async () => {
  // Burbuja 1 la atendió /brain; la burbuja 2 llega primero por /assistant con OTRO texto: es un mensaje nuevo.
  const sesion = { lastMessageHash: turnHash("hola, quiero un bolon mixto", null, null), lastReply: "¿Cuál colita quieres?", lastMessageAt: new Date(1000), lastStageBefore: "choosing|aaa", lastEndpoint: "brain", state: { stage: "choosing" } };
  assert.equal(isDuplicateTurn(sesion, turnHash("la zero", null, null), 1700, 1700, "assistant"), false, "texto nuevo por el otro nodo: es la burbuja siguiente");
});

test("DN-02: lastEndpoint está en el schema de la sesión (si no, Mongoose lo descarta y la defensa nunca se activa)", async () => {
  assert.ok(WhatsAppSession.schema.path("lastEndpoint"), "falta lastEndpoint en models/WhatsAppSession.ts");
  const guardado: any = turnRecord(createInitialState("+593900120001"), { state: createInitialState("+593900120001"), reply: "hola", route: "conversation", intent: "conversar", step: "idle", decision: "R10:saludo" } as TurnResult, "abc", new Date(1000), "brain");
  assert.equal(guardado.lastEndpoint, "brain");
});

test("DN-03: VR-04 sigue viva con la defensa de dos nodos (dos '1' seguidos por el MISMO endpoint)", async () => {
  const { deps } = fakeDeps();
  const start = createInitialState("+593900120002");
  const t0 = 2_000_000;
  const hash1 = turnHash("1", null, null);
  const pedido = await handleTurn(start, { message: "2 tigrillos y una coca cola" }, deps);
  let session: any = turnRecord(start, pedido, turnHash("2 tigrillos y una coca cola", null, null), new Date(t0), "brain");
  assert.equal(isDuplicateTurn(session, hash1, t0 + 1000, t0 + 1000, "brain"), false);
  const tigrillo = await handleTurn(session.state, { message: "1" }, deps);
  session = turnRecord(session.state, tigrillo, hash1, new Date(t0 + 1500), "brain");
  assert.equal(isDuplicateTurn(session, hash1, t0 + 3500, t0 + 3500, "brain"), false, "otra pregunta por el mismo nodo: se procesa");
  const cola = await handleTurn(session.state, { message: "1" }, deps);
  assert.equal(cola.state.cart.length, 2, "se agregó la coca cola");
});

test("AP-01: el bot NO se disculpa cuando el turno sí aplicó algo (nombre del local en un mensaje que no entendió)", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro"]);
  // El local se elige dentro de finish(): antes el mensaje salía con "No te entendí bien 🙈" y el local YA elegido.
  const elegido = await handleTurn(state, { message: "bla bla urdesa bla" }, deps);
  assert.equal(elegido.state.branchId, "b-urdesa", "sí se entendió el local");
  assert.doesNotMatch(elegido.reply, /No te entendí bien|Perdón, no te entendí/, elegido.reply);
});

test("AP-02: sin aplicar nada, la disculpa sigue saliendo", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita"]);
  const nada = await handleTurn(state, { message: "asd qwe zxc" }, deps);
  assert.match(nada.decision, /^R1[01]/, nada.decision);
  assert.match(nada.reply, /No te entendí|no te entendí/, nada.reply);
});

test("AP-03: la dirección escrita cuando se pidió el pin se anota y no se pide perdón", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "delivery"]);
  assert.equal(state.stage, "location");
  const direccion = await handleTurn(state, { message: "Victor Emilio Estrada 123 y Guayacanes, casa blanca de dos pisos" }, deps);
  assert.equal(direccion.decision, "R10:direccion_escrita");
  assert.equal(direccion.state.deliveryAddress, "Victor Emilio Estrada 123 y Guayacanes, casa blanca de dos pisos");
  assert.doesNotMatch(direccion.reply, /No te entendí bien/, direccion.reply);
  assert.match(direccion.reply, /pin 📍/);
});

test("PR-01: la pregunta nombra el producto limpio, sin los adjetivos de cómo lo quiere", async () => {
  assert.equal(cleanQueryLabel("colita bien fria"), "colita");
  assert.equal(cleanQueryLabel("cafe bien caliente"), "cafe");
  assert.equal(cleanQueryLabel("una cola grande"), "una cola");
  assert.equal(cleanQueryLabel("bien fria"), "bien fria", "si no queda nada se deja el texto original");
  assert.equal(cleanQueryLabel("bolon mixto de verde"), "bolon mixto de verde");
});

test("PR-02: no se anota 'te pregunto por eso' de algo que se está preguntando en el MISMO mensaje", async () => {
  const { deps } = fakeDeps();
  // La IA a veces devuelve el mismo producto dos veces ("colita" y "colita bien fria"): una sola pregunta.
  const extract: Extractor = async () => ({
    items: [
      { query: "bolon mixto de verde", quantity: 1 },
      { query: "colita bien fria", quantity: 1 },
      { query: "colita", quantity: 1 },
    ],
    remove: [], setQuantity: [], source: "ai",
  } as any);
  const conIa = fakeDeps({ extract }).deps;
  const turno = await handleTurn(createInitialState("+593900120003"), { message: "un bolon mixto de verde y una colita bien fria" }, conIa);
  assert.doesNotMatch(turno.reply, /te pregunto por eso/, turno.reply);
  assert.match(turno.reply, /¿Cuál colita quieres\?/, turno.reply);
  assert.doesNotMatch(turno.reply, /bien fria/, "no se repite el adjetivo del cliente");
  assert.equal(turno.state.choiceQueue.length, 0, "no queda nada en cola: era el mismo producto");
  assert.ok(sameProductQuery("colita bien fria", "colita"));
  assert.equal(sameProductQuery("colita", "bolon mixto"), false);
  void deps;
});

test("PR-03: dos productos DISTINTOS no se descartan como si fueran el mismo ('una cola y una cola zero')", async () => {
  const extract: Extractor = async () => ({
    items: [
      { query: "cola", quantity: 1 },
      { query: "cola zero", quantity: 1 },
    ],
    remove: [], setQuantity: [], source: "ai",
  } as any);
  const turno = await handleTurn(createInitialState("+593900120004"), { message: "quiero una cola y una cola zero" }, fakeDeps({ extract }).deps);
  // La segunda bebida NO se descarta en silencio: como es exacta se agrega ya (antes el pedido salía con una sola).
  assert.equal(turno.state.cart.length + turno.state.choiceQueue.length, 1, JSON.stringify(turno.state.cart));
  assert.equal(turno.state.cart[0]?.name, "COCA COLA ZERO", JSON.stringify(turno.state.cart));
  assert.ok(turno.state.pendingChoice, "y sigue abierta la pregunta por la otra cola");
  assert.equal(sameProductQuery("cola", "cola zero"), false);
  assert.equal(sameProductQuery("bolon", "bolon de queso"), false);
  assert.ok(sameProductQuery("colita bien fria", "colita"), "el mismo producto con adjetivos sigue siendo uno solo");
});

test("CANT-01: 'mejor que sean 3' con una elección abierta cambia la cantidad, no pide perdón", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["quiero un bolon bien grande de chicharron"]);
  assert.ok(state.pendingChoice, "hay una elección abierta");
  const cantidad = await handleTurn(state, { message: "mejor que sean 3" }, deps);
  assert.equal(cantidad.decision, "R4:cantidad_en_eleccion", cantidad.decision);
  assert.doesNotMatch(cantidad.reply, /no te cacho|No te entendí/i, cantidad.reply);
  const elegido = await handleTurn(cantidad.state, { message: "verde" }, deps);
  assert.equal(elegido.state.cart[0]?.quantity, 3, JSON.stringify(elegido.state.cart));
  // Un número suelto sigue siendo la OPCIÓN de la lista, no una cantidad.
  const opcion = await handleTurn(state, { message: "3" }, deps);
  assert.notEqual(opcion.decision, "R4:cantidad_en_eleccion");
});

test("DIR-01: en el paso de dirección, 'me llamo Diego Reyes' es el nombre, no la dirección de entrega", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["quiero una humita", "me lo mandan a la casa", { location: { lat: -2.1709, lng: -79.9224 } }]);
  assert.equal(state.stage, "address");
  const nombre = await handleTurn(state, { message: "me llamo Diego Reyes" }, deps);
  assert.equal(nombre.state.deliveryAddress, undefined, `se guardó como dirección: ${nombre.state.deliveryAddress}`);
  assert.equal(nombre.state.customerName, "Diego Reyes");
  assert.match(nombre.reply, /direccion|dirección/i, nombre.reply);
  // La dirección de verdad sí se guarda y se acusa recibo.
  const direccion = await handleTurn(nombre.state, { message: "Victor Emilio Estrada 123 y Guayacanes, casa blanca de dos pisos" }, deps);
  assert.equal(direccion.state.deliveryAddress, "Victor Emilio Estrada 123 y Guayacanes, casa blanca de dos pisos");
  assert.match(direccion.reply, /Anoté la dirección/, direccion.reply);
});

// ─── Sucursal cerrada: programar o cambiar a una abierta ─────────────────────

test("PROG-01: gana la sucursal MÁS CERCANA aunque esté cerrada (no la abierta lejana)", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { state, last } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }]);
  assert.equal(state.branchId, "b-urdesa", "debe ganar la más cercana, esté abierta o cerrada");
  assert.equal(state.deliveryFee, 2.5, "el envío es el de la cercana, no el de la lejana abierta");
  assert.equal(last.step, "closed");
});

test("PROG-02: con la sucursal cerrada se dice el horario real y se ofrecen las DOS salidas", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { last } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }]);
  assert.match(last.reply, /Atiende de 07:00 a 13:00/, last.reply);
  assert.match(last.reply, /\*programo\* para mañana/i, last.reply);
  assert.match(last.reply, /Samborondón/, last.reply);
  assert.match(last.reply, /\$5\.90/, "debe decir el envío de la alternativa");
});

test("PROG-03: 'prográmalo' deja el pedido para la próxima apertura y lo dice en el resumen y al confirmar", async () => {
  const { deps, created } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { last, state } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } },
    "prográmalo", "Kennedy 123", "Ana", "ana@test.com", "tarjeta",
  ]);
  const opening = fakeNextOpening();
  assert.equal(state.scheduledFor, opening.at, `scheduledFor: ${state.scheduledFor}`);
  assert.equal(state.branchId, "b-urdesa");
  assert.equal(last.step, "confirm");
  assert.match(last.reply, /Programado para mañana .* a las 07:00/, last.reply);
  const confirmado = await handleTurn(state, { message: "confirmo" }, deps);
  assert.equal(created.length, 1);
  assert.equal(created[0].scheduledFor, opening.at, "la orden se crea con scheduledFor");
  assert.match(confirmado.reply, /Programado para mañana/, confirmado.reply);
  assert.doesNotMatch(confirmado.reply, /Ya lo estamos preparando/, "un pedido programado no se está preparando");
});

test("PROG-04: 'que me lo mande la otra' cambia a la sucursal abierta y avisa el nuevo envío", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { state, last } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, "que me lo mande la otra",
  ]);
  assert.equal(state.branchId, "b-samborondon");
  assert.equal(state.scheduledFor, undefined, "si lo quiere ahora, no queda programado");
  assert.equal(state.deliveryFee, 5.9);
  assert.match(last.reply, /\$5\.90/, last.reply);
  assert.notEqual(last.step, "closed");
});

test("PROG-05: elegir la sucursal abierta se respeta al recotizar por el pago", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"], cashFee: 3.2 });
  const { state } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, "la que esté abierta",
    "Kennedy 123", "Ana", "ana@test.com", "efectivo",
  ]);
  assert.equal(state.branchId, "b-samborondon", "el cambio de pago no debe devolverlo a la cerrada");
  assert.equal(state.deliveryFee, 5.9);
});

test("PROG-06: retiro en un local cerrado ofrece programar o elegir otro local abierto", async () => {
  const { deps, created } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { results, state } = await chat(deps, ["una humita", "retiro", "1"]);
  assert.equal(results[2].step, "closed");
  assert.match(results[2].reply, /\*programo\* para mañana/i, results[2].reply);
  assert.match(results[2].reply, /otro local abierto ahorita: Samborondón/, results[2].reply);
  const programado = await chat(deps, ["una humita", "retiro", "1", "dale prográmalo", "Ana", "ana@test.com", "efectivo", "confirmo"]);
  assert.equal(created.length, 1);
  assert.equal(created[0].scheduledFor, fakeNextOpening().at);
  assert.equal(created[0].deliveryType, "pickup");
  assert.match(programado.last.reply, /Programado para mañana/, programado.last.reply);
  assert.equal(state.branchId, "b-urdesa");
});

test("PROG-07: en el paso cerrado, '¿a qué hora abren?' repite el horario y no cuenta como no entendido", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { last, state } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, "a qué hora abren",
  ]);
  assert.equal(last.decision, "R10:horario");
  assert.match(last.reply, /Atiende de 07:00 a 13:00/, last.reply);
  assert.equal(state.misunderstood || 0, 0);
});

test("PROG-08: cambiar de sucursal después de programar borra la programación", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { state } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, "prográmalo", "mejor para retirar",
  ]);
  assert.equal(state.scheduledFor, undefined, "lo programado era para la sucursal de delivery");
});

test("PROG-09: 'ahorita no puedo, prográmalo' PROGRAMA y no muda el pedido a la otra sucursal (ni le sube el envío)", async () => {
  for (const respuesta of ["ahorita no puedo, prográmalo", "hoy no, mejor mañana", "no, ahorita no, déjalo para mañana"]) {
    const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
    const { state, last } = await chat(deps, [
      "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, respuesta,
    ]);
    assert.equal(state.branchId, "b-urdesa", `"${respuesta}" no debe cambiar de sucursal`);
    assert.equal(state.scheduledFor, fakeNextOpening().at, `"${respuesta}" debe quedar programado`);
    assert.equal(state.deliveryFee, 2.5, `"${respuesta}" no debe cambiarle el envío`);
    assert.doesNotMatch(last.reply, /Samborondón/, last.reply);
    assert.match(last.reply, /programado para mañana/i, last.reply);
  }
});

test("PROG-10: 'la otra no, gracias' NO cambia a la otra sucursal", async () => {
  for (const respuesta of ["la otra no, gracias", "no quiero la otra", "de la otra no"]) {
    const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
    const { state, last } = await chat(deps, [
      "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, respuesta,
    ]);
    assert.equal(state.branchId, "b-urdesa", `"${respuesta}" no debe mudar el pedido`);
    assert.equal(state.deliveryFee, 2.5, `"${respuesta}" no debe cambiarle el envío`);
    assert.equal(state.scheduledFor, undefined, `"${respuesta}" tampoco programa solo`);
    assert.doesNotMatch(last.reply, /te atiende Samborondón/, last.reply);
    // Decir que no a una opción NO es quitar un producto (en producción "no quiero la otra" vació el carrito).
    assert.equal(state.cart.length, 1, `"${respuesta}" no debe tocar el carrito`);
    assert.equal(last.decision, "R10:sigue_cerrada", last.decision);
    assert.match(last.reply, /\*programo\* para mañana/i, last.reply);
  }
});

test("PROG-13: la urgencia explícita le gana a 'mañana' ('no puedo esperar hasta mañana' NO programa)", async () => {
  const { deps } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { state, last } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, "no puedo esperar hasta mañana",
  ]);
  assert.equal(state.scheduledFor, undefined, "no quiere esperar: no se programa");
  assert.equal(state.branchId, "b-samborondon", "se va con la sucursal abierta");
  assert.match(last.reply, /abierta ahorita/, last.reply);
});

test("PROG-11: una programación que ya pasó caduca sola: con el local ABIERTO el pedido sigue como inmediato", async () => {
  const { deps, created } = fakeDeps();
  const { state } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } },
    "Kennedy 123", "Ana", "ana@test.com", "efectivo",
  ]);
  // La sesión de anoche quedó programada para hoy a las 07:00 (ya pasó) y el checkout a medias.
  const vencido = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const viejo: BotState = { ...state, scheduledFor: vencido, scheduledLabel: "hoy a las 07:00", closedOffer: { branchId: state.branchId!, branchName: "Urdesa", nextOpeningAt: vencido, nextOpeningLabel: "hoy", opensAt: "07:00", closesAt: "13:00", alternative: null } };
  const confirmado = await handleTurn(viejo, { message: "confirmo" }, deps);
  assert.doesNotMatch(confirmado.reply, /ya pasó/i, confirmado.reply);
  assert.doesNotMatch(confirmado.reply, /Programado para/, confirmado.reply);
  assert.equal(created.length, 1, "la orden se crea, no se queda en bucle");
  assert.equal(created[0].scheduledFor, undefined, "no se manda una hora que ya pasó");
  assert.equal(confirmado.state.scheduledFor, undefined);
});

test("PROG-12: una programación que ya pasó con el local CERRADO se vuelve a ofrecer para la próxima apertura", async () => {
  const { deps, created } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { state } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } }, "prográmalo",
    "Kennedy 123", "Ana", "ana@test.com", "efectivo",
  ]);
  const vencido = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const viejo: BotState = { ...state, scheduledFor: vencido, scheduledLabel: "hoy a las 07:00", closedOffer: { ...state.closedOffer!, nextOpeningAt: vencido, nextOpeningLabel: "hoy" } };
  const revalidado = await handleTurn(viejo, { message: "confirmo" }, deps);
  assert.equal(created.length, 0, "no se crea una orden para una hora que ya pasó");
  assert.equal(revalidado.step, "closed", revalidado.reply);
  assert.match(revalidado.reply, /\*programo\* para mañana/i, revalidado.reply);
  const reprogramado = await handleTurn(revalidado.state, { message: "prográmalo" }, deps);
  assert.equal(reprogramado.state.scheduledFor, fakeNextOpening().at, "queda para la PRÓXIMA apertura");
});


// ─── "Pagado": verificación del pago con PayPhone ────────────────────────────

/** Pedido de TARJETA recién creado, listo para que el cliente escriba "pagado". */
async function cardOrder(options: FakeOptions = {}) {
  const fake = fakeDeps(options);
  const { state } = await chat(fake.deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "confirmo"]);
  return { ...fake, state };
}

test("PAGO-1: al crear la orden con tarjeta el bot pide escribir *pagado*", async () => {
  const { deps } = fakeDeps();
  const { last } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "confirmo"]);
  assert.match(last.reply, /escríbeme \*pagado\*/i, last.reply);
  assert.match(last.reply, /https:\/\/boloncity\.com\/pago/, last.reply);
});

test("PAGO-2: 'pagado' con el pago APROBADO responde total, cocina y aviso del motorizado", async () => {
  const { deps, state, settled } = await cardOrder({ settlement: { outcome: "paid_now", total: 12.5, deliveryType: "delivery", trackingUrl: "https://picker.test/smr/1" } });
  const result = await handleTurn(state, { message: "pagado" }, deps);
  assert.equal(settled.length, 1, "se consultó el pago una vez");
  assert.equal(settled[0], "ORD-00991");
  assert.equal(result.decision, "R7:pago_paid_now", result.decision);
  assert.match(result.reply, /Pago confirmado/i, result.reply);
  assert.match(result.reply, /\$12\.50/, result.reply);
  assert.match(result.reply, /cocina/i, result.reply);
  assert.match(result.reply, /motorizado/i, result.reply);
  assert.match(result.reply, /picker\.test/, result.reply);
  assert.equal(result.state.paymentConfirmed, true);
  assert.equal(result.state.lastOrderNumber, "ORD-00991", "la orden no se pierde");
});

test("PAGO-3: 'ya pague' (sin tilde, con typo) toma el mismo camino que 'pagado'", async () => {
  for (const frase of ["ya pague", "ya pagué", "listo pagué", "ya está pagado", "hice el pago", "pagué con tarjeta", "pagao", "listo amigo, ya pagué gracias"]) {
    const { deps, state, settled } = await cardOrder({ settlement: { outcome: "paid_now", total: 12.5 } });
    const result = await handleTurn(state, { message: frase }, deps);
    assert.equal(settled.length, 1, `"${frase}" no consultó el pago`);
    assert.equal(result.decision, "R7:pago_paid_now", `"${frase}" → ${result.decision}: ${result.reply}`);
  }
});

test("PAGO-4: si PayPhone dice PENDIENTE no se da por pagado, se reenvía el link y no se toca la orden", async () => {
  const { deps, state } = await cardOrder({ settlement: { outcome: "pending" } });
  const result = await handleTurn(state, { message: "pagado" }, deps);
  assert.equal(result.decision, "R7:pago_pending", result.decision);
  assert.match(result.reply, /Todavía no nos llega el pago/i, result.reply);
  assert.match(result.reply, /https:\/\/boloncity\.com\/pago/, result.reply);
  assert.match(result.reply, /\*pagado\* otra vez/i, result.reply);
  assert.doesNotMatch(result.reply, /Pago confirmado|cocina/i, result.reply);
  assert.equal(result.state.paymentConfirmed, undefined, "no se marca como pagada");
  assert.equal(result.state.stage, "ordered");
  assert.equal(result.state.lastOrderNumber, "ORD-00991");
});

test("PAGO-5: pago RECHAZADO se dice claro y se reenvía el link", async () => {
  const { deps, state } = await cardOrder({ settlement: { outcome: "rejected" } });
  const result = await handleTurn(state, { message: "pagado" }, deps);
  assert.equal(result.decision, "R7:pago_rejected", result.decision);
  assert.match(result.reply, /no se completó/i, result.reply);
  assert.match(result.reply, /https:\/\/boloncity\.com\/pago/, result.reply);
  assert.equal(result.state.paymentConfirmed, undefined);
});

test("PAGO-6: 'pagado' dos veces no duplica nada (la segunda responde 'ya está confirmado')", async () => {
  const { deps, state, settled } = await cardOrder({ settlement: [{ outcome: "paid_now", total: 12.5 }, { outcome: "already_paid", total: 12.5 }] });
  const primero = await handleTurn(state, { message: "pagado" }, deps);
  const segundo = await handleTurn(primero.state, { message: "pagado" }, deps);
  assert.equal(settled.length, 2, "cada mensaje consulta el estado, no crea nada");
  assert.equal(segundo.decision, "R7:pago_already_paid", segundo.decision);
  assert.match(segundo.reply, /ya está confirmado/i, segundo.reply);
  assert.equal(segundo.state.lastOrderNumber, "ORD-00991", "no se creó otra orden");
});

test("PAGO-7: un error técnico no da el pago por hecho", async () => {
  const { deps, state } = await cardOrder({ settlement: { outcome: "error" } });
  const result = await handleTurn(state, { message: "pagado" }, deps);
  assert.equal(result.decision, "R7:pago_error", result.decision);
  assert.match(result.reply, /No pude verificar tu pago/i, result.reply);
  assert.equal(result.state.paymentConfirmed, undefined);
});

test("PAGO-8: después del pago, 'mi pedido' sigue mostrando estado y seguimiento", async () => {
  const { deps, state } = await cardOrder({ settlement: { outcome: "paid_now", total: 12.5 } });
  const pagado = await handleTurn(state, { message: "pagado" }, deps);
  const seguimiento = await handleTurn(pagado.state, { message: "mi pedido" }, deps);
  assert.equal(seguimiento.decision, "R3:consultar_pedido", seguimiento.decision);
  assert.equal(seguimiento.intent, "consultar_pedido");
  assert.match(seguimiento.reply, /En camino/, seguimiento.reply);
});

test("PAGO-9: 'listo pagué' NO cae en R7:ya_confirmado y classifyRoute lo manda a conversación", async () => {
  const { deps, state } = await cardOrder({ settlement: { outcome: "pending" } });
  const result = await handleTurn(state, { message: "listo pagué" }, deps);
  assert.equal(result.decision, "R7:pago_pending", result.decision);
  assert.equal(classifyRoute(state, "listo pagué"), "conversation");
  assert.equal(classifyRoute(state, "pagado"), "conversation");
  assert.equal(classifyRoute(state, "ya pague"), "conversation");
  // Un "confirmo" repetido sigue siendo checkout idempotente: el reclamo de pago no rompió eso.
  assert.equal(classifyRoute(state, "confirmo"), "checkout");
});

test("PAGO-10: 'quiero pagar', 'cómo pago' y 'el link no me abre' NO disparan la verificación", async () => {
  for (const frase of ["quiero pagar", "cómo pago", "el link no me abre", "¿ya te llegó el pago?", "pásame el link de pago", "todavía no he pagado"]) {
    assert.equal(claimsPaid(frase), false, `"${frase}" no debería reclamar un pago hecho`);
    const { deps, state, settled } = await cardOrder();
    const result = await handleTurn(state, { message: frase }, deps);
    assert.equal(settled.length, 0, `"${frase}" consultó PayPhone sin motivo → ${result.decision}`);
  }
});

test("PAGO-11: efectivo con delivery dice cuánto se le paga al motorizado", async () => {
  const { deps } = fakeDeps();
  const { last } = await chat(deps, [
    "una humita", "delivery", { location: { lat: -2.180796, lng: -79.874258 } },
    "Kennedy 123", "Ana", "ana@test.com", "efectivo", "confirmo",
  ]);
  assert.match(last.reply, /Págale \$12\.50 en efectivo al motorizado/, last.reply);
  assert.doesNotMatch(last.reply, /escríbeme \*pagado\*/i, "en efectivo no hay nada que verificar");
});

test("PAGO-12: 'pagado' sin una orden creada no consulta nada", async () => {
  const { deps, settled } = fakeDeps();
  const { last } = await chat(deps, ["una humita", "pagado"]);
  assert.equal(settled.length, 0, `se consultó PayPhone sin orden → ${last.decision}`);
});

test("PAGO-13: una venta con id pero SIN aprobar deja el pedido pendiente (nunca se cancela a medio pago)", async () => {
  // El cliente abrió la Cajita y aún no termina: PayPhone ya tiene la transacción, pero en estado 1.
  assert.deepEqual(decideFromSale({ found: true, statusCode: 1, transactionStatus: "Pending", transactionId: 99 }).next, "pending");
  assert.deepEqual(decideFromSale({ found: true, statusCode: 1, transactionId: 99 }).next, "pending");
  // Nunca abrió la Cajita, o PayPhone no respondió.
  assert.deepEqual(decideFromSale({ found: false, error: "timeout" }).next, "pending");
  assert.deepEqual(decideFromSale({ found: true, statusCode: 1 }).next, "pending");
  // Cancelada de verdad y sin nada que confirmar.
  assert.deepEqual(decideFromSale({ found: true, statusCode: 2, transactionStatus: "Canceled" }).next, "rejected");
  // Aprobada: recién ahí se confirma, con su id numérico.
  const aprobada = decideFromSale({ found: true, statusCode: 3, transactionStatus: "Approved", transactionId: 12345 });
  assert.equal(aprobada.next, "confirm");
  assert.equal(aprobada.next === "confirm" && aprobada.transactionId, 12345);
});

test("con el local cerrado y DOS opciones, 'confirmo' explica que primero hay que elegir", async () => {
  // Hay otra sucursal abierta que cubre: un "confirmo" no dice cuál de las dos quiere.
  const { deps, created } = fakeDeps({ closedBranches: ["b-urdesa"] });
  const { state, last } = await chat(deps, ["una humita", "delivery", { location: { lat: -2.15, lng: -79.9 } }, "confirmo"]);
  assert.equal(state.stage, "closed");
  assert.match(last.reply, /primero dime cómo lo quieres/i, last.reply);
  assert.equal(created.length, 0, "no se crea la orden con el local cerrado");
});

test("retiro con el local cerrado: 'dale' programa cuando es lo único ofrecido", async () => {
  const { deps } = fakeDeps({ closed: true });
  const { state, last } = await chat(deps, ["una humita", "retiro", "1", "dale"]);
  assert.ok(state.scheduledFor, "debió quedar programado");
  assert.match(last.reply, /queda programado para/i, last.reply);
});

test("preguntas frecuentes: horarios, dirección, envío, promos, factura y pagos se responden", async () => {
  assert.equal(faqTopic("hasta que hora abren?"), "horario");
  assert.equal(faqTopic("cual es la direccion del local de urdesa"), "direccion");
  assert.equal(faqTopic("cuanto cuesta el envio?"), "envio");
  assert.equal(faqTopic("tienen promociones?"), "promos");
  assert.equal(faqTopic("hacen factura?"), "factura");
  assert.equal(faqTopic("puedo pagar con tarjeta?"), "pagos");
  assert.equal(faqTopic("me pueden llamar?"), "llamada");
  // Un pedido NO es una pregunta frecuente, aunque nombre la factura.
  assert.equal(faqTopic("quiero 2 humitas"), null);
  assert.equal(faqTopic("aceptan cupones?"), null, "no es una pregunta de medios de pago");

  const { deps } = fakeDeps();
  const horario = await handleTurn(createInitialState("+593999"), { message: "¿hasta qué hora abren?" }, deps);
  assert.equal(horario.decision, "R9:pregunta_frecuente", horario.reply);
  assert.match(horario.reply, /\d{2}:\d{2}/, "dice horas reales");

  const factura = await handleTurn(createInitialState("+593999"), { message: "¿hacen factura?" }, deps);
  assert.match(factura.reply, /factura/i);

  // Con factura pedida, la cédula sigue siendo la respuesta al paso (no una pregunta frecuente).
  const { state } = await chat(deps, ["una humita con factura", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "0912345675"]);
  assert.equal(state.billingDocNumber, "0912345675");
});

test("una pregunta no elige forma de pago ni tipo de entrega", async () => {
  const { deps } = fakeDeps();
  const preguntas = await chat(deps, ["una humita", "¿puedo pagar mitad en efectivo y mitad con tarjeta?", "¿hacen delivery a Samborondón?"]);
  assert.equal(preguntas.state.paymentMethod, undefined, "no se fija el pago por preguntar");
  assert.equal(preguntas.state.deliveryType, undefined, "no se fija la entrega por preguntar");
  // En el paso donde el bot SÍ pregunta eso, responder con una pregunta sigue eligiendo.
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "¿con tarjeta?"]);
  assert.equal(state.paymentMethod, "card");
});

test("pedir repetir encuentra el último pedido aunque la tarjeta siga sin pagar", async () => {
  const pedido = { orderNumber: "ORD-00099", createdAt: new Date(), items: [{ productId: "p1", name: "HUMITA", quantity: 2 }], deliveryType: "pickup" as const };
  const vistos: Array<{ includeUnpaid?: boolean }> = [];
  const { deps } = fakeDeps({ lastOrder: pedido });
  const original = deps.lastOrder;
  deps.lastOrder = async (phone, options) => {
    vistos.push(options || {});
    return original(phone, options);
  };
  const { last } = await chat(deps, ["quiero lo mismo de la ultima vez"]);
  assert.ok(vistos.some((opciones) => opciones.includeUnpaid), "al pedir repetir se buscan también las no pagadas");
  assert.match(last.reply, /ORD-00099/, last.reply);
});

test("'pagado' en un pedido en EFECTIVO explica que se paga al recibir", async () => {
  const { deps } = fakeDeps({ settlement: { outcome: "not_applicable" } });
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo", "confirmo"]);
  const result = await handleTurn(state, { message: "pagado" }, deps);
  assert.match(result.reply, /es en efectivo/i, result.reply);
  assert.doesNotMatch(result.reply, /No pude verificar/i, result.reply);
});

test("el bot SIEMPRE responde algo: ningún turno puede salir en blanco", async () => {
  const { deps } = fakeDeps();
  const mensajes = ["", "   ", "?", "🙂", "{body}", "asdkjh", "...", "1", "ok", "hola", "el verde", "mi pedido", "menu"];
  for (const message of mensajes) {
    const result = await handleTurn(createInitialState("+593999"), { message }, deps);
    assert.ok(result.reply && result.reply.trim().length > 0, `sin respuesta para ${JSON.stringify(message)}`);
  }
  // Y en medio de un pedido, con una elección abierta, tampoco.
  const { deps: deps2 } = fakeDeps();
  const { state } = await chat(deps2, ["un bolon"]);
  for (const message of ["", "??", "🙃", "xyz"]) {
    const result = await handleTurn(state, { message }, deps2);
    assert.ok(result.reply && result.reply.trim().length > 0, `sin respuesta con elección abierta para ${JSON.stringify(message)}`);
  }
  assert.ok(FALLBACK_MESSAGE.trim().length > 0);
});

test("después del pedido, un '?' o un emoji no responden '¡Gracias a ti!'", async () => {
  const { deps } = fakeDeps();
  const { state } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "tarjeta", "confirmo"]);
  for (const message of ["?", "😀", "👋"]) {
    const result = await handleTurn(state, { message }, deps);
    assert.ok(result.reply.trim().length > 0, message);
    assert.doesNotMatch(result.reply, /Gracias a ti/i, `${message} no es un agradecimiento`);
  }
  const gracias = await handleTurn(state, { message: "gracias" }, deps);
  assert.match(gracias.reply, /Gracias a ti/i);
});

(async () => {
  let failed = 0;
  for (const [name, run] of tests) {
    try {
      await run();
      console.log(`✅ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`❌ ${name}\n   ${error instanceof Error ? error.message.split("\n").join("\n   ") : error}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} pruebas pasaron`);
  process.exit(failed ? 1 : 0);
})();
