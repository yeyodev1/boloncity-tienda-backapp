# Correo a RunFood — bloqueantes de la integración

**Para:** `desarrollo@runfoodapp.com` (Angel Reyes)
**Asunto:** `Boloncity Web (boloncity_web) — 4 locales sin responder y 3 consultas de API`

Todo lo de abajo está verificado el **2026-08-27** contra los servidores de producción,
no sacado de la doc. Los puntos 1 y 2 son los que impiden cerrar la integración.

---

## El correo

```
Hola Angel,

Ya tenemos la integración de Boloncity Web armada contra las credenciales que
nos entregaron. Al probar contra los ocho locales nos quedaron cuatro puntos
abiertos, dos de ellos bloqueantes.

1) BLOQUEANTE — Necesitamos el PVP2 por la API

Boloncity vende en la web a PVP2, no al precio de mostrador. Hoy
GET /products devuelve un solo campo `price`, que corresponde al PVP1 y viene
sin impuesto (ej. SKU 7 PORCION DE CHICHARRON -> 1.73913, que con IVA da los
$2.00 del mostrador; en la web ese producto se vende a $2.40).

Probamos GET /price-lists y GET /prices (404), y los parámetros
?price_list=2 y ?pvp=2 sobre /products (se ignoran, devuelven el mismo PVP1).

¿Hay forma de leer el PVP2 por la API? Si no existe hoy, ¿pueden agregarla
(campo adicional en el producto, o un parámetro de lista de precios)? Sin eso
no podemos sincronizar precios: tendríamos que mantenerlos a mano en la web.

2) BLOQUEANTE — Cómo distinguir artículos de venta de los de compra

El catálogo devuelve 1790 productos por local, de los cuales solo 191 son de
venta al público; el resto son insumos y artículos de compra. En la respuesta
de GET /products no vemos ningún campo que los separe (solo llegan sku, name,
price, tax_applicable, active) — no hay type, category ni group.

Queremos que un artículo de VENTA nuevo creado en RunFood aparezca solo en la
web automáticamente. ¿Cómo lo identificamos? ¿Pueden exponer el tipo o la
categoría del producto?

3) Cuatro locales no responden

Sondeamos los ocho el 2026-08-27 entre las 15:00 y las 16:30 (hora Ecuador),
con GET /health. Cuatro respondieron 200 y cuatro no:

  RESPONDEN     Urdesa (186.101.243.150), República (186.4.130.151),
                Avalon Plaza (186.3.235.200), Vía a la Costa (181.39.229.202)
  NO RESPONDEN  La Joya (186.3.149.51)      -> ECONNREFUSED tras 4.1 s
                Kennedy (181.198.203.171)   -> timeout a los 10 s
                Centro (181.39.245.89)      -> ECONNREFUSED tras 4.3 s
                Garzota (181.198.245.112)   -> ECONNREFUSED tras 7.2 s

La negativa no es inmediata sino a los 4-10 s, que parece filtrado del ISP o
servidor apagado, no un puerto cerrado. ¿Nos confirman si esos cuatro
servidores están arriba y con el puerto 1000 publicado?

Relacionado: en el pedido original planteamos que nuestros locales no tienen
IP fija y por eso pedíamos el túnel gestionado. Las URLs que nos pasaron son
IPs directas. ¿Esas IPs son estáticas, o van a rotar? Si rotan necesitamos el
túnel, porque cada cambio nos deja el local sin comandas.

4) Diferencias entre la documentación y los servidores

Programamos contra lo que responden los servidores reales, pero queremos
confirmar cuál es la referencia buena:

  - El producto trae `tax_applicable`; la doc documenta `vat_applicable`.
  - GET /identity no trae `taxes.vat_rate` (la doc dice que sí) y el nombre
    del local viene en `nombreComercial`, no en `name`.
  - GET /products ignora `page` y `limit` y devuelve el catálogo completo
    (1790) en una sola respuesta, sin `has_more`.

¿Los locales corren una versión distinta a la de la documentación pública?

5) Consultas menores

  - Nos enviaron una API Key y un API Secret. La API Key funciona en el header
    X-Api-Key. ¿Para qué es el Secret? ¿Es el de firma de webhooks?
  - GET /apps/me y GET /payment-methods devuelven 403 insufficient_scope
    (piden apps:read y payment-methods:read). No los necesitamos para operar,
    pero apps:read nos serviría para verificar los scopes desde monitoreo.
    ¿Nos lo pueden habilitar?
  - En POST /orders vemos notas solo a nivel de ítem (tabs[].items[].notes).
    ¿Hay un campo de notas del pedido completo? Las indicaciones del cliente
    (alergias, "sin cebolla") aplican al pedido, no a un renglón.
  - Vía a la Costa se identifica como "BOLONCITY BLUE COAST", bodega 21.
    ¿Nos confirman por escrito el mapeo local <-> bodega de los ocho? No
    queremos que una comanda salga en la cocina equivocada.
  - GET /webhooks nos responde 200 con lista vacía. ¿Podemos registrar
    webhooks de cambios de producto y de estado del pedido? Nos evitaría
    consultar el catálogo entero periódicamente.

Quedamos atentos. Con los puntos 1 y 2 resueltos cerramos la sincronización de
catálogo; los locales que ya responden los podemos activar antes.

Saludos,
Diego Reyes
dreyes@bakano.ec
```
