# Bot de WhatsApp: plan de salida a producción

Fecha de revisión: 2026-09-13. Se revisaron `whatsappBot.controller.ts`, `order.controller.ts` (createOrder, confirmOrder),
`deliveryQuote.service.ts`, `branchOperational.service.ts`, el checkout del frontapp (`useCheckout.ts`,
`WhatsAppPaymentView.vue`, `CheckoutResponseView.vue`) y el repo de referencia `sorbito-de-verdad-backapp`.

## 0. Reglas de negocio del bot

| Tipo de pedido | Tarjeta (link PayPhone) | Efectivo | Transferencia |
|---|---|---|---|
| Delivery | ✅ | ✅ se paga al motorizado, con aviso de deuda | ❌ se redirige a efectivo o tarjeta |
| Retiro en local | ✅ | ✅ se paga al retirar | ❌ se redirige a efectivo o tarjeta |

Esto es igual a la web actual, que permite efectivo en delivery y en retiro (`CheckoutPaymentMethod.vue:16-28`).

**Aviso obligatorio al elegir efectivo en delivery, o si el cliente pide transferencia:**
> "Por WhatsApp no recibimos transferencias. Puedes pagar con tarjeta por link o en efectivo al motorizado.
> Si eliges efectivo y no estás al llegar el motorizado, el costo del envío ($X) se sumará a tu próxima compra."

El registro de pedidos y la deuda se explican en la sección 2.5.

Todo lo demás debe ser idéntico a la web: precio por sucursal, promo, IVA, puntos, cobertura de Picker, horario,
RunFood, Meta, correos y teléfono E.164.

## 1. Arquitectura objetivo

```
WhatsApp ⇄ BuilderBot Cloud (flujos + textos)
                │ HTTP (header x-bot-secret)
                ▼
  /api/orders/whatsapp-bot/*  ── sesión (WhatsAppSession) + reglas del bot
                │
                ▼
  services/orderCreation.service.ts  ← MISMA función que usa POST /api/orders (web)
                │
     ┌──────────┼─────────────┬──────────────┐
  PayPhone   Picker        RunFood       Meta / Resend
  (/pago)   (cobertura,    (comanda)
             booking)
```

**Principio:** el bot NO crea órdenes por su cuenta. Arma el mismo input que manda el checkout web y llama al
servicio compartido. Así cualquier arreglo futuro de la web también llega al bot.

## 2. Hallazgos (lo que hoy rompería o bloquearía)

### Bloqueantes (sin esto no se lanza)

| # | Problema | Dónde | Impacto |
|---|---|---|---|
| B1 | `createBotOrder` duplica `createOrder` y le faltan pasos: no envía **RunFood** en efectivo, no reporta Meta, no manda correo, `pointsEarned`=0, `tax`=0, no valida horario | `whatsappBot.controller.ts:604-670` | La cocina no recibe pedidos en efectivo; el cliente no gana puntos |
| B2 | El bot usa su **propio `quoteDelivery`** sin cobertura, sin tope de km ni `paymentMethod` | `whatsappBot.controller.ts:184-198` | Repite ORD-00110 (envío absurdo) y acepta direcciones fuera de zona |
| B3 | Efectivo en delivery sin aviso ni consecuencia: si el cliente no aparece, Picker reporta `NOT_DELIVERED`/`RETURNED`, la orden queda en `ready` para siempre y el local paga el envío | `webhook.controller.ts:8-23` | Pérdida por cada cliente ausente, sin rastro |
| B4 | **No existe retiro en local** en el bot: exige ubicación siempre | `whatsappBotBrain` / `collectMissing` | No se puede cumplir "efectivo en el local" |
| B5 | Teléfono sin E.164 (`normalizePhone` propio, sin +593) | `whatsappBot.controller.ts:138` | Picker responde 422 (repite ORD-00152) |
| B6 | Si la sucursal está **cerrada**, el bot crea la orden igual | falta `isBranchOpenAt` | Pedido que nadie prepara |
| B7 | Catálogo del bot ignora `unavailableBranches` / `branches` del producto | `buildCatalog`, `resolveBotItems` | Ofrece productos agotados en esa sucursal |
| B8 | **Pago rechazado = orden `cancelled`** y el link muere. El botón "Intentar de nuevo" lleva a `/checkout` (carrito vacío) | `order.controller.ts:799-825`, `CheckoutResponseView.vue:164` | El cliente de WhatsApp queda sin forma de reintentar |
| B9 | Checkout sin idempotencia: 2 llamadas de BBC = 2 órdenes; si falla responde `message: ""` | `whatsappBotCheckout` | Órdenes duplicadas / bot mudo |
| B10 | `getFrontendUrl()` depende de `APP_ENV`. Si falta en Vercel → link de pago a `http://localhost:5173` | `config/env.ts` | Links de pago rotos |
| B11 | Tiempos: `preCheckout` de Picker **sin timeout**, Gemini hasta 25 s × 2 llamadas por mensaje, RunFood 7 s × 2 | services | Supera el timeout del nodo HTTP de BBC / de Vercel → el bot no responde |

### Importantes (antes o justo después del lanzamiento)

| # | Problema | Impacto |
|---|---|---|
| I1 | Endpoints `/whatsapp-bot/*` públicos sin secreto | Cualquiera crea órdenes |
| I2 | `track` / `search-order` buscan por **cualquier email** que se escriba | Fuga de pedidos de otros clientes |
| I3 | Regla inventada "más de $50 requiere factura" (la web no la tiene) | Pide datos que la web no pide; mata conversión |
| I4 | Sin dedup de mensajes (Sorbito BUG 2); `lastMessageHash` existe pero no se usa | Respuestas dobles |
| I5 | Órdenes con tarjeta `pending` nunca expiran | Basura en el admin, doble link |
| I6 | `/pago` manda `amount = amountWithTax = total` sin desglose de IVA (la web sí desglosa) | Funciona, pero la contabilidad de PayPhone difiere de la web: validar con un pago real |
| I7 | Documento de factura no se valida (10/13 dígitos) en el bot | Datos inválidos para contabilidad |
| I8 | `vercel.json` tiene cron `/api/cron/payment-reminders` que no existe (copiado de Sorbito) | Ruido de 404 cada 5 min |

### Qué NO copiar de Sorbito
- Fallback que toma el **carrito más reciente de otro teléfono** (`recentCarts` en `whatsappBotCheckout`): fuga de datos.
- Bloques `if (true)` que crean órdenes con datos incompletos.
- Notificaciones proactivas por WhatsApp (violan la política; Sorbito las eliminó).

### Qué SÍ copiar de Sorbito
- Dedup por hash de teléfono + mensaje (5 s).
- Verificar orden pendiente antes de crear otra (BUG 12).
- Backend decide; BBC solo enruta y muestra.
- `add_http` siempre con `rules` (aunque sea `[]`).

## 2.4 Catálogo con muchos productos (sin un system prompt gigante)

Hoy `callGemini` mete **todo** el catálogo en cada mensaje (`whatsappBot.controller.ts:284`). Con unos 191 productos
eso es lento (empeora B11), caro y la IA inventa. El nuevo diseño es: **el backend busca, la IA solo conversa.**

```
Cliente: "quiero 2 bolones mixtos y un café"
  1. Gemini (prompt fijo y corto) solo EXTRAE:
     { intent: "add_items", items: [{ query: "bolón mixto", qty: 2 }, { query: "café", qty: 1 }] }
  2. Backend: searchProducts(query, branchId) → Mongo sobre name, tags y categoría,
     solo productos disponibles en esa sucursal (isAvailableAt) → máximo 5 candidatos
  3. 1 candidato claro → al carrito de la sesión con productId real
     Varios → el bot pregunta cuál ("¿Bolón mixto de queso o de chicharrón?")
     Ninguno → "No tenemos eso" + 3 sugerencias de la misma categoría
  4. Precios, promo, IVA, envío y deuda: SIEMPRE los calcula el backend (servicio compartido)
```

- El system prompt tiene tamaño fijo (tono, reglas y esquema JSON) y no crece con el menú.
- La IA solo ve los candidatos de la búsqueda puntual, nunca el catálogo entero.
- "¿Qué tienen?" → categorías → productos de la categoría elegida (máximo 8), más el link del menú web.
- Búsqueda: normalizar acentos y minúsculas, índice de texto en `name` + `tags`, y agregar a `tags` los sinónimos
  (ej. "bolon", "bolón", "mixto"). Fallback con regex por palabra si el índice de texto no encuentra nada.
- Carrito en `WhatsAppSession.data.items` con `productId`. Cambios ("quita el café", "que sean 3") llegan como
  operaciones `add` / `remove` / `set_qty`, no como carrito completo reescrito por la IA.

## 2.5 Registro de pedidos y deuda de envío por cliente ausente

### Qué se guarda
Colección nueva `Customer`, con el **teléfono E.164 como clave**. Un pedido en efectivo no crea `User`, así que no se
puede colgar de la cuenta. Se enlaza por email cuando existe.

```
Customer {
  phone (E.164, único), emails[], name, userId?,
  stats: { orders, paidOrders, cancelled, noShows, abandonedCheckouts, lastOrderAt },
  debts: [{ order, orderNumber, amountCents (= deliveryCost), reason: "no_show",
            status: "pending" | "charged" | "settled" | "forgiven",
            chargedInOrder?, createdAt, createdBy ("picker" | email admin), forgivenBy?, note? }],
  events: [{ type, orderNumber?, channel: "web" | "whatsapp", detail, at }]   // últimos 200
}
```

`events.type` puede ser: `order_created`, `paid`, `delivered`, `cancelled`, `no_show`, `debt_charged`, `debt_settled`,
`debt_forgiven` o `checkout_abandoned`.

### Cuándo nace una deuda
1. **Automático:** el webhook de Picker reporta `NOT_DELIVERED` o `RETURNED` en un pedido **efectivo + delivery**.
   Se crea la deuda `pending` por `order.deliveryCost` y la orden se marca con audit "Cliente ausente".
2. **Manual:** botón en el detalle de la orden del admin, "Cliente no apareció", solo para admin general (igual que
   cancelar) y con motivo obligatorio.
3. **Perdonar:** botón "Anular deuda" con motivo, por si el motorizado se equivocó.

No hay deuda en tarjeta (ya pagó) ni en retiro en local (no hubo envío).

### Cómo se cobra en la próxima compra (web y bot, en el servicio compartido)
- Al crear una orden se buscan deudas `pending` por teléfono o email y se guardan en un campo nuevo
  `order.debtCharge = { amount, debtIds[], label: "Envío no pagado ORD-xxxxx" }`. El total queda
  `total = productos − promo + envío + deuda − canje`.
- **No va como ítem:** RunFood rechaza renglones sin SKU (`runfood.service.ts`). En su lugar:
  - RunFood: el título de la comanda agrega `+ COBRAR ENVÍO PENDIENTE $X`.
  - Picker CASH: `orderAmount` incluye la deuda, así el motorizado la cobra.
  - PayPhone: entra en el total del link o de la cajita.
- La deuda pasa a `charged` al crear la orden. Pasa a `settled` cuando esa orden llega a `paid` (tarjeta) o
  `delivered` (efectivo). Si esa orden se cancela, **vuelve a `pending`**.
- Los puntos no se calculan sobre la deuda.
- El bot y la web muestran la línea en el resumen antes de confirmar: "Incluye $X de un envío anterior no recibido".

### Intentos sin terminar
Se registra `checkout_abandoned` con un motivo cuando:
- el bot mostró el resumen y la sesión expiró sin orden (cron diario que revisa sesiones con resumen y sin
  `orderNumber`, **antes** del TTL de 24 h);
- el checkout falló por `BRANCH_CLOSED`, `DELIVERY_OUT_OF_COVERAGE` o `PRODUCTS_UNAVAILABLE` (se guarda el código);
- la orden con tarjeta quedó `pending` más de 60 min o el pago fue rechazado.

### Admin
- `/admin/clientes`: hoy lista `User` con puntos. Se agrega la pestaña **Historial y deudas** (fuente `Customer`),
  con búsqueda por teléfono, nombre o email y columnas pedidos, pagados, no-shows, abandonados, deuda pendiente y
  último pedido. El detalle muestra la línea de tiempo de `events` y las deudas con el botón "Anular".
- Detalle y kanban de órdenes: badge **"Cliente con deuda $X / N ausencias"** para que el cajero lo vea antes de
  despachar un efectivo.
- Endpoints: `GET /api/customers` y `GET /api/customers/:phone` (adminOnly), `POST /api/orders/:id/no-show`,
  `POST /api/customers/:phone/debts/:debtId/forgive`.

### Decisiones abiertas
- ¿Bloquear el efectivo en delivery a partir de N ausencias (ej. 2) y dejar solo tarjeta o retiro? Recomendado: sí,
  configurable en Settings.
- La deuda aplica también a la web (recomendado; si no, el cliente la esquiva pidiendo por la web).

## 3. Plan de implementación

### Fase 1: servicio compartido de creación de órdenes (B1, B2, B5, B6)
1. Crear `src/services/orderCreation.service.ts` con `createOrderFromInput(input, { source })`, que devuelve
   `{ ok: true, order }` o `{ ok: false, status, code, message, extra }`.
   - Mover **tal cual** la lógica de `createOrder` (líneas 131-436): resolveBranch, horario/programado, billing,
     `quoteDelivery` compartido, productos, promo, IVA, puntos, canje, Counter, Picker CASH, RunFood, Meta y correo.
   - Mover también `bookPickerForOrder`, `sendOrderToRunfood` y `reportPurchaseToMeta` (hoy son privados del controller)
     a servicios exportados; `confirmOrder` y `updateOrderStatus` los importan desde ahí.
2. `createOrder` (web) queda como adaptador: `req.body` → servicio → `res.status(status).json(...)`.
   **Mismos códigos y mensajes de error** (`BRANCH_CLOSED`, `DELIVERY_OUT_OF_COVERAGE`, `PRODUCTS_UNAVAILABLE`,
   `DELIVERY_LOCATION_REQUIRED`, `EMPTY_ORDER`). El front no debe notar ningún cambio.
3. Guardar `source: "whatsapp"` desde el servicio.
4. Validación: `npx tsc --noEmit` y un pedido web de prueba (tarjeta delivery, efectivo pickup) en dev para confirmar
   que la web no cambió.

### Fase 2: reglas y flujo del bot sobre el servicio (B3, B4, B7, B9, I3, I7)
1. Sesión (`WhatsAppSession.data`): agregar `deliveryType` (delivery|pickup, sin default), `branch` elegido para pickup,
   `orderNumber`/`orderId` de la orden ya creada y `customerPhoneE164`.
2. Paso "¿delivery o retiro en local?" antes de la ubicación:
   - **Delivery:** ubicación nativa o link de Maps → misma lógica que `getDeliveryPreCheckout`: recorrer sucursales de
     cerca a lejos hasta una con `covered` (extraer a una función compartida con `delivery.controller.ts`).
     Si ninguna cubre: ofrecer retiro en local.
   - **Pickup:** listar `GET /branches/public` (mismo filtro que la web). Si mandó ubicación, sugerir la más cercana.
3. Horario: al elegir sucursal, si `!isBranchOpenAt` → responder con `nextOpening.opensAt` y **no seguir**.
   Los programados se dejan fuera del bot en v1 (la web los soporta; se agregan en fase 5 si se quiere).
4. Catálogo filtrado por sucursal con la misma regla `isAvailableAt` de `product.controller.ts:204` (exportarla).
5. Método de pago según la tabla de la sección 0: tarjeta o efectivo en ambos tipos; transferencia → aviso y redirigir.
   Efectivo + delivery → aviso de deuda por ausencia (texto de la sección 0) antes del resumen.
   Si el cliente tiene deuda pendiente → la línea aparece en el resumen.
6. Facturación igual que la web: por defecto consumidor final; factura solo si el cliente la pide, con cédula de
   10 dígitos o RUC de 13. **Eliminar la regla de $50.**
7. `whatsappBotCheckout`:
   - Si la sesión ya tiene `orderNumber` con estado `pending` → devolver esa orden y el mismo link (idempotente).
   - Lock simple: `findOneAndUpdate({ phone, checkoutLock: { $ne: true } }, { checkoutLock: true })` para evitar la carrera.
   - Llamar `createOrderFromInput` con el mismo shape del web (`items[{productId,quantity}]`, `deliveryGoogleMapsUrl`
     construido como `https://www.google.com/maps/search/?api=1&query=LAT,LNG`, `branchId` en pickup).
   - Error → `message` humano desde `code` (nunca vacío) y `success:false`.
   - Éxito tarjeta → `paymentLink = ${frontend}/pago/${orderNumber}?email=...`.
     Éxito efectivo → mensaje "pagas al retirar en {sucursal}".
   - **No borrar la sesión** al crear: marcar `orderNumber` (la TTL de 24 h la limpia).
8. Borrar `quoteDelivery`, `findNearestBranch`, `resolveBotItems` y `createBotOrder` del controller del bot.

### Fase 2b: catálogo por búsqueda (sección 2.4)
1. `services/productSearch.service.ts`: `searchProducts(query, branchId, limit=5)` y `listCategoriesForBranch(branchId)`.
2. Índice de texto en `Product` (`name`, `tags`) y un script para cargar sinónimos en `tags`.
3. Prompt de Gemini reescrito: solo extracción a JSON (`intent`, `items[{query,qty,op}]`, datos del cliente).
   Sin catálogo en el prompt.
4. Carrito con operaciones `add` / `remove` / `set_qty` en la sesión.

### Fase 2c: registro de clientes y deuda (sección 2.5)
1. Modelo `Customer` y servicio `customerLedger.service.ts` (`recordEvent`, `getPendingDebts`, `chargeDebts`,
   `settleDebts`, `releaseDebts`, `forgiveDebt`, `registerNoShow`).
2. Campo `debtCharge` en `Order`. El servicio compartido suma la deuda al total; RunFood (título), Picker
   (`orderAmount`) y PayPhone la incluyen.
3. Ganchos: crear orden → `order_created` + `chargeDebts`; `confirmOrder` aprobado → `paid` + `settleDebts`;
   `updateOrderStatus` delivered → `settleDebts` y cancelled → `releaseDebts`; webhook Picker `NOT_DELIVERED`/`RETURNED`
   en efectivo → `registerNoShow`.
4. Endpoints admin y botones (no-show, anular deuda), pestaña **Historial y deudas** en `/admin/clientes` y badge en
   órdenes.
5. Cron diario de checkouts abandonados, que reemplaza el cron roto de `vercel.json`.
6. Backfill: script que recorre las órdenes existentes y arma `Customer.stats` y `events`, sin crear deudas retroactivas.

### Fase 3: reintento de pago y link (B8, B10, I5, I6)
1. Endpoint `POST /api/orders/whatsapp-bot/payment-link`: si la última orden del teléfono es tarjeta y `cancelled` por
   pago rechazado (audit `PayPhone status`), **clonar** a una orden nueva `pending` (nuevo `orderNumber` y
   `clientTransactionId`) y devolver el link nuevo. No reabrir la orden cancelada: el `clientTransactionId` ya se usó.
2. Front `CheckoutResponseView.vue`: si la orden tiene `source === "whatsapp"`, el botón de error dice
   "Vuelve a WhatsApp y escribe *reintentar pago*" (con link `wa.me/<número del bot>`) en vez de ir a `/checkout`.
3. Front `WhatsAppPaymentView.vue`: mandar el mismo desglose de IVA que `useCheckout.ts:608-626`
   (reusar la función en un util). Validar con un pago real de $1.
4. Expiración: al pedir un link, si la orden `pending` de tarjeta tiene más de 60 min → cancelarla con audit
   "Link de pago vencido" y crear una nueva. Evaluar un cron diario de limpieza (Vercel Cron) y **quitar el cron roto**
   de `vercel.json`.
5. Verificar en Vercel prod: `APP_ENV=production`, `PICKER_ENV=production`, `GEMINI_API_KEY`, `GOOGLE_MAPS_API_KEY`,
   `PAYPHONE_TOKEN`; `payphone.storeId` y `runfood` configurados en **cada** sucursal activa
   (`npm run branches:audit:prod`). PayPhone: `responseUrl` apuntando a `https://boloncity.com/checkout/response`.

### Fase 4: robustez y seguridad (B11, I1, I2, I4)
1. Middleware `botSecret` en `/whatsapp-bot/*`: header `x-bot-secret` = `WHATSAPP_BOT_SECRET` (env). Configurarlo en
   cada nodo `add_http` de BBC.
2. Timeouts: `axios` de `preCheckout` con `timeout: 8000`. Gemini a 12 s y **una sola** llamada por mensaje
   (quitar la reparación en cadena o limitarla a una respuesta de plantilla). Presupuesto por request ≤ 20 s.
   Confirmar el timeout real del nodo HTTP de BBC y el `maxDuration` de la función en Vercel; si hace falta, subirlo
   con `functions` en `vercel.json`.
3. RunFood y Meta no deben bloquear la respuesta al cliente más allá de su timeout (ya no lanzan; medir el tiempo
   total de un checkout en efectivo).
4. Dedup: hash de `phone + message` con ventana de 5 s usando `lastMessageHash`/`lastMessageAt`.
5. `track` y `search-order`: buscar **solo por el teléfono de WhatsApp** (E.164 contra `customerPhone`), y aceptar
   número de orden únicamente si pertenece a ese teléfono. Nunca por email libre.

### Fase 5: BuilderBot y pruebas punta a punta
Mapa de flujos (ver captura del proyecto *Bolonbot*):

| Flujo BBC | Endpoint | Notas |
|---|---|---|
| bienvenida (GENERAL) | `POST /whatsapp-bot/brain` | Pregunta delivery o retiro |
| envian ubicacion nativa (UBICACIÓN) | `POST /whatsapp-bot/location` | Cobertura real; si no cubre ofrece retiro |
| Catálogo Productos (ACCIÓN) | `POST /whatsapp-bot/catalog` | Filtrado por sucursal |
| agente que obtiene datos (ACCIÓN) | `POST /whatsapp-bot/brain` | Llena la sesión |
| ELEGIR METODO DE PAGO (IMAGEN) | — | Delivery: solo tarjeta. Retiro: tarjeta o efectivo. **Actualizar la imagen o el texto** |
| checkout link de pago (ACCIÓN) | `POST /whatsapp-bot/checkout` | Idempotente |
| consultar orden (ACCIÓN) | `POST /whatsapp-bot/search-order` | Solo por teléfono |
| **nuevo:** reintentar pago | `POST /whatsapp-bot/payment-link` | keyword "reintentar pago" |

Pendiente: exportar la configuración actual de cada flujo (keywords, body y `rules`) para alinear nombres de campos.

**Matriz de pruebas (dev con Picker dev + PayPhone real de $1):**

| # | Caso | Esperado |
|---|---|---|
| 1 | Delivery + tarjeta, pago aprobado | `paid`, RunFood, Picker CARD, correo, puntos |
| 2 | Delivery + efectivo | Aviso de deuda por ausencia, Picker CASH, RunFood "COBRAR EFECTIVO" |
| 2a | Pide transferencia | Aviso: no se acepta, ofrece tarjeta o efectivo |
| 2b | Picker reporta `NOT_DELIVERED` en efectivo | Deuda `pending` por el envío + evento `no_show` |
| 2c | Mismo cliente vuelve a pedir (bot o web) | Resumen con la línea de deuda; total, Picker `orderAmount` y comanda la incluyen |
| 2d | Esa orden se entrega o se paga | Deuda `settled` |
| 2e | Esa orden se cancela | Deuda vuelve a `pending` |
| 2f | Admin anula la deuda | `forgiven`, no se cobra más |
| 2g | Resumen mostrado y el cliente no confirma | `checkout_abandoned` visible en el admin |
| 2h | "quiero 2 bolones y un café" (catálogo por búsqueda) | Productos reales de esa sucursal; pregunta si hay ambigüedad |
| 3 | Retiro + efectivo | `pending`, RunFood inmediato, sin Picker, correo "pagas al retirar" |
| 4 | Retiro + tarjeta | `paid` al pagar, RunFood, sin Picker |
| 5 | Ubicación fuera de cobertura | Mensaje de cobertura + ofrecer retiro |
| 6 | Sucursal cerrada | Mensaje con hora de apertura, sin orden |
| 7 | Producto no disponible en esa sucursal | No se ofrece / error claro |
| 8 | "confirmo" enviado 2 veces seguidas | Una sola orden, mismo link |
| 9 | Pago rechazado → "reintentar pago" | Orden nueva, link nuevo |
| 10 | Teléfono 09..., 593..., +593 | E.164 correcto, Picker acepta |
| 11 | Promo global activa | Mismo total que la web con el mismo carrito |
| 12 | Consultar orden de otro número / email ajeno | No devuelve datos |
| 13 | Llamada sin `x-bot-secret` | 401 |
| 14 | Nota de voz / imagen | Respuesta conversacional, sin romper la sesión |
| 15 | Mismo carrito en web y bot | Subtotal, IVA, envío, promo y total idénticos |

## 4. Checklist de salida

- [ ] Fases 1-4 mergeadas en `develop`, probadas en dev.
- [ ] Matriz de pruebas 1-15 en verde.
- [ ] Env vars de prod verificadas (sección Fase 3.5) y `branches:audit:prod` sin faltantes.
- [ ] `responseUrl` de PayPhone en prod.
- [ ] BBC: secreto en todos los `add_http`, imagen de método de pago actualizada, flujo de reintento creado, validate sin críticos.
- [ ] Monitoreo la primera semana: órdenes `source=whatsapp` en el admin y auditoría "RunFood NO recibió" o "Picker booking falló".
