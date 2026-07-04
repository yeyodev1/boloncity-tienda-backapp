import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";

export function adminMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || !["admin", "branch_admin"].includes(req.user.accountType)) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }

  next();
}
