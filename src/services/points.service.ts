export function calculatePoints(items: Array<{ quantity: number; pointsValue?: number | null }>) {
  return items.reduce((total, item) => total + Math.max(0, item.pointsValue || 0) * Math.max(0, item.quantity), 0);
}
