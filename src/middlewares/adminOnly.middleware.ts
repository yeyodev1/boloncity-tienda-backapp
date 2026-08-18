import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";

/**
 * Solo administradores generales (accountType "admin" o allBranches).
 * Los admin de sucursal (branch_admin) NO pasan: no pueden crear, editar ni
 * eliminar catálogo, usuarios, categorías ni configuración. Ellos solo operan
 * pedidos y la disponibilidad de su propia sucursal.
 */
export function adminOnlyMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || (req.user.accountType !== "admin" && !req.user.allBranches)) {
    res.status(403).json({ message: "Solo un administrador general puede hacer esto" });
    return;
  }
  next();
}
