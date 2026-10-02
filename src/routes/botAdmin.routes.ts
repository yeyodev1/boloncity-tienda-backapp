import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { getBotConversation, getBotMetrics, listBotConversations } from "../controllers/botAdmin.controller";

// Panel "Chats del bot" (solo lectura). Lo ven administración y el equipo de sucursal; los clientes no.
const botAdminRouter = Router();

botAdminRouter.get("/metrics", authMiddleware, adminMiddleware, getBotMetrics);
botAdminRouter.get("/conversations", authMiddleware, adminMiddleware, listBotConversations);
botAdminRouter.get("/conversations/:phone", authMiddleware, adminMiddleware, getBotConversation);

export default botAdminRouter;
