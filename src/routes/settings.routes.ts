import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { getSettings, updateSettings } from "../controllers/settings.controller";

const settingsRouter = Router();

settingsRouter.get("/", getSettings);
settingsRouter.put("/", authMiddleware, adminMiddleware, updateSettings);

export default settingsRouter;
