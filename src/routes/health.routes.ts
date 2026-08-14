import { Router } from "express";
import { getConfigHealth } from "../controllers/health.controller";

const healthRouter = Router();

healthRouter.get("/config", getConfigHealth);

export default healthRouter;
