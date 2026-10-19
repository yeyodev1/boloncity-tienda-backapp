import { NextFunction, Response } from "express";
import { AuthRequest } from "../types/AuthRequest";

export function branchScope(req: AuthRequest, _res: Response, next: NextFunction) {
  const activeBranch = req.headers["x-branch-id"];
  req.activeBranch = Array.isArray(activeBranch) ? activeBranch[0] : activeBranch || null;

  if (!req.user) {
    // El comprador anonimo tambien manda X-Branch-Id (la sucursal elegida en la tienda).
    // Ignorarlo mostraba el catalogo completo: productos apagados en esa sucursal se
    // seguian vendiendo como disponibles.
    req.branchFilter = req.activeBranch ? { branch: req.activeBranch } : {};
    next();
    return;
  }

  const branches = req.user.branches || [];

  if (req.user.allBranches) {
    req.branchFilter = req.activeBranch ? { branch: req.activeBranch } : {};
    next();
    return;
  }

  if (req.activeBranch && branches.length > 0 && !branches.includes(req.activeBranch)) {
    req.branchFilter = { branch: { $in: branches } };
    next();
    return;
  }

  if (req.activeBranch) {
    req.branchFilter = { branch: req.activeBranch };
  } else if (branches.length) {
    req.branchFilter = { branch: { $in: branches } };
  } else {
    req.branchFilter = {};
  }

  next();
}
