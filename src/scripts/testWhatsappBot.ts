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
import axios from "axios";
import { env } from "../config/env";
import { aiExtract, Extractor, heuristicExtract } from "../services/whatsappBot/extractor";
import { classifyConfirmReply, extractDocNumber, extractOrderNumber, isPlainConfirmation, isQuestion, isSmallTalk, splitItemPhrases, titleCaseName, wantsHuman, wantsTracking } from "../services/whatsappBot/intents";
import { botResponseRoute, isDuplicateTurn, isRetry, latestUserMessage, pendingKey, toE164, turnHash, turnRecord } from "../controllers/whatsappBot.controller";
import { isBotPath } from "../app";
import { BotDeps, BotState, classifyRoute, createInitialState, handleTurn, LastOrder, TurnResult } from "../services/whatsappBot/router";

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
  extract?: Extractor;
}

function fakeDeps(options: FakeOptions = {}) {
  const created: BotState[] = [];
  const deps: BotDeps = {
    search: async (query, branchId) => rankProducts(query, branchId ? MENU.filter((p) => !options.unavailableAtBranch?.includes(p.name)) : MENU),
    catalog: async (branchId) => (branchId ? MENU.filter((p) => !options.unavailableAtBranch?.includes(p.name)) : MENU),
    lastOrder: async () => options.lastOrder ?? null,
    resolveMapsUrl: async () => ({ lat: -2.15, lng: -79.9 }),
    quoteLocation: async (_coords, paymentMethod) =>
      options.covered === false
        ? { covered: false, reason: "Todavía no llegamos a esa dirección con delivery" }
        : { covered: true, branchId: "b-urdesa", branchName: "Urdesa", deliveryFee: paymentMethod === "cash" && options.cashFee ? options.cashFee : 2.5, distance: 3.1 },
    pickupBranches: async () => [
      { branchId: "b-urdesa", name: "Urdesa", address: "Av. Víctor Emilio Estrada" },
      { branchId: "b-samborondon", name: "Samborondón", address: "Km 2.5" },
    ],
    branchStatus: async (branchId) =>
      options.closed || options.closedBranches?.includes(branchId) ? { open: false, message: "Urdesa está cerrada en este momento. Abre a las 07:00" } : { open: true },
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
    trackOrder: async () => "Pedido ORD-00123 · En camino",
    extract: options.extract || heuristicExtract,
    menuUrl: "https://boloncity.com/catalogo",
    supportPhone: "+593 99 315 7333",
  };
  return { deps, created };
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
  assert.match(results[3].reply, /3 x Humita\n1 x Tostada Mixta/);
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

test("sucursal cerrada: no deja confirmar", async () => {
  const { deps, created } = fakeDeps({ closed: true });
  const { last } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo", "confirmo"]);
  assert.match(last.reply, /cerrada/);
  assert.equal(created.length, 0);
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
  assert.equal(results[1].decision, "R11:ayuda");
  assert.match(results[1].reply, /men\u00fa/);
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

test("ubicación mientras se elige local: pasa a delivery y no deja la elección pendiente", async () => {
  const { deps } = fakeDeps();
  const { state, last } = await chat(deps, ["una humita", "retiro", { location: { lat: -2.15, lng: -79.89 } }, "1"]);
  assert.equal(state.deliveryType, "delivery");
  assert.equal(state.branchId, "b-urdesa", "la sucursal es la que cotizó Picker, no la opción 1 de retiro");
  assert.notEqual(last.decision, "R4:eleccion_sucursal");
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
