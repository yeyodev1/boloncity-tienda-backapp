import axios from "axios";

/**
 * RunFood es el POS on-premise de cada local (https://runfoodapp.github.io/api-docs/).
 * Cada sucursal tiene su propia URL base y API key; el servidor vive dentro del
 * restaurante y PUEDE estar caido — todo aqui falla suave y deja el motivo.
 *
 * Boloncity inyecta el pedido como "open" (imprime la comanda en cocina); el cobro
 * y la factura ante el SRI los cierra el cajero en el POS. Por eso solo se
 * necesitan los scopes orders:write y products:read.
 */

export interface RunfoodConfig {
  baseUrl: string;
  apiKey: string;
}

interface RunfoodProduct {
  sku: string;
  name: string;
  price: number;
  vat_applicable: boolean;
}

export interface RunfoodPushResult {
  ok: boolean;
  orderId?: number;
  duplicated?: boolean;
  message: string;
}

const TIMEOUT_MS = 12_000;

function client(config: RunfoodConfig) {
  return axios.create({
    baseURL: config.baseUrl.replace(/\/$/, ""),
    timeout: TIMEOUT_MS,
    headers: { "X-Api-Key": config.apiKey },
  });
}

/** Catalogo por local, cacheado en memoria: cambia poco y el local puede estar caido. */
const catalogCache = new Map<string, { at: number; products: RunfoodProduct[] }>();
const CATALOG_TTL_MS = 10 * 60_000;

async function getCatalog(config: RunfoodConfig): Promise<RunfoodProduct[]> {
  const cached = catalogCache.get(config.baseUrl);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.products;
  const http = client(config);
  const products: RunfoodProduct[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await http.get(`/products?page=${page}&limit=100`);
    const batch: RunfoodProduct[] = data?.data || [];
    products.push(...batch);
    if (batch.length < 100) break;
  }
  catalogCache.set(config.baseUrl, { at: Date.now(), products });
  return products;
}

/** Nombres comparables: sin tildes, sin espacios dobles, en minusculas. */
function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function runfoodHealth(config: RunfoodConfig): Promise<boolean> {
  try {
    const { status } = await client(config).get("/health");
    return status === 200;
  } catch {
    return false;
  }
}

/**
 * Empuja un pedido de Boloncity al POS del local como pedido abierto.
 * - `unit_price` va SIN IVA: RunFood lo suma con la tasa del local. Nuestros
 *   precios YA lo incluyen, asi que se divide por (1 + tasa/100) cuando el
 *   producto grava IVA en el catalogo del local.
 * - Los items se emparejan por nombre normalizado contra el catalogo del local.
 *   Si alguno no tiene match NO se envia nada (una comanda incompleta en cocina
 *   es peor que ninguna) y se devuelve el detalle.
 * - `external_id` = orderNumber: si se reintenta, RunFood responde 409 y lo
 *   tratamos como exito (idempotencia).
 */
export async function pushOrderToRunfood(params: {
  config: RunfoodConfig;
  orderNumber: string;
  customerName: string;
  deliveryType: string;
  notes?: string;
  items: Array<{ name: string; quantity: number }>;
}): Promise<RunfoodPushResult> {
  const { config, orderNumber } = params;
  try {
    const http = client(config);
    const { data: identity } = await http.get("/identity");
    const vatRate = Number(identity?.taxes?.vat_rate ?? 15);
    const catalog = await getCatalog(config);
    const byName = new Map(catalog.map((product) => [normalizeName(product.name), product]));

    const missing: string[] = [];
    const items = params.items.map((item) => {
      const product = byName.get(normalizeName(item.name));
      if (!product) {
        missing.push(item.name);
        return null;
      }
      return {
        sku: product.sku,
        quantity: item.quantity,
        // El catalogo del local ya tiene el precio base; usarlo evita descuadres
        // por redondeo entre nuestro precio con IVA y su base.
        unit_price: product.price,
      };
    });
    if (missing.length) {
      return { ok: false, message: `Sin match en el catálogo del local: ${missing.join(", ")}` };
    }

    const label = `${params.deliveryType === "pickup" ? "RETIRO" : "DELIVERY"} WEB ${orderNumber} — ${params.customerName}`.slice(0, 60);
    const payload = {
      external_id: orderNumber,
      status: "open",
      tabs: [
        {
          external_id: `${orderNumber}-1`,
          name: label,
          items,
        },
      ],
    };

    const response = await http.post("/orders", payload);
    const orderId = response.data?.id;
    return { ok: true, orderId, message: `Pedido enviado al POS RunFood${orderId ? ` (#${orderId})` : ""} — IVA local ${vatRate}%` };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.response?.status === 409) {
        // duplicate_order: ya existia por un reintento anterior. Es exito.
        return { ok: true, duplicated: true, message: `El pedido ya estaba en el POS RunFood (idempotencia ${orderNumber})` };
      }
      const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data).slice(0, 180)}` : err.code || err.message;
      return { ok: false, message: `RunFood no respondió bien: ${detail}` };
    }
    return { ok: false, message: `RunFood falló: ${err instanceof Error ? err.message : "error desconocido"}` };
  }
}
