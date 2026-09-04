import mongoose, { Schema } from "mongoose";

export interface ISetting {
  deliveryPricePerKm: number;
  /**
   * Tope de distancia de un delivery, en km desde la sucursal. Es una red de
   * seguridad, no la definicion de cobertura: las zonas reales son los poligonos
   * dibujados en Picker. Existe porque sin el, un punto mal resuelto se cotizaba
   * por distancia sin techo (ORD-00110: 4301 km = $6542 de envio).
   */
  deliveryMaxDistanceKm: number;
  /** IVA vigente en porcentaje (15 = 15%). Se usa como tasa por defecto del catalogo. */
  ivaRate: number;
  /**
   * true = los precios del catalogo ya incluyen IVA (es como se cobra en Ecuador).
   * El impuesto se desglosa hacia atras sobre el precio, no se suma encima.
   */
  pricesIncludeIva: boolean;
  /** Programa de puntos: activarlo/desactivarlo sin perder la configuracion. */
  pointsEnabled: boolean;
  /** Cada cuantos dolares de compra se entregan puntos (ej. 1 = por cada $1). */
  pointsEarnDollars: number;
  /** Cuantos puntos se entregan por cada bloque de pointsEarnDollars (ej. 1 punto por $1). */
  pointsEarnAmount: number;
  /** Cuantos puntos equivalen a $1 al canjear (100 = "100 puntos valen 1 dolar"). */
  pointsRedeemPerDollar: number;
  /** Promocion global: descuento en % sobre el subtotal de productos. Nunca toca el envio. */
  promoEnabled: boolean;
  /** Porcentaje de descuento (20 = 20%). */
  promoPercent: number;
  /** Texto que ve el cliente (ej. "20% de descuento en todo"). */
  promoLabel: string;
  /** Ventana opcional de vigencia; vacio = sin limite. */
  promoStartsAt?: Date | null;
  promoEndsAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    deliveryPricePerKm: { type: Number, required: true, default: 150 },
    deliveryMaxDistanceKm: { type: Number, required: true, default: 30, min: 1 },
    ivaRate: { type: Number, required: true, default: 15, min: 0, max: 100 },
    pricesIncludeIva: { type: Boolean, required: true, default: true },
    pointsEnabled: { type: Boolean, required: true, default: true },
    pointsEarnDollars: { type: Number, required: true, default: 1, min: 0.01 },
    pointsEarnAmount: { type: Number, required: true, default: 1, min: 0 },
    pointsRedeemPerDollar: { type: Number, required: true, default: 100, min: 1 },
    promoEnabled: { type: Boolean, required: true, default: false },
    promoPercent: { type: Number, required: true, default: 0, min: 0, max: 100 },
    promoLabel: { type: String, default: "" },
    promoStartsAt: { type: Date, default: null },
    promoEndsAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const Setting = mongoose.models.Setting || mongoose.model<ISetting>("Setting", settingSchema);

/** Un solo documento de settings; se crea con los valores por defecto si no existe. */
export async function getOrCreateSettings() {
  const existing = await Setting.findOne();
  if (existing) return existing;
  return Setting.create({});
}

/**
 * Promocion vigente, si la hay. El descuento aplica SOLO al subtotal de productos:
 * el envio nunca se descuenta (regla del negocio).
 */
export function getActivePromo(settings: Pick<ISetting, "promoEnabled" | "promoPercent" | "promoLabel" | "promoStartsAt" | "promoEndsAt">, now = new Date()) {
  const percent = Math.min(100, Math.max(0, Number(settings.promoPercent) || 0));
  const started = !settings.promoStartsAt || new Date(settings.promoStartsAt) <= now;
  const notEnded = !settings.promoEndsAt || new Date(settings.promoEndsAt) >= now;
  const active = Boolean(settings.promoEnabled) && percent > 0 && started && notEnded;
  return {
    active,
    percent: active ? percent : 0,
    label: active ? settings.promoLabel || `${percent}% de descuento` : "",
  };
}

/** Centavos de descuento que la promo aplica sobre un subtotal de productos. */
export function promoDiscountCents(subtotalCents: number, percent: number) {
  if (!percent || subtotalCents <= 0) return 0;
  return Math.round((subtotalCents * percent) / 100);
}

/**
 * Desglosa el IVA de un monto que YA lo incluye.
 * 115 con 15% -> impuesto 15, base 100.
 */
export function extractIva(amountWithTax: number, ratePercent: number) {
  if (!ratePercent || ratePercent <= 0) return { base: amountWithTax, tax: 0 };
  const base = Math.round(amountWithTax / (1 + ratePercent / 100));
  return { base, tax: amountWithTax - base };
}
