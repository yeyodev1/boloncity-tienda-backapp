# Emparejamiento de catálogos Boloncity ↔ RunFood

Sondeo del 2026-08-27. Solo lectura: `GET /identity` y `GET /products` con `X-Api-Key` (key `EA8A45…`). Ningún POST.

Fuente Boloncity: Mongo **producción**, colección `products` (191 documentos, todos `isAvailable: true`). Un producto se ofrece en una sucursal si no está en `unavailableBranches` y `branches` está vacío o la incluye (`isAvailableAt` en `src/controllers/product.controller.ts`).

La comparación replica exactamente `normalizeName` de `src/services/runfood.service.ts`: NFD → quitar diacríticos → colapsar espacios → trim → minúsculas. **El emparejamiento del servicio es por NOMBRE, no por SKU**, y si un solo ítem falla no se envía nada al POS.

## Riesgo, en una línea

Hay **5 productos** (de 191) cuyo nombre en Boloncity no existe en el catálogo del POS. Cualquier pedido que incluya uno de ellos **no llega a cocina** — el pedido se cobra por PayPhone, se reserva en Picker y la comanda nunca se imprime; solo queda una nota de auditoría en la orden.

## Resumen por sucursal

| Local | # productos Boloncity | match | sin match | % cobertura | dudosos | POS |
|---|---|---|---|---|---|---|
| Boloncity Centro | 184 | 180 | 4 | 97.8 % *(proyectado)* | 20 | **NO SONDEABLE** |
| Boloncity Garzota | 179 | 176 | 3 | 98.3 % *(proyectado)* | 19 | **NO SONDEABLE** |
| Boloncity Kennedy | 181 | 179 | 2 | 98.9 % *(proyectado)* | 20 | **NO SONDEABLE** |
| Boloncity Urdesa | 189 | 185 | 4 | 97.9 % | 20 | respondió |
| Boloncity Vía a la Costa | 176 | 172 | 4 | 97.7 % | 20 | respondió |
| Boloncity República | 132 | 129 | 3 | 97.7 % | 12 | respondió |
| Boloncity La Joya | 173 | 170 | 3 | 98.3 % *(proyectado)* | 20 | **NO SONDEABLE** |
| Boloncity Avalon Plaza | 182 | 179 | 3 | 98.4 % | 20 | respondió |

**NO SONDEABLE** = el servidor del local no aceptó la conexión desde aquí (3 intentos, timeout 9 s): Centro, Garzota, Kennedy y La Joya. No es 0 % de cobertura: es que no se pudo comprobar. Los porcentajes de esas cuatro filas son una **proyección** sobre el catálogo maestro, no una medición.

Los 4 locales que sí respondieron (Urdesa, Vía a la Costa, República, Avalon) devuelven **catálogos byte a byte idénticos**: los mismos 1790 SKU, los mismos 1762 nombres y los mismos precios. Es un catálogo central replicado, así que la proyección para los 4 caídos es razonable — pero hay que confirmarla cuando esos servidores estén en línea.

## Sin match, por sucursal

### Boloncity Centro — NO SONDEABLE (proyección sobre el catálogo maestro)

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| EMPANADA DE VERDE (POLLO) | `2090` | $4.8 | COCINA / TIPICOS | EMPANADA DE VERDE (POLLO ) (sku `2090`) | 1 | **EMPANADA DE VERDE (POLLO )** |
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |
| JUGO PURO NARANJA BOTELLA | `BJPNJA006` | $3.3 | BEBIDAS / JUGOS | JUGO NARANJA BOTELLA (sku `BJNJA002`) | 5 | **JUGO PURO NARANJA BOTELLA 500ML** |

### Boloncity Garzota — NO SONDEABLE (proyección sobre el catálogo maestro)

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |
| JUGO PURO NARANJA BOTELLA | `BJPNJA006` | $3.3 | BEBIDAS / JUGOS | JUGO NARANJA BOTELLA (sku `BJNJA002`) | 5 | **JUGO PURO NARANJA BOTELLA 500ML** |

### Boloncity Kennedy — NO SONDEABLE (proyección sobre el catálogo maestro)

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |

### Boloncity Urdesa

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| EMPANADA DE VERDE (POLLO) | `2090` | $4.8 | COCINA / TIPICOS | EMPANADA DE VERDE (POLLO ) (sku `2090`) | 1 | **EMPANADA DE VERDE (POLLO )** |
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |
| JUGO PURO NARANJA BOTELLA | `BJPNJA006` | $3.3 | BEBIDAS / JUGOS | JUGO NARANJA BOTELLA (sku `BJNJA002`) | 5 | **JUGO PURO NARANJA BOTELLA 500ML** |

### Boloncity Vía a la Costa

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| EMPANADA DE VERDE (POLLO) | `2090` | $4.8 | COCINA / TIPICOS | EMPANADA DE VERDE (POLLO ) (sku `2090`) | 1 | **EMPANADA DE VERDE (POLLO )** |
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |
| JUGO PURO NARANJA BOTELLA | `BJPNJA006` | $3.3 | BEBIDAS / JUGOS | JUGO NARANJA BOTELLA (sku `BJNJA002`) | 5 | **JUGO PURO NARANJA BOTELLA 500ML** |

### Boloncity República

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |
| JUGO PURO NARANJA BOTELLA | `BJPNJA006` | $3.3 | BEBIDAS / JUGOS | JUGO NARANJA BOTELLA (sku `BJNJA002`) | 5 | **JUGO PURO NARANJA BOTELLA 500ML** |

### Boloncity La Joya — NO SONDEABLE (proyección sobre el catálogo maestro)

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |
| JUGO PURO NARANJA BOTELLA | `BJPNJA006` | $3.3 | BEBIDAS / JUGOS | JUGO NARANJA BOTELLA (sku `BJNJA002`) | 5 | **JUGO PURO NARANJA BOTELLA 500ML** |

### Boloncity Avalon Plaza

| Producto Boloncity | code | Precio | Categoría | Candidato más cercano en el POS | Lev. | Entrada del POS con ESE MISMO SKU |
|---|---|---|---|---|---|---|
| CAFE AMERICANO PASADO | `4348` | $1.92 | BEBIDAS / CAFE | CAFE AMERICANO (sku `mta1iutckav77bukrxh`) | 7 | **PASADO** |
| CHOCOLATE CALIENTE | `4361` | $3.83 | BEBIDAS / BEBIDAS | CHOCOLANTE CALIENTE (sku `4361`) | 1 | **CHOCOLANTE CALIENTE** |
| CONO HELADO ZOHUI | `ADI003` | $0.36 | GENERAL / ADICIONALES HELADOS ZOHUI | JALEA HELADOS ZOHUI (sku `ADI002`) | 6 | **CONO (SOLO) HELADO ZOHUI** |

## El detalle que resuelve todo: `code` == `sku`

Los **191** productos de Boloncity tienen `code`, y los **191** existen como `sku` en el catálogo del POS. La correspondencia por SKU es del **100 %**; la de nombre es del **97.4 %**. Los 5 fallos son puramente cosméticos:

| code / sku | Nombre en Boloncity | Nombre en RunFood | Diferencia |
|---|---|---|---|
| `2090` | EMPANADA DE VERDE (POLLO) | EMPANADA DE VERDE (POLLO ) | espacio antes del paréntesis de cierre |
| `4348` | CAFE AMERICANO PASADO | PASADO | nombre truncado en el POS |
| `4361` | CHOCOLATE CALIENTE | CHOCOLANTE CALIENTE | error tipográfico en el POS |
| `BJPNJA006` | JUGO PURO NARANJA BOTELLA | JUGO PURO NARANJA BOTELLA 500ML | el POS añade el gramaje |
| `ADI003` | CONO HELADO ZOHUI | CONO (SOLO) HELADO ZOHUI | el POS añade "(SOLO)" |

Dos caminos, y el segundo es el bueno:

1. **Renombrar** (5 ediciones, en el POS o en Mongo). Arregla hoy y vuelve a romperse la próxima vez que alguien edite un nombre en cualquiera de los 8 POS.
2. **Emparejar por `code` → `sku`** en `runfood.service.ts`, con el nombre como respaldo. Es un cambio de pocas líneas, sube la cobertura a 100 % y de paso elimina los "dudosos" de abajo, porque el SKU es único y el nombre no.

## Match dudoso

Emparejan, pero por accidente. Dos causas:

- **Varios SKU con el mismo nombre** (26 nombres del catálogo del POS apuntan a 2–3 SKU). El servicio construye `new Map(catalog.map(...))`, así que **gana el último** — y el último no siempre es el SKU correcto. Como `unit_price` sale del catálogo del POS, la comanda puede salir con el precio de otro artículo.
- **Solo empareja tras normalizar**: el nombre del POS trae espacios dobles y sobrevive únicamente gracias al `\s+ → " "`.

### Boloncity Centro (proyección)

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **PORCION DE POLLO** (`48`) → POS "PORCION DE POLLO" — 2 SKU con el mismo nombre (48 $1.2696, 4370 $1.3400) — el servicio se queda con **4370 $1.3400**, distinto del code 48 del producto
- **ESPRESSO SENCILLO** (`4344`) → POS "ESPRESSO SENCILLO" — 2 SKU con el mismo nombre (2011 $1.1200, 4344 $1.3043) — el servicio se queda con **4344 $1.3043**
- **ESPRESSO DOBLE** (`4345`) → POS "ESPRESSO DOBLE" — 2 SKU con el mismo nombre (2083 $1.9600, 4345 $2.0000) — el servicio se queda con **4345 $2.0000**
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **CORTADITO** (`4358`) → POS "CORTADITO" — 3 SKU con el mismo nombre (2015 $1.0700, 4358 $1.3913, 4360 $1.3400) — el servicio se queda con **4360 $1.3400**, distinto del code 4358 del producto
- **CORTADO** (`4359`) → POS "CORTADO" — 2 SKU con el mismo nombre (2016 $1.0700, 4359 $1.7391) — el servicio se queda con **4359 $1.7391**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **AGUA DASANI BOLONCITY POR UNIDAD** (`0121`) → POS "AGUA DASANI BOLONCITY POR UNIDAD" — 2 SKU con el mismo nombre (0121 $0.9130, 0121-S $0.7100) — el servicio se queda con **0121-S $0.7100**, distinto del code 0121 del producto
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **PORCION ARROZ BLANCO** (`ARBL002`) → POS "PORCION ARROZ BLANCO" — 2 SKU con el mismo nombre (ARBL01 $1.3400, ARBL002 $1.5217) — el servicio se queda con **ARBL002 $1.5217**
- **TIGRILLO GUAYACO CRUNCH VERDE** (`TGG001`) → POS "TIGRILLO GUAYACO CRUNCH  VERDE" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **5.99 APPS COMBO BOLON MIXTO VERDE+CAFE AMERICANO** (`CBMC001`) → POS "5.99 APPS COMBO  BOLON MIXTO VERDE+CAFE AMERICANO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

### Boloncity Garzota (proyección)

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **PORCION DE POLLO** (`48`) → POS "PORCION DE POLLO" — 2 SKU con el mismo nombre (48 $1.2696, 4370 $1.3400) — el servicio se queda con **4370 $1.3400**, distinto del code 48 del producto
- **ESPRESSO SENCILLO** (`4344`) → POS "ESPRESSO SENCILLO" — 2 SKU con el mismo nombre (2011 $1.1200, 4344 $1.3043) — el servicio se queda con **4344 $1.3043**
- **ESPRESSO DOBLE** (`4345`) → POS "ESPRESSO DOBLE" — 2 SKU con el mismo nombre (2083 $1.9600, 4345 $2.0000) — el servicio se queda con **4345 $2.0000**
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **CORTADITO** (`4358`) → POS "CORTADITO" — 3 SKU con el mismo nombre (2015 $1.0700, 4358 $1.3913, 4360 $1.3400) — el servicio se queda con **4360 $1.3400**, distinto del code 4358 del producto
- **CORTADO** (`4359`) → POS "CORTADO" — 2 SKU con el mismo nombre (2016 $1.0700, 4359 $1.7391) — el servicio se queda con **4359 $1.7391**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **PORCION ARROZ BLANCO** (`ARBL002`) → POS "PORCION ARROZ BLANCO" — 2 SKU con el mismo nombre (ARBL01 $1.3400, ARBL002 $1.5217) — el servicio se queda con **ARBL002 $1.5217**
- **TIGRILLO GUAYACO CRUNCH VERDE** (`TGG001`) → POS "TIGRILLO GUAYACO CRUNCH  VERDE" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **5.99 APPS COMBO BOLON MIXTO VERDE+CAFE AMERICANO** (`CBMC001`) → POS "5.99 APPS COMBO  BOLON MIXTO VERDE+CAFE AMERICANO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

### Boloncity Kennedy (proyección)

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **PORCION DE POLLO** (`48`) → POS "PORCION DE POLLO" — 2 SKU con el mismo nombre (48 $1.2696, 4370 $1.3400) — el servicio se queda con **4370 $1.3400**, distinto del code 48 del producto
- **ESPRESSO SENCILLO** (`4344`) → POS "ESPRESSO SENCILLO" — 2 SKU con el mismo nombre (2011 $1.1200, 4344 $1.3043) — el servicio se queda con **4344 $1.3043**
- **ESPRESSO DOBLE** (`4345`) → POS "ESPRESSO DOBLE" — 2 SKU con el mismo nombre (2083 $1.9600, 4345 $2.0000) — el servicio se queda con **4345 $2.0000**
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **CORTADITO** (`4358`) → POS "CORTADITO" — 3 SKU con el mismo nombre (2015 $1.0700, 4358 $1.3913, 4360 $1.3400) — el servicio se queda con **4360 $1.3400**, distinto del code 4358 del producto
- **CORTADO** (`4359`) → POS "CORTADO" — 2 SKU con el mismo nombre (2016 $1.0700, 4359 $1.7391) — el servicio se queda con **4359 $1.7391**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **AGUA DASANI BOLONCITY POR UNIDAD** (`0121`) → POS "AGUA DASANI BOLONCITY POR UNIDAD" — 2 SKU con el mismo nombre (0121 $0.9130, 0121-S $0.7100) — el servicio se queda con **0121-S $0.7100**, distinto del code 0121 del producto
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **PORCION ARROZ BLANCO** (`ARBL002`) → POS "PORCION ARROZ BLANCO" — 2 SKU con el mismo nombre (ARBL01 $1.3400, ARBL002 $1.5217) — el servicio se queda con **ARBL002 $1.5217**
- **TIGRILLO GUAYACO CRUNCH VERDE** (`TGG001`) → POS "TIGRILLO GUAYACO CRUNCH  VERDE" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **5.99 APPS COMBO BOLON MIXTO VERDE+CAFE AMERICANO** (`CBMC001`) → POS "5.99 APPS COMBO  BOLON MIXTO VERDE+CAFE AMERICANO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

### Boloncity Urdesa

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **PORCION DE POLLO** (`48`) → POS "PORCION DE POLLO" — 2 SKU con el mismo nombre (48 $1.2696, 4370 $1.3400) — el servicio se queda con **4370 $1.3400**, distinto del code 48 del producto
- **ESPRESSO SENCILLO** (`4344`) → POS "ESPRESSO SENCILLO" — 2 SKU con el mismo nombre (2011 $1.1200, 4344 $1.3043) — el servicio se queda con **4344 $1.3043**
- **ESPRESSO DOBLE** (`4345`) → POS "ESPRESSO DOBLE" — 2 SKU con el mismo nombre (2083 $1.9600, 4345 $2.0000) — el servicio se queda con **4345 $2.0000**
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **CORTADITO** (`4358`) → POS "CORTADITO" — 3 SKU con el mismo nombre (2015 $1.0700, 4358 $1.3913, 4360 $1.3400) — el servicio se queda con **4360 $1.3400**, distinto del code 4358 del producto
- **CORTADO** (`4359`) → POS "CORTADO" — 2 SKU con el mismo nombre (2016 $1.0700, 4359 $1.7391) — el servicio se queda con **4359 $1.7391**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **AGUA DASANI BOLONCITY POR UNIDAD** (`0121`) → POS "AGUA DASANI BOLONCITY POR UNIDAD" — 2 SKU con el mismo nombre (0121 $0.9130, 0121-S $0.7100) — el servicio se queda con **0121-S $0.7100**, distinto del code 0121 del producto
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **PORCION ARROZ BLANCO** (`ARBL002`) → POS "PORCION ARROZ BLANCO" — 2 SKU con el mismo nombre (ARBL01 $1.3400, ARBL002 $1.5217) — el servicio se queda con **ARBL002 $1.5217**
- **TIGRILLO GUAYACO CRUNCH VERDE** (`TGG001`) → POS "TIGRILLO GUAYACO CRUNCH  VERDE" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **5.99 APPS COMBO BOLON MIXTO VERDE+CAFE AMERICANO** (`CBMC001`) → POS "5.99 APPS COMBO  BOLON MIXTO VERDE+CAFE AMERICANO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

### Boloncity Vía a la Costa

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **PORCION DE POLLO** (`48`) → POS "PORCION DE POLLO" — 2 SKU con el mismo nombre (48 $1.2696, 4370 $1.3400) — el servicio se queda con **4370 $1.3400**, distinto del code 48 del producto
- **ESPRESSO SENCILLO** (`4344`) → POS "ESPRESSO SENCILLO" — 2 SKU con el mismo nombre (2011 $1.1200, 4344 $1.3043) — el servicio se queda con **4344 $1.3043**
- **ESPRESSO DOBLE** (`4345`) → POS "ESPRESSO DOBLE" — 2 SKU con el mismo nombre (2083 $1.9600, 4345 $2.0000) — el servicio se queda con **4345 $2.0000**
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **CORTADITO** (`4358`) → POS "CORTADITO" — 3 SKU con el mismo nombre (2015 $1.0700, 4358 $1.3913, 4360 $1.3400) — el servicio se queda con **4360 $1.3400**, distinto del code 4358 del producto
- **CORTADO** (`4359`) → POS "CORTADO" — 2 SKU con el mismo nombre (2016 $1.0700, 4359 $1.7391) — el servicio se queda con **4359 $1.7391**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **AGUA DASANI BOLONCITY POR UNIDAD** (`0121`) → POS "AGUA DASANI BOLONCITY POR UNIDAD" — 2 SKU con el mismo nombre (0121 $0.9130, 0121-S $0.7100) — el servicio se queda con **0121-S $0.7100**, distinto del code 0121 del producto
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **PORCION ARROZ BLANCO** (`ARBL002`) → POS "PORCION ARROZ BLANCO" — 2 SKU con el mismo nombre (ARBL01 $1.3400, ARBL002 $1.5217) — el servicio se queda con **ARBL002 $1.5217**
- **TIGRILLO GUAYACO CRUNCH VERDE** (`TGG001`) → POS "TIGRILLO GUAYACO CRUNCH  VERDE" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **5.99 APPS COMBO BOLON MIXTO VERDE+CAFE AMERICANO** (`CBMC001`) → POS "5.99 APPS COMBO  BOLON MIXTO VERDE+CAFE AMERICANO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

### Boloncity República

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **AGUA DASANI BOLONCITY POR UNIDAD** (`0121`) → POS "AGUA DASANI BOLONCITY POR UNIDAD" — 2 SKU con el mismo nombre (0121 $0.9130, 0121-S $0.7100) — el servicio se queda con **0121-S $0.7100**, distinto del code 0121 del producto
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

### Boloncity La Joya (proyección)

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **PORCION DE POLLO** (`48`) → POS "PORCION DE POLLO" — 2 SKU con el mismo nombre (48 $1.2696, 4370 $1.3400) — el servicio se queda con **4370 $1.3400**, distinto del code 48 del producto
- **ESPRESSO SENCILLO** (`4344`) → POS "ESPRESSO SENCILLO" — 2 SKU con el mismo nombre (2011 $1.1200, 4344 $1.3043) — el servicio se queda con **4344 $1.3043**
- **ESPRESSO DOBLE** (`4345`) → POS "ESPRESSO DOBLE" — 2 SKU con el mismo nombre (2083 $1.9600, 4345 $2.0000) — el servicio se queda con **4345 $2.0000**
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **CORTADITO** (`4358`) → POS "CORTADITO" — 3 SKU con el mismo nombre (2015 $1.0700, 4358 $1.3913, 4360 $1.3400) — el servicio se queda con **4360 $1.3400**, distinto del code 4358 del producto
- **CORTADO** (`4359`) → POS "CORTADO" — 2 SKU con el mismo nombre (2016 $1.0700, 4359 $1.7391) — el servicio se queda con **4359 $1.7391**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **AGUA DASANI BOLONCITY POR UNIDAD** (`0121`) → POS "AGUA DASANI BOLONCITY POR UNIDAD" — 2 SKU con el mismo nombre (0121 $0.9130, 0121-S $0.7100) — el servicio se queda con **0121-S $0.7100**, distinto del code 0121 del producto
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **PORCION ARROZ BLANCO** (`ARBL002`) → POS "PORCION ARROZ BLANCO" — 2 SKU con el mismo nombre (ARBL01 $1.3400, ARBL002 $1.5217) — el servicio se queda con **ARBL002 $1.5217**
- **TIGRILLO GUAYACO CRUNCH VERDE** (`TGG001`) → POS "TIGRILLO GUAYACO CRUNCH  VERDE" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **5.99 APPS COMBO BOLON MIXTO VERDE+CAFE AMERICANO** (`CBMC001`) → POS "5.99 APPS COMBO  BOLON MIXTO VERDE+CAFE AMERICANO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

### Boloncity Avalon Plaza

- **BOLON MIXTO VERDE** (`6`) → POS "BOLON MIXTO VERDE" — 2 SKU con el mismo nombre (6 $4.0435, BMXI001 $3.9130) — el servicio se queda con **BMXI001 $3.9130**, distinto del code 6 del producto
- **TORTILLA DE VERDE QUESO** (`10`) → POS "TORTILLA DE VERDE QUESO" — 2 SKU con el mismo nombre (10 $3.3043, TQUESO $1.7900) — el servicio se queda con **TQUESO $1.7900**, distinto del code 10 del producto
- **TOSTADA DE QUESO** (`23`) → POS "TOSTADA DE  QUESO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **PORCION DE LOMO** (`47`) → POS "PORCION DE LOMO" — 2 SKU con el mismo nombre (47 $1.2696, 4373 $1.3400) — el servicio se queda con **4373 $1.3400**, distinto del code 47 del producto
- **PORCION DE POLLO** (`48`) → POS "PORCION DE POLLO" — 2 SKU con el mismo nombre (48 $1.2696, 4370 $1.3400) — el servicio se queda con **4370 $1.3400**, distinto del code 48 del producto
- **ESPRESSO SENCILLO** (`4344`) → POS "ESPRESSO SENCILLO" — 2 SKU con el mismo nombre (2011 $1.1200, 4344 $1.3043) — el servicio se queda con **4344 $1.3043**
- **ESPRESSO DOBLE** (`4345`) → POS "ESPRESSO DOBLE" — 2 SKU con el mismo nombre (2083 $1.9600, 4345 $2.0000) — el servicio se queda con **4345 $2.0000**
- **CAFE CON LECHE** (`4349`) → POS "CAFE CON LECHE" — 2 SKU con el mismo nombre (2102 $1.1200, 4349 $1.9565) — el servicio se queda con **4349 $1.9565**
- **CAPUCCINO** (`4351`) → POS "CAPUCCINO" — 2 SKU con el mismo nombre (2013 $1.5600, 4351 $2.6087) — el servicio se queda con **4351 $2.6087**
- **CORTADITO** (`4358`) → POS "CORTADITO" — 3 SKU con el mismo nombre (2015 $1.0700, 4358 $1.3913, 4360 $1.3400) — el servicio se queda con **4360 $1.3400**, distinto del code 4358 del producto
- **CORTADO** (`4359`) → POS "CORTADO" — 2 SKU con el mismo nombre (2016 $1.0700, 4359 $1.7391) — el servicio se queda con **4359 $1.7391**
- **MOCACCINO** (`4363`) → POS "MOCACCINO" — 2 SKU con el mismo nombre (2014 $1.7900, 4363 $2.6087) — el servicio se queda con **4363 $2.6087**
- **BOLON PINTON LONGANIZA** (`4396`) → POS "BOLON PINTON  LONGANIZA" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **AGUA DASANI BOLONCITY POR UNIDAD** (`0121`) → POS "AGUA DASANI BOLONCITY POR UNIDAD" — 2 SKU con el mismo nombre (0121 $0.9130, 0121-S $0.7100) — el servicio se queda con **0121-S $0.7100**, distinto del code 0121 del producto
- **PORCION DE JAMON** (`PJ02`) → POS "PORCION DE JAMON" — 3 SKU con el mismo nombre (2099 $0.8900, PJ01 $0.8900, PJ02 $0.8696) — el servicio se queda con **PJ02 $0.8696**
- **PORCION ARROZ BLANCO** (`ARBL002`) → POS "PORCION ARROZ BLANCO" — 2 SKU con el mismo nombre (ARBL01 $1.3400, ARBL002 $1.5217) — el servicio se queda con **ARBL002 $1.5217**
- **TIGRILLO GUAYACO CRUNCH VERDE** (`TGG001`) → POS "TIGRILLO GUAYACO CRUNCH  VERDE" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **5.99 APPS COMBO BOLON MIXTO VERDE+CAFE AMERICANO** (`CBMC001`) → POS "5.99 APPS COMBO  BOLON MIXTO VERDE+CAFE AMERICANO" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **MINI TORTILLA DE VERDE SOLA $1.50** (`TORTLMV001`) → POS "MINI TORTILLA DE VERDE SOLA  $1.50" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe
- **BOLON CORAZON 12CM ESPECIALES** (`BCORAZONESP002`) → POS "BOLON CORAZON  12CM ESPECIALES" — solo empareja tras normalizar (espacios dobles); un cambio de normalización lo rompe

Ejemplos donde el SKU ganador no es el del producto: **BOLON MIXTO VERDE** (code `6`, gana `BMXI001`), **TORTILLA DE VERDE QUESO** (code `10` $3.30, gana `TQUESO` $1.79), **PORCION DE LOMO** (code `47`, gana `4373`), **PORCION DE POLLO** (code `48`, gana `4370`), **CORTADITO** (code `4358`, gana `4360`), **AGUA DASANI** (code `0121`, gana `0121-S`). Emparejar por SKU también cierra esto.

## Qué pedidos se romperían hoy

- **CAFE AMERICANO PASADO** ($1.92, BEBIDAS/CAFE) — disponible en **las 8 sucursales**. Es el café de la casa y el acompañante natural del bolón: alta rotación, y es el peor de los cinco. Cualquier desayuno con café en el carrito se queda sin comanda.
- **CHOCOLATE CALIENTE** ($3.83, BEBIDAS) — disponible en **las 8 sucursales**. Segunda bebida caliente del menú; rotación alta en desayuno.
- **JUGO PURO NARANJA BOTELLA** ($3.30, BEBIDAS/JUGOS) — en 6 sucursales (todas menos Kennedy y Avalon). El jugo del combo de desayuno: rotación alta.
- **EMPANADA DE VERDE (POLLO)** ($4.80, COCINA/TIPICOS) — en Centro, Urdesa y Vía a la Costa. Rotación media.
- **CONO HELADO ZOHUI** ($0.36, ADICIONALES HELADOS ZOHUI) — solo en Avalon Plaza. Es un adicional barato, pero por eso mismo entra de acompañante en pedidos que sí importan y tumba el pedido entero.

Los bolones —el producto insignia— **sí emparejan**, todos. El daño está concentrado en las bebidas calientes, y ahí está justamente lo que se pide con un bolón. Con "CAFE AMERICANO PASADO" y "CHOCOLATE CALIENTE" rotos en las 8 sucursales, la porción de pedidos de desayuno que hoy no llegaría a cocina es material, no marginal.

Ningún producto tiene `isBestSeller: true` en producción, así que la clasificación de rotación es por categoría y precio, no por un dato de ventas.

## Otros hallazgos del sondeo (no son el encargo, pero afectan el emparejamiento)

- **`GET /products` ignora `page` y `limit`**: cada página devuelve el catálogo entero (1790 productos). El bucle de `getCatalog` corre las 10 páginas y arma un arreglo de **17 900** entradas — 10 copias — antes de construir el `Map`. Funciona, pero descarga ~10× de más en cada refresco de caché y es lo que hace que "gana el último" sea aún más arbitrario.
- **`GET /identity` no trae `taxes`** en ninguno de los 4 locales sondeados, así que `vatRate` siempre cae al valor por defecto 15.
- El catálogo devuelve **`tax_applicable`**, mientras que la interfaz `RunfoodProduct` declara `vat_applicable`. El campo declarado nunca se lee, así que hoy no rompe nada.
- Los 1790 productos del POS están `active: true`; no hay archivados que filtrar.
- El catálogo del POS es el inventario completo del local (incluye insumos y suministros: "RESALTADOR NARANJA", "VINAGRE POR GALÓN"), 1790 SKU frente a 191 vendibles en la web. No estorba al emparejamiento, pero explica los nombres raros entre los candidatos cercanos.
