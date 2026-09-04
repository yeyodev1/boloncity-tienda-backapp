# Meta Pixel + Conversions API

Cada evento sale **dos veces**: una desde el navegador (pixel) y otra desde el
backend (Conversions API). Las dos llevan el mismo `event_id`, así que Meta las
reconoce como el mismo hecho y **cuenta una sola** (deduplicación).

¿Por qué doble? Porque el pixel del navegador se pierde seguido —bloqueadores,
iOS, o el cliente que cierra la pestaña al volver de PayPhone—. La copia del
servidor no depende de nada de eso.

## Eventos

| Evento | Dónde se dispara | `event_id` |
|---|---|---|
| `PageView` | Cada cambio de ruta (`router.afterEach`) | aleatorio por vista |
| `ViewContent` | Ficha de producto y vista rápida | aleatorio |
| `AddToCart` | Botón "Agregar" (ficha y vista rápida) | aleatorio |
| `InitiateCheckout` | Al entrar a `/checkout` con carrito | aleatorio |
| `Purchase` | Pago aprobado (tarjeta) o pedido creado (efectivo) | `purchase-<orderNumber>` |

`Purchase` es el único con id **determinístico**: es la misma venta vista desde el
navegador y desde el backend, y así se emparejan sin margen de error.

## Qué valor se reporta

`Purchase` reporta `total - deliveryCost` en **dólares**. El envío no es venta: es
costo de llevarlo, y meterlo infla el ROAS del anuncio.

## Variables de entorno

**Backend** (Vercel → Settings → Environment Variables):

```
META_PIXEL_ID=1327396295923548
META_CAPI_ACCESS_TOKEN=<token del Events Manager>
META_TEST_EVENT_CODE=          # vacío en producción
```

**Frontend**:

```
VITE_META_PIXEL_ID=1327396295923548
```

Si falta cualquiera de las dos primeras, el backend simplemente no envía nada
(`isMetaConfigured()` devuelve false). Nada se rompe: solo no se mide.

## Datos del cliente

El navegador manda email/teléfono **en claro a nuestro propio backend** (HTTPS), y
el backend los normaliza y hashea con SHA-256 antes de enviarlos a Meta. El
access token nunca sale del servidor.

## Probar

1. Events Manager → Orígenes de datos → el pixel → **Probar eventos**.
2. Copiar el código `TEST12345` a `META_TEST_EVENT_CODE` en el backend.
3. Navegar la tienda. Deben aparecer los eventos con la etiqueta
   "Navegador y servidor" — eso confirma que la deduplicación está funcionando.
4. **Borrar `META_TEST_EVENT_CODE` al terminar**, o los eventos siguen contando
   como prueba y no como conversiones reales.
