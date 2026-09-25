import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import {
  getCartMetrics,
  listAbandonedCarts,
  recoverCart,
  runCartReminders,
  sendCartTestMessage,
  trackAbandonedCart,
} from "../controllers/abandonedCart.controller";

const cartRouter = Router();

// Publicas: las llama el comprador anonimo, que es justo a quien queremos recuperar.
cartRouter.post("/track", trackAbandonedCart);
cartRouter.get("/recover/:token", recoverCart);

// El cron de Vercel. Se protege con CRON_SECRET dentro del controlador.
cartRouter.get("/cron/reminders", runCartReminders);
cartRouter.post("/cron/reminders", runCartReminders);

// Tablero: metricas y gestion, solo para administradores.
cartRouter.get("/metrics", authMiddleware, adminMiddleware, getCartMetrics);
cartRouter.get("/", authMiddleware, adminMiddleware, listAbandonedCarts);
cartRouter.post("/:id/test-message", authMiddleware, adminMiddleware, sendCartTestMessage);

export default cartRouter;
