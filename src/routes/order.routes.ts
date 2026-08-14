import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { branchScope } from "../middlewares/branchScope.middleware";
import { addOrderNote, confirmOrder, createOrder, getMyOrderById, getMyOrders, getOrderById, getOrderByNumber, getOrdersByEmail, listOrders, refundOrder, retryPickerBooking, startScheduledPickerSearch, streamMyOrder, streamOrderByNumber, updateOrderStatus } from "../controllers/order.controller";
import { whatsappBotAssistant, whatsappBotBrain, whatsappBotCatalog, whatsappBotCheckout, whatsappBotLocation, whatsappBotSearchOrder, whatsappBotTrackOrder } from "../controllers/whatsappBot.controller";

const orderRouter = Router();

orderRouter.post("/", createOrder);
orderRouter.post("/confirm", confirmOrder);
orderRouter.post("/whatsapp-bot/brain", whatsappBotBrain);
orderRouter.post("/whatsapp-bot/assistant", whatsappBotAssistant);
orderRouter.post("/whatsapp-bot/catalog", whatsappBotCatalog);
orderRouter.get("/whatsapp-bot/catalog", whatsappBotCatalog);
orderRouter.post("/whatsapp-bot/location", whatsappBotLocation);
orderRouter.post("/whatsapp-bot/checkout", whatsappBotCheckout);
orderRouter.post("/whatsapp-bot/search-order", whatsappBotSearchOrder);
orderRouter.get("/whatsapp-bot/search-order", whatsappBotSearchOrder);
orderRouter.get("/whatsapp-bot/track", whatsappBotTrackOrder);
orderRouter.post("/whatsapp-bot/track", whatsappBotTrackOrder);
orderRouter.get("/", authMiddleware, adminMiddleware, branchScope, listOrders);
orderRouter.get("/by-id/:id", authMiddleware, adminMiddleware, branchScope, getOrderById);
orderRouter.get("/by-email/:email", getOrdersByEmail);
orderRouter.get("/mine/list", authMiddleware, getMyOrders);
orderRouter.get("/mine/:id/stream", authMiddleware, streamMyOrder);
orderRouter.get("/mine/:id", authMiddleware, getMyOrderById);
orderRouter.get("/:orderNumber/stream", streamOrderByNumber);
orderRouter.get("/:orderNumber", getOrderByNumber);
orderRouter.post("/:orderNumber/retry-picker-public", retryPickerBooking);
orderRouter.post("/:id/notes", authMiddleware, adminMiddleware, branchScope, addOrderNote);
orderRouter.put("/:id/status", authMiddleware, adminMiddleware, branchScope, updateOrderStatus);
orderRouter.post("/:id/refund", authMiddleware, adminMiddleware, branchScope, refundOrder);
orderRouter.post("/:id/start-picker-search", authMiddleware, adminMiddleware, branchScope, startScheduledPickerSearch);
orderRouter.post("/:id/retry-picker", authMiddleware, retryPickerBooking);

export default orderRouter;
