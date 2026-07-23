import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { branchScope } from "../middlewares/branchScope.middleware";
import { addOrderNote, confirmOrder, createOrder, getMyOrderById, getMyOrders, getOrderById, getOrderByNumber, getOrdersByEmail, listOrders, retryPickerBooking, updateOrderStatus } from "../controllers/order.controller";

const orderRouter = Router();

orderRouter.post("/", createOrder);
orderRouter.post("/confirm", confirmOrder);
orderRouter.get("/", authMiddleware, adminMiddleware, branchScope, listOrders);
orderRouter.get("/by-id/:id", authMiddleware, adminMiddleware, branchScope, getOrderById);
orderRouter.get("/by-email/:email", getOrdersByEmail);
orderRouter.get("/mine/list", authMiddleware, getMyOrders);
orderRouter.get("/mine/:id", authMiddleware, getMyOrderById);
orderRouter.get("/:orderNumber", getOrderByNumber);
orderRouter.post("/:id/notes", authMiddleware, adminMiddleware, branchScope, addOrderNote);
orderRouter.put("/:id/status", authMiddleware, adminMiddleware, branchScope, updateOrderStatus);
orderRouter.post("/:id/retry-picker", authMiddleware, retryPickerBooking);

export default orderRouter;
