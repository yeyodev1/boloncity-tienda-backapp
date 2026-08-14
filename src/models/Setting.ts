import mongoose, { Schema } from "mongoose";

export interface ISetting {
  deliveryPricePerKm: number;
  /** IVA vigente en porcentaje (15 = 15%). Se usa como tasa por defecto del catalogo. */
  ivaRate: number;
  /**
   * true = los precios del catalogo ya incluyen IVA (es como se cobra en Ecuador).
   * El impuesto se desglosa hacia atras sobre el precio, no se suma encima.
   */
  pricesIncludeIva: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    deliveryPricePerKm: { type: Number, required: true, default: 150 },
    ivaRate: { type: Number, required: true, default: 15, min: 0, max: 100 },
    pricesIncludeIva: { type: Boolean, required: true, default: true },
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
 * Desglosa el IVA de un monto que YA lo incluye.
 * 115 con 15% -> impuesto 15, base 100.
 */
export function extractIva(amountWithTax: number, ratePercent: number) {
  if (!ratePercent || ratePercent <= 0) return { base: amountWithTax, tax: 0 };
  const base = Math.round(amountWithTax / (1 + ratePercent / 100));
  return { base, tax: amountWithTax - base };
}
