interface PointsSettings {
  pointsEnabled: boolean;
  pointsEarnDollars: number;
  pointsEarnAmount: number;
  pointsRedeemPerDollar: number;
}

/** Puntos extra configurados por producto (Rewards del admin). */
export function calculatePoints(items: Array<{ quantity: number; pointsValue?: number | null }>) {
  return items.reduce((total, item) => total + Math.max(0, item.pointsValue || 0) * Math.max(0, item.quantity), 0);
}

/**
 * Puntos que gana una compra: base por monto gastado (cada `pointsEarnDollars`
 * dolares dan `pointsEarnAmount` puntos, sobre el subtotal de productos) mas los
 * puntos extra por producto configurados en Rewards.
 */
export function calculateEarnedPoints(
  subtotalCents: number,
  items: Array<{ quantity: number; pointsValue?: number | null }>,
  settings: PointsSettings
) {
  if (!settings.pointsEnabled) return 0;
  const earnDollars = Math.max(0.01, settings.pointsEarnDollars || 1);
  const earnAmount = Math.max(0, settings.pointsEarnAmount || 0);
  const base = Math.floor(subtotalCents / 100 / earnDollars) * earnAmount;
  return base + calculatePoints(items);
}

/** Cuantos centavos de descuento valen `points` puntos (100 pts = $1 por defecto). */
export function pointsToDiscountCents(points: number, redeemPerDollar: number) {
  const rate = Math.max(1, redeemPerDollar || 100);
  return Math.floor((Math.max(0, points) / rate) * 100);
}

/** Cuantos puntos hacen falta para cubrir `cents` centavos de descuento. */
export function discountCentsToPoints(cents: number, redeemPerDollar: number) {
  const rate = Math.max(1, redeemPerDollar || 100);
  return Math.ceil((Math.max(0, cents) / 100) * rate);
}
