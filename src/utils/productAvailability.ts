/** Un producto está disponible en una sucursal si no está en unavailableBranches y (branches vacío o incluye la sucursal). */
export function isAvailableAt(product: { isAvailable?: boolean; branches?: unknown[]; unavailableBranches?: unknown[] }, branchId: string) {
  if (product.isAvailable === false) return false;
  const unavailable = (product.unavailableBranches || []).map((b: unknown) => String((b as { _id?: unknown })?._id ?? b));
  if (unavailable.includes(branchId)) return false;
  const limited = (product.branches || []).map((b: unknown) => String((b as { _id?: unknown })?._id ?? b));
  if (limited.length && !limited.includes(branchId)) return false;
  return true;
}
