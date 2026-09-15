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
import { CatalogProduct, rankProducts } from "../services/whatsappBot/catalog";
import { heuristicExtract } from "../services/whatsappBot/extractor";
import { splitItemPhrases } from "../services/whatsappBot/intents";
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
}

function fakeDeps(options: FakeOptions = {}) {
  const created: BotState[] = [];
  const deps: BotDeps = {
    search: async (query, branchId) => rankProducts(query, branchId ? MENU.filter((p) => !options.unavailableAtBranch?.includes(p.name)) : MENU),
    catalog: async (branchId) => (branchId ? MENU.filter((p) => !options.unavailableAtBranch?.includes(p.name)) : MENU),
    lastOrder: async () => options.lastOrder ?? null,
    resolveMapsUrl: async () => ({ lat: -2.15, lng: -79.9 }),
    quoteLocation: async () =>
      options.covered === false
        ? { covered: false, reason: "Todavía no llegamos a esa dirección con delivery" }
        : { covered: true, branchId: "b-urdesa", branchName: "Urdesa", deliveryFee: 2.5, distance: 3.1 },
    pickupBranches: async () => [
      { branchId: "b-urdesa", name: "Urdesa", address: "Av. Víctor Emilio Estrada" },
      { branchId: "b-samborondon", name: "Samborondón", address: "Km 2.5" },
    ],
    branchStatus: async () => (options.closed ? { open: false, message: "Urdesa está cerrada en este momento. Abre a las 07:00" } : { open: true }),
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
    extract: heuristicExtract,
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
  assert.doesNotMatch(hola.reply, /No tenemos/, "un saludo no se busca como producto");
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
  assert.match(local.reply, /lo retiras en Samborondón/);
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
  assert.match(last.reply, /retirarlo en el local/);
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
  assert.match(results[0].reply, /categorías/);
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

test("dos mensajes seguidos sin entender: deriva al número de soporte", async () => {
  const { deps } = fakeDeps();
  const { results } = await chat(deps, ["asdfgh", "¿ustedes hacen catering para 200 personas?"]);
  assert.equal(results[0].intent, "conversar", "el primero todavía se intenta resolver aquí");
  assert.equal(results[1].intent, "dudas");
  assert.match(results[1].reply, /\+593 99 315 7333/);
});

test("después de crear la orden, un mensaje nuevo arranca otro pedido conservando los datos", async () => {
  const { deps } = fakeDeps();
  const { state, last } = await chat(deps, ["una humita", "retiro", "1", "Ana", "ana@test.com", "efectivo", "confirmo", "quiero un corviche"]);
  assert.deepEqual(state.cart.map((item) => item.name), ["CORVICHE"]);
  assert.equal(state.customerEmail, "ana@test.com");
  assert.equal(last.step, "delivery_type");
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
