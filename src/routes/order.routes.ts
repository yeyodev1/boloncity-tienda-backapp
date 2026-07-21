import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { branchScope } from "../middlewares/branchScope.middleware";
import { addOrderNote, confirmOrder, createOrder, getOrderById, getOrderByNumber, getOrdersByEmail, listOrders, updateOrderStatus } from "../controllers/order.controller";

const orderRouter = Router();

orderRouter.post("/", createOrder);
orderRouter.post("/confirm", confirmOrder);
orderRouter.get("/", authMiddleware, adminMiddleware, branchScope, listOrders);
orderRouter.get("/by-id/:id", authMiddleware, adminMiddleware, branchScope, getOrderById);
orderRouter.get("/by-email/:email", getOrdersByEmail);
orderRouter.get("/:orderNumber", getOrderByNumber);
orderRouter.post("/:id/notes", authMiddleware, adminMiddleware, branchScope, addOrderNote);
orderRouter.put("/:id/status", authMiddleware, adminMiddleware, branchScope, updateOrderStatus);

export default orderRouter;
