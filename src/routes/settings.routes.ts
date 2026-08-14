import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { applyIvaToCatalog, getSettings, updateSettings } from "../controllers/settings.controller";

const settingsRouter = Router();

settingsRouter.get("/", getSettings);
settingsRouter.put("/", authMiddleware, adminMiddleware, updateSettings);
settingsRouter.post("/iva/apply", authMiddleware, adminMiddleware, applyIvaToCatalog);

export default settingsRouter;
