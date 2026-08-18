import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminOnlyMiddleware } from "../middlewares/adminOnly.middleware";
import { applyIvaToCatalog, getPointsBalance, getSettings, updateSettings } from "../controllers/settings.controller";

const settingsRouter = Router();

settingsRouter.get("/", getSettings);
settingsRouter.get("/points-balance", getPointsBalance);
// Configuración global: solo admin general.
settingsRouter.put("/", authMiddleware, adminOnlyMiddleware, updateSettings);
settingsRouter.post("/iva/apply", authMiddleware, adminOnlyMiddleware, applyIvaToCatalog);

export default settingsRouter;
