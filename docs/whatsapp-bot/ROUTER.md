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
| R4 Pregunta pendiente | Si el bot preguntó "¿verde, maduro o pintón?", el cliente contesta hablando normal ("el verde", "boon de queso verde porf avor, me encantaria", "el más barato", "el primero") o con el número ("2", "la 2", "#2"): las dos formas valen (ver *Elegir hablando normal*). Si el cliente escribe otra cosa, la pregunta se descarta y el mensaje sigue por las demás reglas. "¿En qué local lo retiras?" también se descarta cuando el cliente cambia a delivery ("mejor delivery"): se pide la ubicación. |
| R5 Repetir pedido | Frase fija del negocio: se detecta con reglas, sin IA. |
| R7 Confirmo | Solo crea la orden si el resumen ya se mostró (paso `confirm`). El mensaje se clasifica con `classifyConfirmReply` (intents.ts), la MISMA función que usa el router de la Bienvenida, así `/router` y `/brain` nunca se contradicen. Ver la tabla de abajo. Antes de crear, revisa todo otra vez (el local pudo cerrar). Un segundo "confirmo" no crea otra orden. Con la orden ya creada, cualquier confirmación ("sí", "claro", "correcto", "de una", 👍…) responde `R7:ya_confirmado` con el link: no reinicia el pedido. Si el mismo mensaje llega otra vez en menos de 5 s justo después de crear la orden, es un reintento (`R0:duplicado`). |
| Pregunta en la dirección | En el paso `address`, una pregunta ("¿cuánto cuesta el envío?", "cuánto se demora", "hacen delivery a …?") NO se guarda como dirección: se responde con lo que el bot sabe (el costo ya cotizado) y se vuelve a pedir la dirección. Si todavía no eligió cómo paga y Picker cobra distinto en efectivo, dice los dos precios ("$3.10 pagando con tarjeta y $2.80 pagando en efectivo"). |
| Costo del envío | Picker cobra distinto en tarjeta y en efectivo. Al elegir o cambiar el pago se recotiza y, si el envío cambia respecto a lo dicho al compartir la ubicación, se avisa: "El envío pagando en efectivo cuesta $2.80 (antes te dije $3.10)". El resumen muestra ese valor. |
| Paso de ubicación | "delivery" o "quiero delivery a mi casa" cuando ya es delivery vuelve a pedir la ubicación (no suma "no entendido"). Un "1" suelto (respuesta a una lista vieja de locales) no elige local ni cambia cantidades. La lista de locales solo vale en retiro. |
| Cambiar de modalidad | delivery → retiro → delivery reusa la ubicación ya compartida y recotiza ("Uso la ubicación que me compartiste antes"). |
| Elección de producto + otra cosa | "no, mejor para retirar" cuando el bot preguntó "¿cuál bolón?": descarta la opción Y aplica el retiro. |
| Datos adelantados | Lo que el cliente dice antes de que se le pregunte (pago, nombre, correo, cédula) se guarda y se confirma con un acuse corto: "Anoté: efectivo ✅". |
| Nombre | En el paso `name`, "retiro", "tarjeta", "sí", "menú"… no se guardan como nombre: se aplica esa intención o se vuelve a pedir el nombre. |

## Elegir hablando normal

El bot muestra la lista numerada (ayuda a quien quiere responder con el número) pero **nunca pide que se responda
con un número**: cierra con "Dime cuál prefieres 😊". La respuesta se interpreta en `services/whatsappBot/choice.ts`,
comparando el mensaje SOLO con las opciones mostradas (nunca con todo el catálogo):

| El cliente escribe | Qué pasa |
|---|---|
| "el verde", "verde porfa", "boon de queso verde porf avor, me encantaria" | Se agrega esa opción. Tolera tildes, plurales, errores de tipeo y cortesías ("porfa", "me encantaría", "gracias", "quiero", "dame"). |
| "el más barato", "el de 3.50" | Se resuelve con los precios de las opciones (que salen de Mongo). |
| "el primero", "la segunda opción", "el último" | Posición dentro de la lista. |
| "2", "la 2", "opción 2", "#2" | Sigue funcionando igual que antes. |
| "los dos", "uno de cada uno" | Agrega TODAS las opciones mostradas, una unidad de cada una. |
| "el de queso" (cuando todas son de queso) | Sigue ambiguo: se repregunta mostrando SOLO lo que las diferencia ("1. Verde · 2. Maduro · 3. Pintón"). |
| "ninguno gracias", "no, mejor no" | Se descarta la pregunta ("Dale, no lo agrego 👍"). |
| "mejor un tigrillo mixto verde" | Nombró otro producto: la pregunta se descarta y se procesa el producto nuevo. |

Primero las reglas (instantáneas y gratis). Si no alcanzan, **Gemini desempata eligiendo un número de esa misma
lista** (`aiChooseOption` en extractor.ts): recibe solo las opciones ya mostradas y devuelve el índice o `null`.
Nunca inventa productos ni precios, y si falla o no hay API key, las reglas resuelven los casos comunes.

Las demás preguntas con opciones se contestan igual de suelto: "a domicilio" / "me lo mandan" / "para llevar" /
"paso por ahí", "el de la kennedy" / "urdesa" ("el más cercano" pide la ubicación o el sector), "con tarjeta" /
"al motorizado" / "link de pago" (la transferencia se sigue rechazando), "dale repite lo mismo", "la misma de siempre".

**En el resumen (paso `confirm`)** cada palabra del mensaje debe ser una afirmación, un relleno o "el pedido":

| El cliente escribe | Qué pasa |
|---|---|
| "sí", "ok", "dale", "listo", "confirmo", "confirmo el pedido", "confirmo mi pedido", "si esta bien asi", "así está bien", "todo está bien", "correcto", "perfecto", "de una", "va", "todo bien", "adelante", "hazlo", "sí confirmo", "si porfavor", "sip", "okis", ✅, 👍 | **Crea la orden** (✅ y 👍 son la forma corta de "sí" en WhatsApp cuando el resumen pide confirmar) |
| Errores de tipeo: "confimo", "confirmoo", "conffirmo", "siii", "perfeto" | **Crea la orden**: letras repetidas se colapsan y una palabra de 5+ letras puede tener 1 letra de diferencia (2 desde 8 letras). Palabras cortas ("sí"/"sin") nunca se aproximan |
| "gracias", "ya", "por favor", "hola", "nada más", 🙏 | **No** crea la orden: vuelve a mostrar el resumen y pide "confirmo". No cuenta como "no entendido" |
| "sí, pero agrégale un café", "mejor sin cebolla", "otro bolón", "quita el café" | Aplica el cambio y vuelve a mostrar el resumen |
| Un número suelto ("1", "2") sin lista abierta | No toca el carrito ni pasa por la IA: vuelve a mostrar el resumen (`R10:numero_suelto`) |
| Cualquier otra cosa que no cambió nada ("okey dokey", "no", un typo raro) | Vuelve a mostrar el resumen con "escribe *confirmo* o dime qué cambiar" (`R7:resumen_sin_cambios`). **No** suma "no entendido" ni deriva a soporte con el pedido listo |

**Después de crear la orden**, "sí, y agrégale un café" no modifica esa orden: el bot avisa "Tu pedido ORD-X ya está registrado
y no se puede modificar. Empiezo un pedido nuevo" y arranca otro con lo pedido.

| Saludos | "hola", "buenas tardes", "gracias", "👍" responden con el paso actual y **no** cuentan como "no entendido". |
| Después de la orden | "hola" saluda y ofrece ver el pedido o pedir otro. "gracias", "el link no me abre", "mejor en efectivo" hablan de ESA orden: se reenvía el link y el pedido no se borra. Un producto nuevo arranca otro pedido. |
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

En efectivo con delivery el bot dice el monto exacto que se le paga al motorizado ("Págale $7.48 en efectivo al
motorizado"): el motorizado cobra el total (subtotal + envío), que es lo que se le manda a Picker.

### "Escríbeme *pagado*": cómo se cierra un pago de tarjeta desde el chat

El dueño no quiere cobrar dentro del chat: manda el link y el cliente avisa. Por eso el mensaje que crea una orden
con tarjeta termina con **"Cuando lo hayas pagado, escríbeme *pagado* y verifico el pago al instante"**.

Cuando el cliente escribe *pagado* / "ya pagué" / "listo pagué" / "hice el pago" (`claimsPaid` en intents.ts, con
tolerancia a typos y cortesías), el bot **no le cree**: la regla `R7:pago_*` de `handleTurn` llama a
`deps.settlePayment(orderNumber)` → `settleCardPaymentByOrderNumber` (src/services/cardPaymentSettlement.service.ts),
que hace esto en este orden:

1. Si la orden ya está pagada (status ≠ `pending`, o hay `payphone.transactionId`/`confirmedAt`) → `already_paid`,
   sin molestar a PayPhone. Eso hace idempotente el escribir "pagado" dos veces.
2. `GET /api/Sale/client/{clientTransactionId}` (`getPayphoneSaleByClientTxId`): el único identificador que el bot
   tiene es el `clientTransactionId` que guardó la orden; el `id` numérico de PayPhone solo vuelve por el navegador.
3. **El GET no cierra el pago.** La doc del botón por redirección dice que si el comercio no ejecuta la fase de
   confirmación dentro de los 5 minutos siguientes, PayPhone **revierte la venta sola**. Así que con el
   `transactionId` del GET se llama el `confirmPayphoneTransaction` que ya existía (POST /api/button/V2/Confirm).
4. Su respuesta pasa por `evaluatePayphoneResult` y, si está aprobada, por `settleApprovedCardOrder`: las MISMAS
   piezas que usa el regreso del navegador (`confirmOrder`), extraídas de ahí para no duplicar el camino del dinero.
   Eso marca pagada, reserva Picker con `CARD`, manda RunFood, Meta, puntos y correo.

| PayPhone dice | `outcome` | Qué responde el bot | Qué le pasa a la orden |
|---|---|---|---|
| Aprobada | `paid_now` | Total, "ya está en cocina" y "te aviso cuando salga el motorizado" (+ link de seguimiento si Picker ya reservó) | Pagada y despachada |
| Ya estaba pagada | `already_paid` | "Tu pago ya está confirmado" + lo mismo | **Nada** (no duplica cocina, ni Picker, ni correo) |
| Pendiente o no encuentra la transacción | `pending` | "Todavía no nos llega el pago… escríbeme *pagado* otra vez" + reenvía el link | **Nada.** No se cancela y no se escribe `confirmedAt` |
| Rechazada / cancelada | `rejected` | Lo dice claro y reenvía el link | Cancelada (igual que la web) |
| Aprobada por otro monto | `mismatch` | Manda a soporte | Intacta + auditoría `payment_mismatch` |
| Error técnico | `error` | "No pude verificar tu pago ahorita" | **Nada** |

La regla vive **antes** de `orderFollowUp` y del reinicio a pedido nuevo: si no, "listo pagué" caía en la frase
canned "tu pedido ya está registrado" y nadie verificaba nada. Por lo mismo `claimsPaid` está excluida de
`confirmsPlacedOrder`, `classifyRoute` devuelve `conversation` para un reclamo de pago, y el flow de checkout
(`/whatsapp-bot/checkout`) deja pasar el turno en vez de contestar con su corto circuito.

**Nunca** se cancela un pedido porque el GET no encuentre la transacción: el cliente que todavía no pagó escribiría
"pagado" y perdería su pedido (y con `confirmedAt` escrito, el confirm del navegador saldría temprano y el pedido
real quedaría sin cocina, sin Picker y sin correo).

### El dashboard y las tarjetas sin pagar

`listOrders` esconde a propósito las órdenes de tarjeta sin pagar (`$nor: [{ paymentMethod: card, status: pending,
payphone.transactionId: null }]`, salvo `?includeUnpaid=true`). En cuanto el pago se cierra —por el navegador o por
"pagado"— la orden queda `paid` con `transactionId` y **aparece sola en el tablero**: no hay que tocar `listOrders`.

## Configuración de BuilderBot (los 5 flows que ya existen)

Base: `https://api.boloncity.com/api/orders/whatsapp-bot` (en dev: `https://<api-dev>/api/orders/whatsapp-bot`).
En **todos** los nodos HTTP: método `POST`, header `Content-Type: application/json`, **Body con campos (RAW apagado)**.
Variables de BuilderBot: `{body}` mensaje, `{from}` teléfono, `{history}` historial, `{name}` nombre.

> Por qué este cambio: el esquema anterior (flow Bienvenida → `/router` con "Enviar al cliente" apagado) necesitaba
> dos flows más ("agente que obtiene datos" y "Soporte humano"). Con los 5 flows actuales, todo lo que el router
> clasificaba como `conversation` (saludo, productos, "1", "retiro", nombre, correo, dirección…) **no tenía flow de
> destino y el cliente no recibía nada**. `/brain` ya resuelve TODO en un solo paso: pedido, menú, consulta de
> pedido, confirmación y link de pago. Por eso el flow de inicio llama directo a `/brain`.

| # | Flow (nombre en el panel) | Evento | Endpoint | Body (campos) | Enviar al cliente | Rules |
|---|---|---|---|---|---|---|
| 1 | Flow: Inicio de conversación | GENERAL | `/brain` | `rawMessage` = `{body}` · `phone` = `{from}` · `name` = `{name}` | **ENCENDIDO**, texto `{message}` | Ninguna obligatoria (ver nota de soporte) |
| 2 | envian ubicacion nativa | UBICACIÓN | `/location` | `phone` = `{from}` · `latitude` · `longitude` (variables de ubicación del **@**) · `rawMessage` = `{body}` | ENCENDIDO, `{message}` | — |
| 3 | Catálogo Productos | — (solo si otro flow salta aquí) | `/catalog` | `rawMessage` = `{body}` · `phone` = `{from}` | ENCENDIDO, `{message}` | — |
| 4 | checkout link de pago | — | `/checkout` | `phone` = `{from}` | ENCENDIDO, `{message}` | — |
| 5 | consultar orden | — | `/search-order` | `rawMessage` = `{body}` · `phone` = `{from}` | ENCENDIDO, `{message}` | — |

Paso a paso en el flow 1 ("Inicio de conversación"):

1. Abrir el nodo HTTP del flow → cambiar la URL de `/router` a `/brain`.
2. Método `POST`, header `Content-Type: application/json`, **RAW apagado**, campos `rawMessage` `{body}`, `phone` `{from}`, `name` `{name}`.
3. Encender **Enviar al cliente** con el texto `{message}` (la respuesta del bot siempre viene en `message`, nunca vacía).
4. Borrar las Rules por `route` de ese flow (ya no hacen falta: `/brain` responde el menú, el estado del pedido y el link de pago).
5. Guardar y publicar. Probar: "hola" → "¿Qué te gustaría pedir hoy?"; "2 humitas" → "¿delivery o retiro?".

Flows 3, 4 y 5 pueden quedarse como están (no molestan); ya no son necesarios porque `/brain` hace lo mismo.
Si se quieren conservar para otros disparadores, sus endpoints aceptan `phone` o `from`.

**Soporte humano.** Cuando el bot no puede resolver algo (pide una persona, reclamo, dos mensajes seguidos sin entender)
responde `intencion` = `dudas` y el `message` YA trae el número de soporte (`+593 99 315 7333`). No hace falta otro flow.
Si más adelante se crea un flow "Soporte humano" (texto con wa.me/593993157333 + **Silenciar** 60 min), agregar en el flow 1
la Rule `intencion` = `dudas` → Soporte humano.

**Ubicación nativa.** Revisar en el panel qué variables expone el evento UBICACIÓN y mapearlas a `latitude` y `longitude`.
El endpoint también acepta `lat`/`lng`, un campo `location` con `"lat,lng"`, un link de Google Maps o Waze en `mapsUrl`
o `rawMessage`, y coma decimal (`-2,1577`). Si no llegan coordenadas legibles responde "No pude leer esa ubicación…".

**Alternativa (mantener `/router`).** Si se prefiere conservar el flow de inicio con `/router` y "Enviar al cliente"
apagado, agregar Rules para TODAS las rutas: `conversation` → Catálogo Productos · `human` → Catálogo Productos ·
`catalog` → Catálogo Productos · `checkout` → checkout link de pago · `search_order` → consultar orden. (`/catalog` corre
la misma conversación que `/brain` cuando recibe un mensaje.) Es más lento (dos llamadas por mensaje) y más frágil.

**Seguridad (opcional, recomendado en producción).** Si se define `WHATSAPP_BOT_SECRET` en Vercel, cada nodo HTTP debe
mandar el header `X-Bot-Token: <ese valor>`; sin él las rutas del bot no responden datos (la ruta se reconoce sin importar mayúsculas: `/WHATSAPP-BOT/` también exige el token). Sin la variable, no se exige.

**Robustez ante configuraciones distintas** (todo esto ya lo tolera el backend):
- Body como formulario (`x-www-form-urlencoded`) o `text/plain` con JSON: se lee igual.
- JSON inválido (RAW encendido y el cliente escribe comillas): responde 200 con un mensaje de respaldo, no 400.
- Variables sin reemplazar (`{body}`, `{from}`, `{name}`) se tratan como vacías; `{name}`, `~` o emojis no se usan como nombre.
- Body `multipart/form-data` (nodo en modo form-data): se leen los campos de texto; un archivo adjunto se ignora.
- Teléfono con `+`, con `@s.whatsapp.net` o `:12@…` (dispositivo): misma sesión.
- JID `…@lid` (id de privacidad de WhatsApp: el cliente oculta su número): NO es un teléfono. La sesión se guarda como
  `lid:<id>` (siempre la misma), se registra un warning en el log, la orden queda con `customerPhone` vacío y no se
  buscan pedidos anteriores ni se consultan pedidos por ese id (se le pide escribir al soporte).
- Un reintento se reconoce por mensaje igual + misma pregunta pendiente (paso + elección + cola). "1" a "¿cuál
  tigrillo?" y luego "1" a "¿cuál cola?" son dos respuestas distintas, no un reintento.
- El carrito tiene tope de 50 unidades por producto: el bot dice cuántas agregó de verdad y avisa el tope.
- Audios, imágenes (`_event_media__…`, `_event_voice_note__…`): "solo puedo leer texto y ubicaciones".
- Mensajes seguidos del mismo cliente se procesan en orden (candado por teléfono); un reintento de BuilderBot recibe la
  misma respuesta completa (`orderNumber` y `paymentLink` incluidos) y nunca crea una segunda orden.

## Endpoints para BuilderBot

Todos responden HTTP 200 con
`{ success, message, intencion, telefonoSoporte, route, step, decision, readyToCheckout, orderNumber, paymentLink, cart }`.
**`message` es el texto que BuilderBot debe enviar al cliente** e **`intencion` es la variable para las Rules.**

### La variable `intencion`

| Valor | Cuándo lo devuelve | Qué debe hacer BuilderBot |
|---|---|---|
| `conversar` | Está tomando el pedido (productos, entrega, datos, pago) | Enviar `message` y esperar la respuesta |
| `menu` | El cliente pidió el menú o una categoría | Enviar `message` (puede sumar una imagen del menú) |
| `consultar_pedido` | Preguntó por un pedido suyo | Enviar `message` |
| `orden_creada` | La orden quedó registrada (`orderNumber` y, si es tarjeta, `paymentLink`) | Enviar `message` |
| `dudas` | **Este bot no puede resolverlo**: pidió una persona, tiene un reclamo, o van 2 mensajes seguidos que no se entienden | Derivar al número de soporte (`telefonoSoporte`, hoy +593 99 315 7333) y silenciar el bot |

Este bot es **solo para pedidos**. Todo lo demás sale como `dudas` para que lo tome una persona.

| Flujo BBC | Endpoint | Body mínimo |
|---|---|---|
| Inicio de conversación | `POST /api/orders/whatsapp-bot/brain` | `{ "phone": "{from}", "rawMessage": "{body}", "name": "{name}" }` |
| envian ubicacion nativa | `POST /api/orders/whatsapp-bot/location` | `{ "phone", "latitude", "longitude" }` o `{ "phone", "mapsUrl" }` |
| Catálogo Productos | `POST /api/orders/whatsapp-bot/catalog` | `{ "phone", "message" }` (sin mensaje = menú) |
| checkout link de pago | `POST /api/orders/whatsapp-bot/checkout` | `{ "phone" }` o `{ "phone", "rawMessage" }`. Sin mensaje confirma el resumen (idempotente: si ya existe la orden devuelve la misma). **Con mensaje**, lo clasifica con `classifyConfirmReply` y solo crea la orden si es una confirmación; "gracias" vuelve a mostrar el resumen y "sí, pero agrégale un café" aplica el cambio |
| consultar orden | `POST /api/orders/whatsapp-bot/search-order` | `{ "phone", "message" }`. Solo pedidos de ESE teléfono. Acepta "ORD-00017", "orden 17", "#17" o "17" |

Lo más simple y robusto: **un solo flujo que mande todo a `/brain`** y envíe `message`. Los demás endpoints existen por
compatibilidad con los flujos actuales.

`route` sirve si BuilderBot quiere saltar a otro flujo: `conversation`, `choice`, `catalog`, `location`, `summary`,
`checkout`, `tracking` o `human`.

- `summary`: el bot mostró (o volvió a mostrar) el resumen y espera "confirmo". **No** hay orden todavía.
- `checkout`: **solo** cuando la orden existe (se creó en ese turno, o ya estaba creada y el cliente habla de ella).
  Así una Rule `route = checkout` → flow "checkout link de pago" nunca crea una orden con un "gracias". Además `/checkout`,
  si recibe el mensaje, solo confirma si es una confirmación.

## Qué sucursal atiende y qué pasa si está cerrada

**Gana la sucursal más CERCANA que cubra la dirección, esté abierta o cerrada.** El estado abierto/cerrado NO
decide quién atiende: antes se priorizaban las abiertas y a un cliente del centro (Centro a 1,6 km) le tocaba
Avalon Plaza a 14,1 km con $12,21 de envío. Se cotizan las 3 más cercanas y, además, hasta 2 abiertas más
cercanas, para poder ofrecer una alternativa que atienda ya (`quoteBotLocation`).

Con la sucursal cerrada el bot **no corta la conversación**: dice el horario real y ofrece los dos caminos, sin
decidir por el cliente (paso `closed`):

1. **Programar** el pedido para la próxima apertura ("mañana miércoles 23 a las 07:00").
2. Si hay otra sucursal **abierta** que también cubra, que se lo mande esa — diciendo su envío si cambia. En
   retiro, el equivalente es elegir otro local abierto (la lista marca cuáles atienden ahorita).

El cliente responde hablando normal: "prográmalo", "dale para mañana", "mejor ahora", "que me lo mande la otra",
"¿a qué hora abren?" (esta última repite el horario y no cuenta como "no entendido"). Los detectores están en
`intents.ts` (`wantsSchedule`, `wantsNow`, `wantsOtherOpenBranch`, `asksOpeningHours`); Gemini solo desempata.

Los horarios NUNCA se inventan: salen de `branchOperational.service` (`getNextOpening`, `validateScheduledTime`)
sobre los `openingHours` de Mongo. Elegir la sucursal abierta deja `preferredBranchId` en el estado, así una
recotización por cambio de pago no devuelve al cliente a la sucursal cerrada. Cambiar de sucursal o de modalidad
borra lo programado.

### El pedido programado NO se despacha solo

`createBotOrder` guarda `scheduledFor` con **las mismas reglas que `POST /api/orders`**: fecha válida,
estrictamente futura y dentro del horario de esa sucursal (`validateScheduledTime`). Y despacha **igual que la
web**:

| | Inmediato | Programado |
|---|---|---|
| Picker (efectivo + delivery) | al crear | **no** |
| RunFood (efectivo) | al crear | **no** |
| Meta (efectivo) | al crear | al crear |
| Correo | "Recibimos tu pedido" | "Pedido programado para &lt;fecha larga&gt;" |

Un pedido programado **entra al POS y pide motorizado cuando una persona lo mueve desde el panel**: RunFood al
pasarlo a "En preparación" y Picker a "Listas para recolección" (`updateOrderStatus`). **No existe un cron que lo
haga solo** — `vercel.json` apunta a `/api/cron/payment-reminders`, ruta que no existe, y `scheduler.service.ts`
solo activa y desactiva productos. Es exactamente lo que hace hoy el checkout web; ver
`docs/runfood/verificacion-flujo.md`.

## Probar en vivo sin crear órdenes

```
vercel env pull .env.local --environment=development   # una vez
npm run test:bot:live                                    # conversación de ejemplo contra Mongo, Gemini y Picker de dev
BOT_FORCE_OPEN=1 npm run test:bot:live                   # simula el local abierto (para probar de noche)
# En el servidor de dev (no en producción): arrancarlo con BOT_FORCE_OPEN=1 simula todos los locales abiertos
# para probar el flujo completo por HTTP fuera de horario.
npm run test:bot:live -- "2 humitas" "retiro" "1"        # tu propia conversación
```

`createOrder` está simulado en ese script: no se crean órdenes ni se toca RunFood, PayPhone, Meta o correos.

## Cómo depurar una conversación real

Cada turno escribe en los logs de Vercel: `[whatsapp-bot] +593… R10:ai → paso payment`. La regla (`decision`) dice por
qué el bot respondió lo que respondió. El historial de los últimos 30 mensajes está en `WhatsAppSession.history`.

## Reiniciar una conversación de prueba

Escribir **`reiniciatodo`** (también "Reinicia todo", sin importar mayúsculas ni tildes) en cualquier flow borra la sesión
de ese teléfono: carrito, paso, elección pendiente, historial y candados. Además, los pedidos anteriores dejan de
ofrecerse como "lo mismo de la última vez" (hasta que la sesión expire, 24 h sin mensajes). Las órdenes NO se borran.

`BOT_TEST_PHONE=593995254965` (solo fuera de producción) hace que todos los mensajes usen ese teléfono. Es para probar
por Telegram, donde `{from}` es el id del chat. Quitarla al conectar WhatsApp.

## Flow tipo Sorbito: un solo nodo con `{history}`

Igual que Sorbito de Verdad: el flow "agente que obtiene datos" (o "Inicio de conversación") tiene UN nodo HTTP.

- `POST https://api.boloncity.com/api/orders/whatsapp-bot/assistant` (o `/brain`, es lo mismo)
- Header `Content-Type: application/json`, Body con campos (RAW apagado): `history = {history}`, `phone = {from}`
- Respuesta: **Enviar al cliente ON** con `{message}`
- **Sin Rules.** Ninguna Rule puede apuntar al mismo flow: crea un bucle (pasó el 2026-09-22 contra producción)

Si no llega `rawMessage`, el backend toma **el último mensaje del cliente** dentro de `{history}` (arreglo de
`{ role, content }`, ese arreglo como JSON, o texto con líneas `user:` / `assistant:`). Si además se manda
`rawMessage = {body}`, se usa ese. El estado del pedido vive en Mongo (`WhatsAppSession`), no en el historial.

## `route`: solo 5 valores hacia BuilderBot

La respuesta al cliente solo puede traer `conversation`, `catalog`, `checkout`, `search_order` o `human`.
Las rutas internas del router (`choice`, `summary`, `location`, `tracking`) se traducen con `publicRoute()`
antes de responder: si salieran, una Rule por `route` mandaría al cliente a un flow que no existe (pasó con
`choice` el 2026-09-22, el cliente vio "choice" y la conversación se cortó).

`checkout` sale solo cuando la orden existe. Un "gracias" después de crear la orden es `conversation`.
Recordatorio: lo más simple y lo recomendado es **un solo flow, sin Rules**, que llame a `/assistant` (o
`/brain`) y envíe `{message}`. Ese endpoint conversa hasta tener productos, entrega, local o dirección,
nombre, correo y forma de pago, muestra el resumen y crea la orden con su link.
