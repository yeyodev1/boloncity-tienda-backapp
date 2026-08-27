# Sondeo POS RunFood on-premise — 8 locales Boloncity

- Fecha: 2026-08-27
- App: `boloncity_web` · API key `EA8A45…` (truncada; una sola key para los 8 locales, el local lo define la URL base)
- Auth: header `X-Api-Key`
- Sondeos **solo de lectura** (`GET /health`, `/identity`, `/apps/me`, `/products`). No se envió ningún `POST /orders`.
- Timeout individual 8 s, los 8 en paralelo, un reintento para los que fallaron.

## Resumen

| Local | URL | /health | /identity (nombre + IVA) | scopes ok | #productos | latencia | veredicto |
|---|---|---|---|---|---|---|---|
| La Joya | http://186.3.149.51:1000/api/v1 | ECONNREFUSED | — | — | — | 4.1–7.2 s hasta el fallo | **CAÍDO** |
| Kennedy | http://181.198.203.171:1000/api/v1 | ECONNREFUSED / TimeoutError | — | — | — | 5.4–10.2 s hasta el fallo | **CAÍDO** |
| Centro | http://181.39.245.89:1000/api/v1 | ECONNREFUSED | — | — | — | 4.3–7.4 s hasta el fallo | **CAÍDO** |
| Garzota | http://181.198.245.112:1000/api/v1 | ECONNREFUSED | — | — | — | 7.2–7.3 s hasta el fallo | **CAÍDO** |
| Urdesa | http://186.101.243.150:1000/api/v1 | 200 | `BOLONCITY URDESA` · **IVA no expuesto** | **no verificable** (`/apps/me` 403) | 1790 | health 307 ms · identity 179 ms · products 1187 ms | **LISTO** |
| República | http://186.4.130.151:1000/api/v1 | 200 | `BOLONCITY REPUBLICA` · **IVA no expuesto** | **no verificable** (`/apps/me` 403) | 1790 | health 440 ms · identity 207 ms · products 1768 ms | **LISTO** |
| Avalon Plaza | http://186.3.235.200:1000/api/v1 | 200 | `BOLONCITY AVALON` · **IVA no expuesto** | **no verificable** (`/apps/me` 403) | 1790 | health 303 ms · identity 165 ms · products 1189 ms | **LISTO** |
| Vía a la Costa | http://181.39.229.202:1000/api/v1 | 200 | `BOLONCITY BLUE COAST` · **IVA no expuesto** | **no verificable** (`/apps/me` 403) | 1790 | health 314 ms · identity 189 ms · products 1388 ms | **LISTO** ⚠️ alias a confirmar |

Conteo: **4 LISTO · 4 CAÍDO · 0 credencial rechazada · 0 identidad cruzada**.

## Hallazgos que rompen el contrato asumido

1. **`/identity` NO devuelve `taxes.vat_rate`.** El objeto real no tiene ningún campo de impuestos.
   Campos reales: `ruc, razonSocial, nombreComercial, establecimiento, bodega, ciudad, version, channel, fingerprint, capabilities, requiresApproval`.
   El nombre del local viene en **`nombreComercial`**, no en `name`. Hay que pedir a RunFood dónde vive la tasa de IVA o fijarla del lado nuestro (15 % Ecuador).
2. **`/apps/me` devuelve 403 en los 4 locales vivos**: `{"error":"insufficient_scope","message":"This app does not have the 'apps:read' scope required for this endpoint"}`.
   Los scopes `orders:write` / `products:read` **no se pueden confirmar por API**: el endpoint exige un scope `apps:read` que la app no tiene. **No es credencial rechazada** — la misma key responde 200 en `/identity` y `/products`. Para cerrar esto hace falta que RunFood agregue `apps:read` o confirme los scopes por correo.
3. **`/products` ignora la paginación.** Con `?page=1&limit=100` devuelve `{ data: [...], count: 1790 }` con los **1790** productos de golpe (~sin headers `x-total-count` / `link`). No hay más páginas: es un volcado completo. Conviene cachear.
4. **El campo de IVA por producto es `tax_applicable`, no `vat_applicable`** (booleano).
5. **`establecimiento` es `"004"` en los cuatro locales**; lo que distingue al local es **`bodega`** (Urdesa 1, República 13, Avalon 18, Vía a la Costa 21). No usar `establecimiento` como identificador de sucursal.
6. **Versiones y canales heterogéneos**: Urdesa `18.0.4` en canal `dev_ft-optimizaciones-abril2026`; República y Avalon `18.0.4` en `dev_HEAD`; Vía a la Costa `18.0.6` en `dev_HEAD`. Ninguno está en un canal estable de producción.
7. **Solo Vía a la Costa trae RUC y razón social pobladas** (`0993372207001` / `BOLONCORP S A S`). En Urdesa, República y Avalon `ruc`, `razonSocial` y `ciudad` vienen **vacíos**, y aun así declaran `capabilities: ["electronic-invoicing"]`. Facturación electrónica desde esos tres es dudosa hasta poblar el RUC.

## Verificación de identidad (riesgo de IP cruzada)

Cada IP viva devolvió el nombre del local que se esperaba: Urdesa → `BOLONCITY URDESA`, República → `BOLONCITY REPUBLICA`, Avalon → `BOLONCITY AVALON`. **No se detectó ninguna IP cruzada.**

⚠️ Excepción a confirmar con el cliente: la IP de **Vía a la Costa** responde `BOLONCITY BLUE COAST`. No corresponde al nombre de ningún otro de los 8 locales, por lo que casi seguro es el **alias comercial** de esa sucursal (Blue Coast ≈ Vía a la Costa) y no un cruce. Aun así, **antes de encender esa sucursal hay que confirmar por escrito** que `bodega 21` / `fingerprint fp-514365de` es el local de Vía a la Costa: un cruce aquí imprimiría comandas en la cocina equivocada.

## Nota sobre los 4 caídos

El sondeo TCP directo al puerto 1000 devolvió `ECONNREFUSED` en los cuatro, pero **tras 4–10 s** (una negativa real es instantánea). Eso apunta a NAT/firewall del ISP descartando el SYN, o a que el servidor RunFood no está levantado tras una IP residencial dinámica — no a que el puerto rechace activamente. Kennedy además dio `TimeoutError` a los 10 s en el primer intento. Todos los locales tuvieron **un reintento** antes de declararse caídos. Al ser IPs residenciales, conviene reintentar en otro horario antes de escalar a RunFood.

## JSON crudo de referencia (Urdesa — respondió bien)

`GET /identity`

```json
{
  "ruc": "",
  "razonSocial": "",
  "nombreComercial": "BOLONCITY URDESA",
  "establecimiento": "004",
  "bodega": 1,
  "ciudad": "",
  "version": "18.0.4",
  "channel": "dev_ft-optimizaciones-abril2026",
  "fingerprint": "fp-0000e0f1",
  "capabilities": [
    "electronic-invoicing"
  ],
  "requiresApproval": false
}
```

`GET /apps/me` → **HTTP 403**

```json
{
  "error": "insufficient_scope",
  "message": "This app does not have the 'apps:read' scope required for this endpoint"
}
```

`GET /products?page=1&limit=100` → HTTP 200, forma `{ "data": [...1790 items...], "count": 1790 }`

```json
{"sku":"1","name":"BOLON QUESO VERDE","price":3.2609,"tax_applicable":true,"active":true}
```

Primeros 5 productos (idénticos en los 4 locales vivos — catálogo compartido):

| sku | name | price | tax_applicable |
|---|---|---|---|
| 1 | BOLON QUESO VERDE | 3.2609 | true |
| 2 | BISTEC DE CARNE | 4.782609 | true |
| 3 | BOLONMIXTO+CAFE+JUGO | 4.46 | true |
| 4 | CANOA VERDE | 5.208696 | true |
| 5 | BOLON DE CHICHARRON VERDE | 3.3913 | true |

Los precios vienen con 4–6 decimales (base sin impuesto). Hay que definir el redondeo antes de mostrarlos en la tienda.
