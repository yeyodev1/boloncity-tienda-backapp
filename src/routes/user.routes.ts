import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminOnlyMiddleware } from "../middlewares/adminOnly.middleware";
import { createUser, deleteUser, getCustomerPoints, getUserById, listCustomers, listUsers, updateUser } from "../controllers/user.controller";

const userRouter = Router();

// Clientes/puntos y gestión de usuarios: solo admin general.
userRouter.get("/customers", authMiddleware, adminOnlyMiddleware, listCustomers);
userRouter.get("/customers/:id", authMiddleware, adminOnlyMiddleware, getCustomerPoints);
userRouter.get("/", authMiddleware, adminOnlyMiddleware, listUsers);
userRouter.get("/:id", authMiddleware, adminOnlyMiddleware, getUserById);
userRouter.post("/", authMiddleware, adminOnlyMiddleware, createUser);
userRouter.put("/:id", authMiddleware, adminOnlyMiddleware, updateUser);
userRouter.delete("/:id", authMiddleware, adminOnlyMiddleware, deleteUser);

export default userRouter;
