# Auditoría de contrato — `runfood.service.ts` vs. API pública de RunFood

- **Archivo auditado:** `boloncity-tienda-backapp/src/services/runfood.service.ts` (153 líneas)
- **Doc de referencia:** https://runfoodapp.github.io/api-docs/ (OpenAPI 3.1.0, "RunFood API 1.0.0")
- **Fecha:** 2026-08-27
- **Contacto del proveedor:** desarrollo@runfoodapp.com

---

## PREGUNTA #1 — ¿Hace falta el API Secret para que las llamadas funcionen?

**No. Las llamadas NO necesitan el API Secret.** La doc es inequívoca sobre la autenticación:

> **Autenticación y scopes** — "Todas las rutas (salvo las públicas) piden un solo header:
> `X-Api-Key: <tu_api_key>`
> **No hay OAuth, ni tokens que caduquen, ni refresh. Una clave, un header.**"

No existe en toda la documentación ningún segundo header de autenticación, ninguna firma HMAC del *request* saliente, ni ningún intercambio de credenciales por un token de sesión. El esquema de seguridad del OpenAPI es uno solo, llamado `X-Api-Key`, y cada operación (`createorder`, `listproducts`, `getappprofile`…) declara bajo "Autorización" únicamente:

> "**X-Api-Key**"

**El único `secret` que existe en la API es el de los webhooks**, y sirve exactamente para lo que sospechábamos:

> **Webhooks → Verificar la firma (HMAC-SHA256)** — "La firma llega en `X-Signature-256` con el formato de GitHub: `sha256=HMAC_SHA256(secret, cuerpo_crudo)`. Calcula lo mismo con tu `secret` sobre el **cuerpo crudo** (sin re-serializar) y compara. […] Si no coinciden, **descarta** el mensaje."

**Conclusión operativa:** nuestro código, que solo manda `X-Api-Key`, está **correcto** para todo lo que hace hoy (crear pedidos y leer catálogo). El Secret **no se usa en ninguna petición saliente**. Como no consumimos webhooks, hoy el Secret no se usa para nada — guardarlo y no usarlo es la conducta correcta.

**Matiz honesto (NO VERIFICADO):** el `secret` de webhooks que documenta RunFood **no se entrega por correo**: lo devuelve la API en la respuesta `201` de `POST /webhooks`, una vez por suscripción, con formato `rfwhk_9f3a...e21c`:

> "**Guarda el `secret`**: solo se muestra aquí y es lo que te permite verificar la firma."

Es decir: la doc **no describe ningún "API Secret" entregado junto con la API Key**. El valor que nos mandaron el 2026-08-20 no corresponde a nada documentado. Lo que sí está probado es que **no hace falta para autenticar**. Qué es exactamente hay que preguntarlo (ver §NO VERIFICADO, punto 1).

---

## Tabla de contraste

| # | Aspecto | Lo que dice la doc | Lo que hace nuestro código | |
|---|---|---|---|---|
| 1 | **Autenticación** | "Una clave, un header": `X-Api-Key: <key>`. Sin OAuth, sin refresh, sin firma de request. | `headers: { "X-Api-Key": config.apiKey }` (L38) | ✅ |
| 2 | **URL base** | "La URL base de cada local te la entregamos junto con la API key. Tiene esta forma: `https://<host-del-local>/api/v1`" | `baseURL: config.baseUrl.replace(/\/$/, "")` — depende de que el valor guardado en BD ya incluya `/api/v1` | ⚠️ |
| 3 | **Multi-tenancy (par URL+key por local)** | "Si integras 50 restaurantes, guardas **50 pares** de (URL base, API key)." | `RunfoodConfig { baseUrl, apiKey }` por sucursal; caché de catálogo indexada por `baseUrl` (L43, L47) | ✅ |
| 4 | **`GET /health` sin credenciales** | Ruta **pública**: "Para comprobar si el local está en línea sin gastar credenciales" | Manda `X-Api-Key` igual (L73, vía `client()`) | ✅ (inofensivo) |
| 5 | **`GET /identity` scope** | Ruta **pública**, sin API key: "Para saber a qué RUC/local estás apuntando antes de autenticar" | Se llama con key (L102). No requiere scope. | ✅ |
| 6 | **`taxes.vat_rate` existe** | Sí: `{ "ruc": "...", "razonSocial": "...", "currency": "USD", "taxes": { "vat_rate": 15 } }` | `identity?.taxes?.vat_rate ?? 15` (L103) | ✅ campo correcto |
| 7 | **Uso del `vat_rate`** | "No escribas la tasa en tu código […] Léela de `GET /identity`." Sirve para calcular `total`. | Se lee, **se pinta en un string de log y nunca se usa** para nada (L103, L141). Llamada de red por pedido a cambio de nada. | ❌ |
| 8 | **`GET /products` paginación** | Query params: `page` (default 1, ≥1), **`limit` (default 50, ≥1, ≤100)**, `search`. | `/products?page=${page}&limit=100` (L52) | ✅ `limit=100` es el máximo legal |
| 9 | **Señal de fin de paginación** | La respuesta trae **`has_more`**: "Solo si pediste paginación. `true` si quedan más páginas." También `count` = "Productos en ESTA respuesta (no el total del catálogo)". | Infiere el fin con `if (batch.length < 100) break` (L55) e impone un tope duro de 10 páginas (L51) | ⚠️ |
| 10 | **Forma de la respuesta de `/products`** | `{ "data": [ … ], "count": 42, "page": 1, "limit": 50, "has_more": true }` | `data?.data \|\| []` (L53) | ✅ |
| 11 | **Campos del producto** | `sku` (oblig.), `name` (oblig.), `price` (oblig., float), `vat_applicable` (oblig., bool), **`active` (oblig., bool)** | Interfaz `RunfoodProduct` sin `active`; no se filtra por `active` (L18-23, L50-56) | ⚠️ |
| 12 | **`price` ¿con o sin IVA?** | **No lo dice.** El esquema solo declara `price: number`. La guía de totales dice "Si vendes una Coca Cola a $1,80 con IVA incluido, lo que mandas **no** es `1.80`" y a la vez el ejemplo trabajado usa "2 Coca Colas a $1,80" como **base imponible** (`2 × 1.80 = 3.60`, IVA `0.54`, total `4.14`) con el catálogo mostrando esa misma Coca Cola en `price: 1.80`. | Manda `unit_price: product.price` tal cual (L119), asumiendo que es base | ⚠️ NO VERIFICADO |
| 13 | **`POST /orders` — `status: "open"`** | Válido y documentado: "Camino 1 — Pedido abierto (`status: "open"`): crea el pedido **sin** facturarlo: la comanda va a cocina y se cobra más tarde. Las cuentas **no** llevan `payments`." | `status: "open"` (L129), sin `payments` | ✅ |
| 14 | **`tabs[].items[]` acepta `sku`, `quantity`, `unit_price`** | Sí. Además admite `discount`, `line_total`, `vat_applicable`, `notes` (≤255), `metadata` (≤30 llaves), `modifiers` (≤20). | Manda exactamente `{ sku, quantity, unit_price }` (L114-120) | ✅ |
| 15 | **¿`unit_price` es obligatorio?** | **Obligatorio.** "Tú declaras el precio con el que vendes — RunFood **no** lo toma del catálogo. Si lo omites, recibes `400 validation_error`. Se permite `0`, nunca un negativo." | Siempre lo manda | ✅ formalmente |
| 16 | **¿Qué precio debe ir en `unit_price`?** | "El precio con el que **vendes**." RunFood valida contra él, no contra su catálogo. | Manda el precio del **catálogo del local**, no el precio al que Boloncity vendió y cobró por PayPhone (L117-119) | ⚠️ |
| 17 | **`total` de la cuenta** | Obligatorio **solo en venta directa / al facturar** (`status: "closed"`): "debe igualar la suma de los `payments` […] debe coincidir (±1¢) con lo que calcula RunFood". En pedido abierto no se envía. | No lo manda | ✅ |
| 18 | **`external_id` a nivel de orden Y de tab** | Correcto y recomendado: "`external_id` (del pedido) y `tabs[].external_id` (de cada cuenta) deben ser únicos en tu sistema." | `external_id: orderNumber` + `tabs[0].external_id: ${orderNumber}-1` (L128, L132) | ✅ |
| 19 | **Largo máximo de `name` del tab** | **120 caracteres.** "Largos máximos: `external_id` y `reference` 64 · `name` 120 · `notes` 255 · `sku` 64 · `table_number` 20." | `.slice(0, 60)` (L126) — la mitad del cupo | ⚠️ |
| 20 | **Largo de `external_id`** | 64 caracteres | `orderNumber` y `${orderNumber}-1` — muy por debajo | ✅ |
| 21 | **Idempotencia → 409** | "Si reenvías el mismo `external_id`, el API responde **`409 duplicate_order`** con el id del pedido que ya existía. […] **Esto es la idempotencia funcionando** — no lo trates como fallo." | Trata el 409 como éxito (L144-147) | ✅ en intención |
| 22 | **Código de error en el body del 409** | `{"error": "duplicate_order", "message": "...", "id": <id del pedido existente>, "status": "..."}`. Pero **`409` también puede ser `conflict`, `nothing_to_invoice`, `xml_not_available`, `pdf_not_available`**, y `409 conflict` **sí es reintentable**. | Trata **cualquier** 409 como duplicado exitoso, sin mirar `data.error` (L144). Además descarta el `id` del pedido existente que viene en el body. | ❌ |
| 23 | **"Programa contra `error`, no contra `message`"** | "`error` es un código estable — programa contra él, no contra `message`, que es texto legible y puede cambiar sin aviso." | Nunca lee `data.error`; serializa el body entero a un string de 180 chars (L148) | ❌ |
| 24 | **`X-Request-Id`** | "**Toda** respuesta lleva la cabecera `X-Request-Id`. Guárdala: es lo que permite encontrar tu petición exacta en los logs del servidor si reportas un fallo." | No se lee ni se loguea nunca | ⚠️ |
| 25 | **Rate limit** | **10 req/s sostenidas, ráfaga de 40**, *por app* (no por IP) → `429 rate_limited`. Headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, y `Retry-After` (solo en 429). | 3 peticiones por pedido (identity + products + orders). Sin lectura de headers, sin respeto de `Retry-After`. | ⚠️ |
| 26 | **Qué reintentar** | "`429`, `409 conflict`, `5xx`, timeout de red → **Sí**, con backoff exponencial. `409 duplicate_order` → **No**. `4xx` de validación → **No**." | **Cero reintentos.** Cualquier 429/5xx/timeout devuelve `ok:false` y el pedido nunca llega a cocina. | ❌ |
| 27 | **El local se cae — es lo normal** | "Que el servidor no responda **no es una excepción, es el día a día**. **Encola y reintenta**; no asumas que la primera llamada llega." | Un solo intento, falla suave, sin cola | ❌ |
| 28 | **Timeout de request** | **No hay recomendación en la doc.** Los ejemplos oficiales en PHP usan `CURLOPT_TIMEOUT => 30`. | `TIMEOUT_MS = 12_000` (L32) | ⚠️ NO VERIFICADO |
| 29 | **Tamaño del body** | 1 MB → `413 payload_too_large`; ≤50 cuentas por pedido; **≤500 ítems por cuenta** | 1 tab, N ítems de un carrito web — sin riesgo | ✅ |
| 30 | **Scopes necesarios** | `orders:write` = "Crear pedidos, editar sus ítems, anularlos". `products:read` = "Consultar el catálogo". `GET /health` y `GET /identity` son **rutas públicas** (sin key, sin scope). `GET /apps/me` requiere `apps:read`. `GET /payment-methods` requiere `payment-methods:read`. | Solo usa `/health`, `/identity`, `/products`, `POST /orders` | ✅ `orders:write` + `products:read` **alcanzan** |
| 31 | **Emparejar ítems por nombre** | La doc **nunca** propone emparejar por nombre. Su modelo es: "primero mira el catálogo, después pide", sincronizando **`sku` por local**: "Los `sku` […] son de ese local. No los compartas entre clientes". No garantiza unicidad de `name`. | Empareja por nombre normalizado; `new Map(...)` se queda con el **último** en caso de nombres repetidos (L105, L109) | ⚠️ |
| 32 | **`service_type`** | Campo de primer nivel: "Tipo de servicio (delivery, pickup, dine-in, etc.)", ejemplo `"delivery"`. También existe `delivery_address { address, reference, lat, lng }`. | No se manda; el tipo se mete a mano dentro del `name` del tab: `"RETIRO/DELIVERY WEB …"` (L126) | ⚠️ |
| 33 | **`notes`** | Existe en el ítem (`≤255`) y en el pedido. | `params.notes` se recibe en la firma (L96) y **se descarta silenciosamente** — nunca entra al payload | ❌ |
| 34 | **`print`** | "Auto-imprimir ticket de cocina (y factura si `status=closed`). boolean, **default: true**." La respuesta trae `print_result { status: dispatched\|sent\|skipped\|no_printers\|error, printers[], message }`. | No lo manda (usa el default `true`, correcto) pero **ignora `print_result`**: si el local responde `no_printers` o `error`, damos "Pedido enviado" y la comanda nunca salió por la impresora. | ⚠️ |
| 35 | **`id` de la respuesta 201** | `id` (obligatorio, integer) = id del pedido. Ojo: `tabs[].id` **viene `null` en la creación**. | `response.data?.id` (L140) | ✅ |
| 36 | **Marcar "pagado en línea"** | Ver §Pregunta 8 abajo. | — | ⚠️ |

---

## Pregunta 8 — ¿Se puede marcar el pedido como "pagado en línea"?

**No con nuestros scopes actuales, y no dentro de un pedido abierto.** La doc no ofrece ningún campo de "ya cobrado" para `status: "open"`:

> **Camino 1 — Pedido abierto (`status: "open"`)** — "Crea el pedido **sin** facturarlo: la comanda va a cocina y se cobra más tarde. **Las cuentas no llevan `payments`.**"

El único lugar donde se registra el método de pago es `tabs[].payments[]`, y ese array solo se acepta cuando se factura:

> `payments[]` → `{ payment_method_id, payment_method_name, amount, tendered, tip, transaction_number, note }`, donde `payment_method_name` es el "Nombre del método (`descripcion`, case-insensitive). Ver `GET /payment-methods` → `name`" y `amount` es "obligatorio […] **Mayor que 0**".

Y eso implica **venta directa** (`status: "closed"`), que exige además `billing` y `total`, y **requiere el scope `invoices:write`**:

> "`insufficient_scope` — Te falta el scope (**¿es una venta directa? necesitas también `invoices:write`**)"
> "**Cada** cuenta necesita `billing`, `payments` y `total`."

Existe el código de error `payments_not_allowed` justamente para el caso de mandar `payments` en un pedido abierto.

**Alternativas viables sin `invoices:write`:**
1. Dejarlo escrito en el `name` del tab / en `notes` del ítem (texto que ve el cajero) — es lo que de facto hacemos hoy, a medias.
2. Usar `metadata` (≤30 llaves) del ítem o `reference` del pedido/tab (≤64) para guardar el id de la transacción PayPhone — dato estructurado, pero **no altera el cobro en el POS**: el cajero igual tiene que cerrar la cuenta.
3. Pedir `invoices:write` y pasar a venta directa (`status: "closed"` + `billing` + `payments` + `total`). Esto cambia el modelo de negocio: la factura al SRI la emitiría RunFood en el momento de la comanda, con los datos de facturación que le mandemos, y exigiría calcular `total` al centavo. **No recomendado sin decisión explícita del cliente.**

`GET /payment-methods` requiere el scope `payment-methods:read`, que tampoco tenemos, y por sí solo no sirve de nada sin `invoices:write`.

---

## Defectos concretos, con parche sugerido

### ❌ 1. Cualquier `409` se trata como duplicado exitoso
**`runfood.service.ts:144-147`**

```ts
if (err.response?.status === 409) {
  return { ok: true, duplicated: true, message: `El pedido ya estaba en el POS RunFood (idempotencia ${orderNumber})` };
}
```

`409` también puede ser `conflict` (que la doc marca como **reintentable**), `nothing_to_invoice`, `xml_not_available` o `pdf_not_available`. Devolver `ok: true` ante un `409 conflict` significa dar por enviada una comanda que nunca se creó. Además se tira el `id` del pedido existente que RunFood devuelve en el body.

```ts
const code = (err.response?.data as { error?: string } | undefined)?.error;
if (err.response?.status === 409 && code === "duplicate_order") {
  const existingId = (err.response.data as { id?: number })?.id;
  return {
    ok: true,
    duplicated: true,
    orderId: existingId,
    message: `El pedido ya estaba en el POS RunFood (idempotencia ${orderNumber}${existingId ? `, #${existingId}` : ""})`,
  };
}
```

### ❌ 2. Cero reintentos ante `429` / `5xx` / timeout
**`runfood.service.ts:139` (y todo el `catch` L142-152)**

La doc lo pide de forma explícita ("`429`, `409 conflict`, `5xx`, timeout de red → **Sí**, con backoff exponencial") y advierte que el servidor caído "no es una excepción, es el día a día". Hoy, un router reiniciándose = comanda perdida en silencio.

```ts
const RETRYABLE = (status?: number, code?: string) =>
  status === undefined || status === 429 || status >= 500 || (status === 409 && code === "conflict");

async function postOrderWithRetry(http: AxiosInstance, payload: unknown, attempts = 3) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await http.post("/orders", payload);
    } catch (err) {
      lastErr = err;
      if (!axios.isAxiosError(err)) throw err;
      const status = err.response?.status;
      const code = (err.response?.data as { error?: string } | undefined)?.error;
      if (status === 409 && code === "duplicate_order") throw err; // idempotencia: no reintentar
      if (!RETRYABLE(status, code) || i === attempts - 1) throw err;
      const retryAfter = Number(err.response?.headers?.["retry-after"]);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** i * 500;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
```

> Nota: un reintento en caliente cubre el router lento, no el local apagado 20 minutos. Para eso hace falta una **cola persistente** (la doc: "Encola y reintenta"). Fuera del alcance de este archivo, pero es la deuda real.

### ❌ 3. `notes` se recibe y se tira a la basura
**`runfood.service.ts:96` (firma) — nunca aparece en el payload de L127-137**

Las indicaciones del cliente ("sin cebolla", alergias) no llegan a cocina. `notes` existe en el ítem con tope de 255 caracteres.

```ts
// en el map de items (L114-120):
return {
  sku: product.sku,
  quantity: item.quantity,
  unit_price: product.price,
  ...(params.notes ? { notes: params.notes.slice(0, 255) } : {}),
};
```

(Ideal: que `params.items[]` traiga su propia nota por ítem en vez de una nota global del pedido.)

### ❌ 4. `GET /identity` en cada pedido para un dato que no se usa
**`runfood.service.ts:102-103` y `141`**

```ts
const { data: identity } = await http.get("/identity");
const vatRate = Number(identity?.taxes?.vat_rate ?? 15);
```

`vatRate` solo termina interpolado en el mensaje de éxito (L141). Es una llamada de red por pedido, en un servidor on-premise detrás de una IP residencial, a cambio de un texto de log — y encima con un fallback `?? 15` que la doc prohíbe explícitamente ("**No escribas la tasa en tu código** […] Si la fijas a mano, funcionará con un cliente y te dará `422 total_mismatch` con el siguiente").

O se elimina, o se cachea junto al catálogo (el `vat_rate` cambia con la misma frecuencia que el catálogo: poca):

```ts
// cachear con el catálogo, mismo TTL, misma clave baseUrl
const identityCache = new Map<string, { at: number; vatRate: number }>();
```

Si mañana pasamos a venta directa, el `vat_rate` **sí** se vuelve obligatorio para calcular `total`; hasta entonces, no debería costar un round-trip por pedido.

### ❌ 5. Se programa contra `message`, no contra `error`
**`runfood.service.ts:148`**

```ts
const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0, 180)}` : ...
```

La doc: "**Programa contra `error`, nunca contra `message`.**" Además se pierde el `X-Request-Id`, que es lo único que RunFood puede rastrear en sus logs.

```ts
const code = (err.response?.data as { error?: string } | undefined)?.error ?? "sin_codigo";
const reqId = err.response?.headers?.["x-request-id"] ?? "";
const detail = err.response
  ? `${err.response.status} ${code}${reqId ? ` (req ${reqId})` : ""}`
  : err.code || err.message;
```

### ⚠️ 6. Paginación por heurística en vez de `has_more`, con tope silencioso de 1000 productos
**`runfood.service.ts:51-56`**

`limit=100` es legal (máximo documentado), y `batch.length < 100` funciona **por casualidad** mientras el servidor honre el `limit` pedido. La doc expone `has_more` justo para no adivinar. Y el `page <= 10` corta el catálogo en 1000 productos **sin avisar a nadie**.

```ts
for (let page = 1; page <= 20; page++) {
  const { data } = await http.get(`/products?page=${page}&limit=100`);
  const batch: RunfoodProduct[] = data?.data || [];
  products.push(...batch.filter((p) => p.active !== false));
  if (!data?.has_more) break;
  if (page === 20) console.warn(`[runfood] catálogo truncado en 2000 productos para ${config.baseUrl}`);
}
```

### ⚠️ 7. No se filtran los productos inactivos
**`runfood.service.ts:18-23` y `50-56`**

`active` es un campo **obligatorio** de la respuesta y no está ni en la interfaz. Un producto dado de baja en el POS pero con nombre coincidente se empareja igual y puede acabar en `400 product_not_found`. Parche: añadir `active: boolean` a `RunfoodProduct` y el `.filter()` del punto 6.

### ⚠️ 8. Emparejar por nombre es invención nuestra
**`runfood.service.ts:105, 109`**

La doc modela la integración como "sincroniza el `sku` **por local**" y no garantiza que `name` sea único. `new Map(catalog.map(...))` se queda con el último producto en caso de nombres repetidos, sin avisar. Es el punto más frágil del servicio: un cambio cosmético de nombre en el POS del local ("Bolón Mixto" → "Bolon mixto grande") rompe el pedido entero, porque `if (missing.length) return { ok: false }`.

Parche estructural (no de una línea): guardar el `sku` de RunFood **por sucursal** en nuestro modelo de producto (un mapa `productId → { branchId, runfoodSku }`), sincronizado con `pnpm` script como se hace con las llaves de Picker, y dejar el match por nombre solo como fallback con log de advertencia.

### ⚠️ 9. `unit_price` es el precio del local, no el nuestro
**`runfood.service.ts:117-119`**

```ts
// El catalogo del local ya tiene el precio base; usarlo evita descuadres
// por redondeo entre nuestro precio con IVA y su base.
unit_price: product.price,
```

La doc dice lo contrario de lo que asume el comentario: "Tú declaras el precio **con el que vendes** — RunFood **no** lo toma del catálogo." Si el precio web de Boloncity difiere del precio del POS (promoción online, precio de delivery), la cuenta que ve el cajero **no cuadra con lo que el cliente ya pagó por PayPhone**, y nadie se entera hasta el cierre de caja.

Mientras el pedido sea `open` esto no rompe ninguna validación (no mandamos `total`), pero es una discrepancia contable real. Decisión de producto, no de código — anotarla y confirmarla con el cliente.

### ⚠️ 10. `print_result` ignorado
**`runfood.service.ts:139-141`**

La respuesta `201` trae `print_result.status` ∈ `dispatched | sent | skipped | no_printers | error`. Hoy devolvemos "Pedido enviado al POS RunFood (#123)" aunque el status haya sido `no_printers`. La comanda existe en la base del POS pero **no salió por la impresora de cocina**, que es el único motivo por el que hacemos todo esto.

```ts
const printStatus = response.data?.print_result?.status;
const printWarn = printStatus && !["dispatched", "sent"].includes(printStatus)
  ? ` — ⚠️ impresión: ${printStatus}` : "";
return { ok: true, orderId, message: `Pedido enviado al POS RunFood${orderId ? ` (#${orderId})` : ""}${printWarn}` };
```

### ⚠️ 11. `service_type` disponible y sin usar
**`runfood.service.ts:126-137`**

Existe `service_type: "delivery" | "pickup" | "dine-in" | …` como campo de primer nivel, más `delivery_address { address, reference, lat, lng }`. Hoy lo codificamos como prefijo de texto en el `name` del tab.

```ts
const payload = {
  external_id: orderNumber,
  status: "open",
  service_type: params.deliveryType === "pickup" ? "pickup" : "delivery",
  tabs: [{ external_id: `${orderNumber}-1`, name: label, items }],
};
```

### ⚠️ 12. `name` del tab recortado a 60 cuando el límite es 120
**`runfood.service.ts:126`**

`.slice(0, 60)` desperdicia la mitad del cupo documentado y trunca nombres de cliente largos. Subir a `.slice(0, 120)`.

> Ojo con dos cosas de la doc al tocar este string: (a) los emojis y tildes se **aceptan** (son XML 1.0 válido) pero "una impresora térmica […] probablemente no pueda dibujar un emoji en el recibo"; el guion largo `—` que usamos hoy corre el mismo riesgo. (b) Los **caracteres de control** se rechazan con `400`. Si `customerName` viene de un input libre, conviene sanearlo.

---

## NO VERIFICADO — preguntas para desarrollo@runfoodapp.com

1. **¿Qué es el "API Secret" que nos entregaron por correo el 2026-08-20?**
   La guía de autenticación dice "una clave, un header" y el único `secret` documentado es el de cada suscripción de webhook, que la propia API devuelve en el `201` de `POST /webhooks` con formato `rfwhk_…` — no por correo. ¿El valor que nos mandaron es (a) un secret de webhook pre-provisionado, (b) una credencial para rotar/regenerar la API Key, (c) un resto de otro flujo? **Confirmar explícitamente que ninguna petición a la API lo necesita.**

2. **¿`GET /products.price` viene con IVA incluido o es la base imponible?**
   El esquema solo declara `price: number`, sin descripción. La guía de totales dice "si vendes una Coca Cola a $1,80 con IVA incluido, lo que mandas **no** es `1.80`", pero el ejemplo trabajado toma "2 Coca Colas a $1,80" como base (`3.60` + IVA `0.54` = `4.14`) y el catálogo de ejemplo muestra esa Coca Cola en `price: 1.80`. **Es la ambigüedad más cara de la doc**: si `price` es IVA-incluido, todo pedido nuestro está inflando la base imponible en un 15%. Hoy no explota porque no facturamos, pero explota el día que pasemos a venta directa.

3. **Contradicción en la definición de `line_total`.**
   La referencia de `POST /orders` dice: "Neto que TÚ calculaste para esta línea: `round(unit_price × quantity, 2) − discount`, **sin IVA**". La guía de totales dice: "`line_total`: el total de esa línea **con IVA**: `unit_price × quantity − discount + IVA`". ¿Cuál rige? (No nos afecta hoy porque no lo mandamos, pero lo necesitamos si activamos la validación por línea.)

4. **¿Timeout recomendado para un servidor on-premise detrás de IP residencial / túnel gestionado?**
   La doc no lo menciona; los ejemplos oficiales en PHP usan 30 s. Nuestros 12 s son un número inventado por nosotros. Con el túnel gestionado de RunFood de por medio, ¿cuál es el p99 razonable de `POST /orders`? (Nuestro backend corre en Vercel serverless, donde el presupuesto total de la request es limitado, así que necesitamos un número real, no "reintenta".)

5. **¿`GET /identity` es realmente público (sin API key) también en producción?**
   La tabla de rutas públicas lo lista junto a `/health`, pero el ejemplo de "empieza en 5 minutos" lo llama con `-H "X-Api-Key: $KEY"`. Nos importa para el health-check por sucursal.

6. **Reconciliación de pedidos abiertos.** La propia doc admite el hueco:
   > "**No existe un listado de pedidos.** Solo `GET /orders/{id}` […] Si tu integración depende de pedidos **abiertos** (no facturados), hoy no tienes forma de reconciliarlos. **Si ese es tu caso, escríbenos** antes de diseñar tu arquitectura sobre esta limitación."

   Es exactamente nuestro caso. ¿Qué alternativa hay para saber si un pedido nuestro llegó, sin guardar el `id` que devuelve el `201`? (Guardar el `id` de RunFood en nuestra orden es, de todas formas, algo que hoy **no hacemos** y deberíamos.)

7. **¿`ORDER.CREATED` / `ORDER.CLOSED` nos serviría para confirmar que la comanda se imprimió?**
   Hoy no consumimos webhooks. Si terminamos consumiéndolos, ahí sí el `secret` HMAC pasa a ser obligatorio (y con él el scope `webhooks:write`). Nota de diseño de RunFood a tener en cuenta: **"no hay reintentos"** de entrega de webhooks.

8. **¿Se puede registrar "pagado en línea" sin `invoices:write`?**
   Ver §Pregunta 8. Queremos que el cajero vea que el pedido ya está cobrado por PayPhone sin que Boloncity asuma la emisión del comprobante. ¿Hay alguna convención (una forma de pago del local llamada "WEB/PAYPHONE", un campo `reference`) que RunFood recomiende para esto?
