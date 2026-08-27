import axios, { AxiosInstance } from "axios";

/**
 * RunFood es el POS on-premise de cada local (https://runfoodapp.github.io/api-docs/).
 * Cada sucursal tiene su propia URL base; la API key es una sola para todos los
 * locales, asi que lo que decide en que cocina imprime la comanda es la URL.
 * El servidor vive dentro del restaurante y PUEDE estar caido — todo aqui falla
 * suave y deja el motivo.
 *
 * Boloncity inyecta el pedido como "open" (imprime la comanda en cocina); el cobro
 * y la factura ante el SRI los cierra el cajero en el POS. Por eso solo se
 * necesitan los scopes orders:write y products:read.
 *
 * OJO — la doc publica y los servidores de produccion NO coinciden (verificado el
 * 2026-08-27 contra los cuatro locales que respondian): el producto trae
 * `tax_applicable`, no `vat_applicable`, y `/identity` no expone `taxes.vat_rate`.
 * Este cliente esta escrito contra lo que devuelven los servidores reales.
 */

export interface RunfoodConfig {
  baseUrl: string;
  apiKey: string;
}

/** Un renglon del pedido tal como lo cobro Boloncity. */
export interface RunfoodItem {
  /** `product.code` nuestro = `sku` del POS. Sin esto el renglon no se puede enviar. */
  sku: string;
  name: string;
  quantity: number;
  /** Precio unitario CON IVA, en centavos (asi lo guarda el pedido). */
  priceCents: number;
  /** IVA del producto en porcentaje (15 = 15%). 0 = no grava. */
  ivaRatePercent: number;
}

export interface RunfoodPushResult {
  ok: boolean;
  orderId?: number;
  duplicated?: boolean;
  /** `print_result.status`: el pedido puede crearse y aun asi no imprimirse. */
  printStatus?: string;
  message: string;
}

/**
 * Presupuesto de tiempo apretado a proposito: esto corre dentro de una funcion
 * serverless que despues todavia tiene que reservar Picker. Peor caso ~17 s.
 */
const TIMEOUT_MS = 7_000;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 1_000;

/** Limites de la API. `name` 120, `notes` 255, `external_id` 64. */
const MAX_TAB_NAME = 120;
const MAX_NOTES = 255;

function client(config: RunfoodConfig): AxiosInstance {
  return axios.create({
    baseURL: config.baseUrl.replace(/\/+$/, ""),
    timeout: TIMEOUT_MS,
    headers: { "X-Api-Key": config.apiKey },
  });
}

/** Codigo estable del error; el `message` es texto libre y no se programa contra el. */
function errorCode(err: unknown): string {
  return (axios.isAxiosError(err) && (err.response?.data as { error?: string } | undefined)?.error) || "";
}

/**
 * La doc manda reintentar 429, 5xx, timeout y `409 conflict` con backoff.
 * `409 duplicate_order` NO se reintenta: es la respuesta correcta a un reintento
 * anterior que si entro.
 */
function shouldRetry(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  if (!err.response) return true; // timeout o error de red: el local se reinicio
  const status = err.response.status;
  if (status === 429 || status >= 500) return true;
  return status === 409 && errorCode(err) === "conflict";
}

function retryDelayMs(err: unknown, attempt: number): number {
  const header = axios.isAxiosError(err) ? Number(err.response?.headers?.["retry-after"]) : NaN;
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1_000, 5_000);
  return BACKOFF_MS * attempt;
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS || !shouldRetry(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(err, attempt)));
    }
  }
  throw lastError;
}

/**
 * `unit_price` va SIN impuesto y es NUESTRO precio de venta, no el del catalogo
 * del local: RunFood no lo toma de su catalogo, lo usa para comprobar que ambos
 * vieron lo mismo antes de que el cajero emita el comprobante. La tienda web
 * vende mas caro que el mostrador, asi que mandar el precio del POS haria que la
 * factura saliera por menos de lo que ya se le cobro al cliente.
 */
function unitPriceWithoutTax(priceCents: number, ivaRatePercent: number): number {
  if (!ivaRatePercent || ivaRatePercent <= 0) return priceCents / 100;
  return Number((priceCents / (1 + ivaRatePercent / 100) / 100).toFixed(6));
}

function describeAxiosError(err: unknown): string {
  if (!axios.isAxiosError(err)) return err instanceof Error ? err.message : "error desconocido";
  if (!err.response) return err.code || err.message;
  const data = err.response.data as { error?: string; message?: string } | undefined;
  const requestId = err.response.headers?.["x-request-id"];
  const code = data?.error || String(err.response.status);
  return `${code}${data?.message ? ` (${data.message})` : ""}${requestId ? ` [req ${requestId}]` : ""}`;
}

/**
 * Empuja un pedido de Boloncity al POS del local como pedido abierto.
 *
 * Los renglones se emparejan por **SKU** (`product.code` = `sku` del POS): los 191
 * productos de Boloncity existen con ese mismo codigo en los 1790 del catalogo del
 * local. Antes se emparejaba por nombre, que dejaba 5 productos fuera y bastaba un
 * renombre cosmetico en el POS para tumbar el pedido entero.
 *
 * `external_id` = orderNumber: si se reintenta, RunFood responde 409
 * `duplicate_order` y lo tratamos como exito (idempotencia).
 */
export async function pushOrderToRunfood(params: {
  config: RunfoodConfig;
  orderNumber: string;
  customerName: string;
  deliveryType: string;
  notes?: string;
  items: RunfoodItem[];
}): Promise<RunfoodPushResult> {
  const { config, orderNumber } = params;

  // Sin SKU no hay nada que mandar: una comanda a medias en cocina es peor que
  // ninguna, igual que cuando el emparejamiento era por nombre.
  const sinSku = params.items.filter((item) => !item.sku?.trim()).map((item) => item.name);
  if (sinSku.length) {
    return { ok: false, message: `Productos sin código para el POS: ${sinSku.join(", ")}` };
  }
  if (!params.items.length) {
    return { ok: false, message: "El pedido no tiene renglones que enviar" };
  }

  const label = `${params.deliveryType === "pickup" ? "RETIRO" : "DELIVERY"} WEB ${orderNumber} — ${params.customerName}`.slice(
    0,
    MAX_TAB_NAME
  );

  // RunFood solo acepta notas por renglon (`tabs[].items[].notes`); no existe un
  // campo de notas del pedido en el request. La indicacion del cliente (alergias,
  // "sin cebolla") va en el primer renglon para que salga impresa en la comanda.
  const orderNotes = params.notes?.trim().slice(0, MAX_NOTES) || "";

  const payload = {
    external_id: orderNumber,
    status: "open",
    service_type: params.deliveryType === "pickup" ? "pickup" : "delivery",
    tabs: [
      {
        external_id: `${orderNumber}-1`,
        name: label,
        items: params.items.map((item, index) => ({
          sku: item.sku.trim(),
          quantity: item.quantity,
          unit_price: unitPriceWithoutTax(item.priceCents, item.ivaRatePercent),
          ...(index === 0 && orderNotes ? { notes: orderNotes } : {}),
        })),
      },
    ],
  };

  try {
    const response = await withRetry(() => client(config).post("/orders", payload));
    const orderId = response.data?.id;
    // El pedido se crea aunque la impresora falle: hay que decirlo, o el local cree
    // que la comanda salio y nunca salio.
    const printStatus: string | undefined = response.data?.print_result?.status;
    const printFailed = printStatus === "no_printers" || printStatus === "error";
    return {
      ok: true,
      orderId,
      printStatus,
      message: printFailed
        ? `Pedido creado en el POS${orderId ? ` (#${orderId})` : ""} pero NO se imprimió: ${printStatus}`
        : `Pedido enviado al POS RunFood${orderId ? ` (#${orderId})` : ""}`,
    };
  } catch (err) {
    if (errorCode(err) === "duplicate_order") {
      const existingId = axios.isAxiosError(err) ? (err.response?.data as { id?: number } | undefined)?.id : undefined;
      return {
        ok: true,
        duplicated: true,
        orderId: existingId,
        message: `El pedido ya estaba en el POS RunFood (idempotencia ${orderNumber})`,
      };
    }
    return { ok: false, message: `RunFood no recibió el pedido: ${describeAxiosError(err)}` };
  }
}

/** Sondeo de salud del local. `/health` es publico, no consume scope. */
export async function runfoodHealth(config: RunfoodConfig): Promise<boolean> {
  try {
    const { status } = await client(config).get("/health");
    return status === 200;
  } catch {
    return false;
  }
}
