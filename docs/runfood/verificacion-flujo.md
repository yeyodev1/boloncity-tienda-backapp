# Verificación del disparo de la comanda RunFood

Repo: `boloncity-tienda-backapp` · fecha 2026-08-27 · sólo lectura, sin cambios de código.

**Pregunta:** ¿la comanda sale a la cocina exactamente cuando el pedido está confirmado?
**Respuesta corta:** no. Hay **3 caminos donde la comanda nunca sale** y **1 donde sale antes de cobrar por diseño**. Sólo hay 3 puntos de disparo en todo el backend:

- `src/controllers/order.controller.ts:355` (efectivo inmediato, al crear)
- `src/controllers/order.controller.ts:540` (tarjeta, dentro de `confirmOrder`)
- `src/controllers/order.controller.ts:1053` (programados, al pasar a `preparing`)

Definición: `sendOrderToRunfood` en `src/controllers/order.controller.ts:446-470`; transporte en `src/services/runfood.service.ts:91-153`.

---

## Tabla de escenarios

| # | Escenario | Dónde se dispara | ¿Correcto? | Riesgo |
|---|---|---|---|---|
| 1 | Efectivo inmediato (web) | `order.controller.ts:354-356` dentro de `createOrder`, antes de `res.status(201)` en `:381` | Correcto por diseño, pero **sin pago recibido** | Medio — comida preparada para un pedido `pending` que nadie retira. No hay ninguna cancelación automática por no-show; el pedido se queda en `pending` para siempre |
| 2a | Tarjeta — `confirmOrder` del navegador | `order.controller.ts:538-541`, tras `order.save()` de `:536` | Funciona **sólo si el navegador vuelve** | **Alto** |
| 2b | Tarjeta — webhook de PayPhone | **NO EXISTE.** `src/routes/webhook.routes.ts:6-7` sólo registra `/webhooks/picker`; `webhook.controller.ts` es 100 % Picker | **ROTO** | **CRÍTICO — bloqueante.** Cliente paga, cierra la pestaña → no hay `confirmOrder` → sin comanda, sin correo, sin Picker, y el pedido queda `pending`/`cardUnpaid` |
| 3 | Programados | `order.controller.ts:1051-1054`, sólo si `previousStatus !== order.status && status === "preparing" && order.scheduledFor` | Depende 100 % de un humano | **Alto.** Nadie automatiza el paso a `preparing`: `scheduler.service.ts:10-20` sólo activa/desactiva productos, y el cron de `vercel.json:15-19` apunta a `/api/cron/payment-reminders`, **ruta que no existe en el código** (`src/routes/` no tiene cron router) → 404 cada 5 min |
| 3b | Programado con salto de estado | — | **ROTO** | **Alto.** `updateOrderStatus` no valida transiciones (`order.controller.ts:1008-1009` asigna `req.body.status` sin máquina de estados): si el cajero salta `pending → awaiting_pickup` o `→ ready`, nunca pasa por `preparing` y la comanda **jamás** se envía |
| 3c | `preparing` puesto por el webhook de Picker | `webhook.controller.ts:93-95` (mapa `READY_FOR_PICKUP/ACCEPTED/ARRIVED_AT_PICKUP → preparing`) y `:150-152` (`DRIVER_ASSIGNED`) | **ROTO** | Medio. Esas dos rutas ponen `preparing` sin llamar nunca a `sendOrderToRunfood` |
| 4 | Doble envío | Guardas: `confirmOrder` corta en `order.controller.ts:482-485` si `payphone.confirmedAt`; `updateOrderStatus` exige `previousStatus !== order.status` en `:1040`/`:1052` | Razonable | Bajo. Ante carrera (doble clic antes de guardar `confirmedAt`) o `ready → preparing → ready`, la red de seguridad es el 409 por `external_id = orderNumber` (`runfood.service.ts:127-146`). **Es una suposición sobre la API de RunFood, no verificada contra un local real.** Ojo: el 409 se traduce a `ok:true`, así que un 409 por *cualquier otro* motivo también se reporta como éxito |
| 5 | Cancelación / reembolso | `updateOrderStatus` cancela en `:1009-1019`; `refundOrder` cancela en `:781` | **ROTO** | **Alto.** Ni la cancelación ni el reverso avisan al POS. No hay ninguna llamada a `DELETE /orders/{id}`; `runfood.service.ts` sólo expone `pushOrderToRunfood` y `runfoodHealth`. Además no se guarda el `orderId` que devuelve RunFood (`runfood.service.ts:140`, se pierde en el string del audit) → aunque se quisiera cancelar, **no se sabe qué id borrar**. Comanda huérfana imprimiéndose en cocina |
| 6 | Serverless (dangling promise) | Las 3 llamadas están `await`eadas antes del `res`: `:355` → `res` en `:381`; `:540` → `res` en `:627`; `:1053` → `res` en `:1080` | **Correcto** | Pero el problema es el inverso: **RunFood bloquea el flujo crítico**. En `confirmOrder` está *antes* de `bookPickerForOrder` (`:545-547`) y de los correos (`:604-625`). Presupuesto de tiempo de `pushOrderToRunfood`: `GET /identity` + hasta 10 `GET /products` + `POST /orders`, 12 s de timeout cada uno (`runfood.service.ts:32,102,52,139`) ≈ hasta ~2 min. `vercel.json` **no define `maxDuration`** → la función muere antes de reservar Picker y de mandar el correo. Y el reintento del cliente cae en la guarda de `:482` y devuelve el pedido sin hacer nada |
| 7 | Observabilidad | `pushAudit` en `:458-465` (queda en `order.audit`, visible en el panel); `catch` en `:467-469` sólo `console.error` | Parcial | **Alto.** El fallo se guarda como un `note_added` más dentro del pedido — nadie lo mira. No llega a Slack: `globalErrorHandler.middleware.ts:5-21` + `errors/errorHandler.error.ts:14-16` sólo notifican con `status >= 500` y errores **no capturados**; aquí `pushOrderToRunfood` nunca lanza (devuelve `ok:false`, `runfood.service.ts:142-152`). No hay endpoint de reintento manual (`order.routes.ts` tiene `retry-picker` pero **no** `retry-runfood`) |
| 8 | `Branch.findById(order.branch)` con `branch` poblado | `order.controller.ts:449`, con `confirmOrder` haciendo `.populate("branch")` en `:475` | **CORRECTO — verificado** | Ninguno. `node_modules/mongoose/lib/cast/objectid.js:15-22` (mongoose ^8.9.5) castea documentos: `if (value._id) return value._id`. El `findById` recibe el documento y extrae el `_id` bien. La guarda `if (!order.branch) return` de `:448` además evita el caso peligroso `findById(undefined)` → `findOne({})` |
| 9 | **Pedidos por WhatsApp** | **NO EXISTE ningún disparo** | **ROTO** | **CRÍTICO — bloqueante.** `whatsappBot.controller.ts:510` crea la orden y `:542-551` reserva Picker para efectivo, pero `grep runfood src/controllers/whatsappBot.controller.ts` → **0 resultados**. Efectivo por WhatsApp: sale un motorizado y **la cocina nunca se entera**. (Tarjeta por WhatsApp sí funciona: pasa por `confirmOrder`) |

---

## Agujeros reales, por gravedad

### 1. BLOQUEANTE — Tarjeta: no hay webhook de PayPhone; la comanda depende de que el navegador vuelva

`src/routes/webhook.routes.ts:6-7` sólo tiene Picker. El único camino a `sendOrderToRunfood` para tarjeta es `POST /api/orders/confirm` (`order.routes.ts:11`), que dispara el frontend al volver del `responseUrl`. Si el cliente cierra la pestaña, pierde señal o la función se cae por timeout: pago cobrado, cocina sin comanda, Picker sin reserva, cliente sin correo, y el pedido queda bloqueado en el panel por `cardUnpaid` (`order.controller.ts:975-982`).

Parche mínimo — job de reconciliación en el cron que ya está declarado (hoy 404):

```diff
+// src/routes/cron.routes.ts  (montar en routes/index.ts como router.use("/cron", cronRouter))
+cronRouter.get("/payment-reminders", async (_req, res) => {
+  const stale = await Order.find({
+    paymentMethod: "card",
+    status: "pending",
+    "payphone.confirmedAt": { $exists: false },
+    createdAt: { $lt: new Date(Date.now() - 5 * 60_000), $gt: new Date(Date.now() - 24 * 3600_000) },
+  }).limit(20);
+  for (const o of stale) await reconcileCardOrder(o); // confirmPayphoneTransaction + mismo bloque de :532-547
+  res.json({ checked: stale.length });
+});
```

`reconcileCardOrder` debe reusar exactamente el bloque de `order.controller.ts:532-547` (marcar `paid`, `sendOrderToRunfood`, `bookPickerForOrder`). Sin esto el cron de `vercel.json:15-19` seguirá devolviendo 404 cada 5 minutos.

### 2. BLOQUEANTE — Pedidos por WhatsApp nunca llegan al POS

```diff
--- a/src/controllers/whatsappBot.controller.ts
@@ (tras el bloque de Picker, ~línea 551)
+  if (data.paymentMethod === "cash") {
+    await sendOrderToRunfood(order);   // exportar la función desde order.controller.ts
+  }
```

Lo correcto es sacar `sendOrderToRunfood` a `src/services/runfood.service.ts` (recibiendo la orden) y llamarlo desde ambos controladores, para que no haya un cuarto camino que se olvide mañana.

### 3. BLOQUEANTE — Un fallo del POS es silencioso y no hay reintento

`order.controller.ts:458-469`: `ok:false` se escribe como nota en `order.audit` y nada más. El POS on-premise **va a estar caído** (lo dice el propio comentario de `runfood.service.ts:5-6`). Hoy eso es indistinguible de "no entró el pedido".

```diff
--- a/src/controllers/order.controller.ts
@@ -456,7 +456,13 @@ async function sendOrderToRunfood(order) {
     });
+    order.set("runfood", {
+      status: result.ok ? "sent" : "failed",
+      posOrderId: result.orderId || null,
+      lastMessage: result.message,
+      attemptedAt: new Date(),
+    });
+    if (!result.ok) notifySlack(`RunFood NO recibió ${order.orderNumber}: ${result.message}`).catch(() => {});
     pushAudit(order, { ... });
```

Y añadir `POST /api/orders/:id/retry-runfood` (admin) en `order.routes.ts`, en paralelo al `retry-picker` de `:35`. Guardar `posOrderId` es además el prerrequisito del punto 5.

### 4. ALTO — Los programados dependen de que un humano pulse "En preparación", y saltar un estado los pierde

`order.controller.ts:1051-1054` exige `status === "preparing"` **y** `scheduledFor`. `updateOrderStatus` no valida transiciones (`:1008-1009`), así que `pending → awaiting_pickup` deja el pedido sin comanda para siempre. Nada automatiza el paso a `preparing` (`scheduler.service.ts:10-20` no toca órdenes).

```diff
-    if (order.status === "preparing" && order.scheduledFor) {
-      await sendOrderToRunfood(order);
-    }
+    // Cualquier avance más allá de "paid" tiene que tener comanda en cocina.
+    // Idempotente: si ya se envió (order.runfood?.status === "sent") no repite.
+    if (["preparing", "awaiting_pickup", "ready"].includes(order.status) && order.runfood?.status !== "sent") {
+      await sendOrderToRunfood(order);
+    }
```

Esto además cubre el escenario 3c (el webhook de Picker poniendo `preparing`) y el reintento tras un fallo transitorio del POS del punto 3 — hoy, si `confirmOrder` falló contra RunFood, ningún cambio de estado posterior reintenta porque la condición exige `scheduledFor`.

Complementariamente, encolar el paso automático a `preparing` de los programados en el mismo cron del punto 1 (`scheduledFor - cookTimeMinutes <= now`).

### 5. ALTO — Cancelar o reembolsar deja la comanda huérfana en cocina

`updateOrderStatus:1009-1019` y `refundOrder:781` cancelan sin avisar al POS, y el `orderId` de RunFood ni se guarda (`runfood.service.ts:140`).

```diff
+// src/services/runfood.service.ts
+export async function cancelRunfoodOrder(config: RunfoodConfig, posOrderId: number) {
+  try { await client(config).delete(`/orders/${posOrderId}`); return { ok: true }; }
+  catch (err) { return { ok: false, message: describe(err) }; }
+}
```

y llamarlo desde ambos puntos de cancelación usando el `posOrderId` que introduce el punto 3, dejando el resultado en el audit. Si RunFood no permite borrar un pedido ya cerrado por el cajero, al menos hay que **anotarlo en el audit y avisar por Slack** para que alguien llame al local.

### 6. MEDIO — RunFood bloquea el camino crítico del pago

En `confirmOrder`, `sendOrderToRunfood` (`:540`) va **antes** de `bookPickerForOrder` (`:545`) y de los correos. Con el POS lento son hasta ~2 min de HTTP secuencial (`runfood.service.ts:32,52,102,139`) y `vercel.json` no fija `maxDuration`: la función muere y se pierde la reserva de Picker.

```diff
-    if (!order.scheduledFor) {
-      await sendOrderToRunfood(order);
-    }
     if (order.deliveryType === "delivery" && !order.picker?.bookingId && !order.scheduledFor) {
       await bookPickerForOrder(order, "CARD");
     }
+    // El POS del local es lo más frágil de la cadena: va al final, nunca antes de Picker.
+    if (!order.scheduledFor) {
+      await sendOrderToRunfood(order);
+    }
```

Y bajar el presupuesto de tiempo: `TIMEOUT_MS` de 12 s a ~5 s, y limitar `getCatalog` a menos páginas o precalentar la caché (`runfood.service.ts:43-59`; ojo: en serverless la caché en memoria muere con cada instancia, así que casi siempre es un catálogo frío). Declarar `maxDuration` en `vercel.json`.

### 7. MEDIO — Efectivo inmediato: comanda antes de cobrar, sin caducidad

`order.controller.ts:354-356` es deliberado (comentario en `:351-353`) y para retiro en local es defendible, pero no existe ningún barrido de pedidos `pending` en efectivo que nadie retira. Mínimo: reportar en el panel los `cash`+`pending` con más de N horas, junto al job del punto 1.

### 8. BAJO — Idempotencia por `external_id` no verificada contra un local real

`runfood.service.ts:144-147` asume que RunFood devuelve 409 ante `external_id` repetido y lo convierte en `ok:true`. Si el 409 fuera por otra causa (p. ej. validación), se reportaría como comanda enviada. Comprobarlo en el sondeo del local y, si se puede, distinguir por el código de error del cuerpo en lugar de por el status a secas.

---

## Antes de encender

Mínimo indispensable para activar RunFood en producción. Los tres primeros son **bloqueantes**: sin ellos hay dinero cobrado sin comida preparada.

1. **Webhook o reconciliación de PayPhone** (agujero 1). Implementar `/api/cron/payment-reminders` — hoy está en `vercel.json` y devuelve 404 — para confirmar pagos huérfanos y disparar comanda + Picker + correo. Sin esto, todo cliente que cierre la pestaña paga y no come.
2. **Disparar RunFood en el checkout de WhatsApp** (agujero 2, `whatsappBot.controller.ts:510`). Hoy sale el motorizado y la cocina no se entera.
3. **Persistir el estado RunFood en el pedido + alerta a Slack + botón de reintento** (agujero 3). El POS es on-premise y se va a caer; un fallo silencioso es inaceptable.
4. **Ampliar el disparo por cambio de estado** a `preparing | awaiting_pickup | ready`, con guarda de idempotencia por `order.runfood.status` (agujero 4). Cierra los saltos de estado, el `preparing` puesto por el webhook de Picker y el reintento tras fallo del POS.
5. **Mover `sendOrderToRunfood` después de `bookPickerForOrder`** en `confirmOrder` y bajar `TIMEOUT_MS`; declarar `maxDuration` en `vercel.json` (agujero 6). Que el POS del local no tumbe el delivery.
6. **Verificar el 409 de idempotencia y el `DELETE /orders/{id}` contra un local real** antes de confiar en ellos (agujeros 5 y 8).

Recomendación de despliegue: encender `runfood.enabled` **en una sola sucursal** y contrastar durante unos días el audit del pedido contra las comandas impresas, antes de habilitar el resto.
