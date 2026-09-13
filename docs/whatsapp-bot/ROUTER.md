# Cómo piensa el bot: el router ("discriminador")

Código: `src/services/whatsappBot/router.ts` · Pruebas: `npm run test:bot` (`VERBOSE=1 npm run test:bot` muestra las conversaciones).

## La idea en una línea

**Cada mensaje pasa por las mismas reglas en el mismo orden. La primera que aplica decide qué hacer. Al final el bot
siempre pregunta lo PRIMERO que falta para cerrar el pedido.** Así nunca pierde el hilo de qué está ordenando el cliente.

```
                        Mensaje del cliente (BuilderBot → POST /api/orders/whatsapp-bot/brain)
                                             │
                  ┌──────────────────────────▼───────────────────────────┐
                  │ R0  ¿Mismo mensaje hace <5 s? → misma respuesta        │  (reintentos de BuilderBot)
                  │ R1  ¿Ubicación o link de Maps?  → cobertura + sucursal │
                  │ R2  ¿Pide persona / reclamo?    → número de soporte    │
                  │ R3  ¿Consulta un pedido?        → estado del pedido    │
                  │ R4  ¿Hay una pregunta pendiente? → tomar su respuesta   │
                  │ R5  ¿"Lo mismo de la última vez"? → ofrecer repetir     │
                  │ R6  ¿Vaciar / empezar de nuevo?  → carrito vacío        │
                  │ R7  ¿"Confirmo"?                → crear la orden        │
                  │ R8  ¿"Qué llevo"?               → mostrar carrito       │
                  │ R9  ¿"Menú" / "qué bebidas"?    → categorías/opciones   │
                  │ R10 Respuesta al paso o datos   → aplicar (IA + reglas) │
                  │ R11 Nada de lo anterior         → "no te entendí"       │
                  └──────────────────────────┬───────────────────────────┘
                                             │
                          SIGUIENTE PASO (siempre en este orden)
                                             ▼
   ① elección pendiente  →  ② productos  →  ③ ¿delivery o retiro?  →  ④ ubicación (delivery) o local (retiro)
   →  ⑤ ¿local abierto? (si está cerrado, avisa la hora de apertura y no pide más datos)
   →  ⑥ dirección escrita (solo delivery)  →  ⑦ nombre  →  ⑧ correo  →  ⑨ tarjeta o efectivo
   →  ⑩ datos de factura (solo si la pidió)  →  ⑪ RESUMEN + "escribe confirmo"
```

Si el cliente adelanta datos ("2 bolones mixtos para retirar, pago en efectivo, soy Ana"), se guardan todos y el bot
salta directo a lo que falte. Si en cualquier momento cambia algo ("mejor delivery", "quita el café"), se aplica y el
bot vuelve a preguntar lo que corresponda.

## Por qué ese orden de reglas

| Regla | Por qué va ahí |
|---|---|
| R1 Ubicación primero | Una ubicación de WhatsApp no tiene texto; nada más la reconoce. Cambia sucursal, precio y disponibilidad. |
| R2 Persona / reclamo | Un cliente molesto no debe recibir "¿qué te gustaría pedir?". |
| R3 Consultar pedido | "¿Dónde está mi pedido?" no es un pedido nuevo. |
| R4 Pregunta pendiente | Si el bot preguntó "¿verde, maduro o pintón?", un "2" o "maduro" responde ESO. Si el cliente escribe otra cosa, la pregunta se descarta y el mensaje sigue por las demás reglas. |
| R5 Repetir pedido | Frase fija del negocio: se detecta con reglas, sin IA. |
| R7 Confirmo | Solo crea la orden si el resumen ya se mostró (paso `confirm`). Antes de crear, revisa todo otra vez (el local pudo cerrar). Un segundo "confirmo" no crea otra orden. |
| R10 IA al final | Es lo más lento y lo menos seguro. Las reglas R1-R9 cubren lo crítico sin depender de ella. |

## El estado que recuerda el bot

Se guarda en `WhatsAppSession.state` (Mongo, se borra 24 h después del último mensaje).

| Campo | Qué es |
|---|---|
| `stage` | En qué paso está: `idle`, `choosing`, `delivery_type`, `location`, `address`, `branch`, `name`, `email`, `payment`, `invoice_doc`, `invoice_name`, `confirm`, `closed`, `ordered` |
| `cart` | Productos con su `productId` real y cantidad. **Sin precio**: el precio se recalcula siempre desde Mongo |
| `pendingChoice` | La pregunta que espera respuesta: opciones de producto, repetir pedido, misma dirección o elegir local |
| `choiceQueue` | Productos del mismo mensaje que esperan su turno ("un bolón de queso y una coca cola": primero pregunta el bolón, después la coca cola) |
| `deliveryType`, `branchId`, `deliveryCoordinates`, `deliveryAddress`, `deliveryFee` | Entrega |
| `customerName`, `customerEmail`, `paymentMethod`, `billing*`, `notes` | Datos del pedido |
| `lastOrderNumber`, `lastPaymentLink` | La orden creada en esta conversación (para no duplicar) |

## Cómo encuentra productos sin meter el menú en el prompt

`src/services/whatsappBot/catalog.ts`

1. La IA (o las reglas si la IA falla) solo convierte el mensaje en `[{ query: "bolon mixto verde", quantity: 2 }]`.
   **La IA nunca ve el catálogo.** Su prompt es fijo y corto (`extractor.ts`).
2. El buscador compara esas palabras con los productos **disponibles en la sucursal** (cache de 60 s):
   - sin tildes ni mayúsculas, plurales ("bolones" = "bolón"), errores de tipeo ("chicharon"), sinónimos ("tomar" → bebida);
   - penaliza variantes que el cliente no nombró (agrandar, combo, mini, medio, mega, congelado, Uber).
3. Resultado:
   - **exacto** → se agrega ("Agregué 2 x Bolón Mixto Verde $10.80");
   - **ambiguo** → el bot pregunta con opciones numeradas ("¿Cuál bolón de queso? 1. Verde 2. Maduro 3. Pintón");
   - **nada** → sugiere parecidos o dice que no existe. Nunca inventa.

Para mejorar búsquedas: agregar palabras en `tags` del producto (desde el admin) o en `SYNONYMS` de `catalog.ts`.

## "Lo mismo de la última vez"

- Al saludar con el carrito vacío, si el teléfono tiene un pedido anterior (no cancelado, no una tarjeta sin pagar),
  el bot lo muestra y pregunta si lo repite.
- En cualquier momento, "lo mismo de la última vez", "lo de siempre" o "repetir pedido" hace lo mismo.
- Al aceptar: se agregan los productos **que sigan disponibles** (avisa cuáles ya no), y se reutilizan nombre y correo.
- Si ese pedido fue delivery, al pedir ubicación ofrece "¿a la misma dirección de la vez pasada?".

## Pagos

| | Tarjeta | Efectivo | Transferencia |
|---|---|---|---|
| Delivery | Link `/pago/ORD-…` | Al motorizado. El resumen avisa que si no está, el envío se suma a su próxima compra | Se rechaza y ofrece tarjeta o efectivo |
| Retiro | Link `/pago/ORD-…` | Al retirar | Se rechaza y ofrece tarjeta o efectivo |

Al confirmar en efectivo el bot hace lo mismo que la web: Picker (si es delivery), comanda RunFood, evento de Meta y
correo. En tarjeta eso ocurre cuando se confirma el pago (igual que la web).

> El cobro automático de la deuda por ausencia todavía no está implementado (ver PLAN.md, Fase 2c). Hoy solo se muestra el aviso.

## Endpoints para BuilderBot

Todos responden HTTP 200 con `{ success, message, route, step, decision, readyToCheckout, orderNumber, paymentLink, cart }`.
**`message` es el texto que BuilderBot debe enviar al cliente.**

| Flujo BBC | Endpoint | Body mínimo |
|---|---|---|
| bienvenida / agente que obtiene datos | `POST /api/orders/whatsapp-bot/brain` | `{ "phone": "{from}", "message": "{body}", "name": "{name}" }` |
| envian ubicacion nativa | `POST /api/orders/whatsapp-bot/location` | `{ "phone", "latitude", "longitude" }` o `{ "phone", "mapsUrl" }` |
| Catálogo Productos | `POST /api/orders/whatsapp-bot/catalog` | `{ "phone", "message" }` (sin mensaje = menú) |
| checkout link de pago | `POST /api/orders/whatsapp-bot/checkout` | `{ "phone" }`. Idempotente: si ya existe la orden devuelve la misma |
| consultar orden | `POST /api/orders/whatsapp-bot/search-order` | `{ "phone", "message" }`. Solo pedidos de ESE teléfono |

Lo más simple y robusto: **un solo flujo que mande todo a `/brain`** y envíe `message`. Los demás endpoints existen por
compatibilidad con los flujos actuales.

`route` sirve si BuilderBot quiere saltar a otro flujo: `conversation`, `choice`, `catalog`, `location`, `checkout`,
`tracking` o `human`.

## Probar en vivo sin crear órdenes

```
vercel env pull .env.local --environment=development   # una vez
npm run test:bot:live                                    # conversación de ejemplo contra Mongo, Gemini y Picker de dev
BOT_FORCE_OPEN=1 npm run test:bot:live                   # simula el local abierto (para probar de noche)
npm run test:bot:live -- "2 humitas" "retiro" "1"        # tu propia conversación
```

`createOrder` está simulado en ese script: no se crean órdenes ni se toca RunFood, PayPhone, Meta o correos.

## Cómo depurar una conversación real

Cada turno escribe en los logs de Vercel: `[whatsapp-bot] +593… R10:ai → paso payment`. La regla (`decision`) dice por
qué el bot respondió lo que respondió. El historial de los últimos 30 mensajes está en `WhatsAppSession.history`.
