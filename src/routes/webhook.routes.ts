import { Router } from "express";
import { handlePickerWebhook } from "../controllers/webhook.controller";

const webhookRouter = Router();

webhookRouter.post("/picker", handlePickerWebhook);

export default webhookRouter;
