import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { branchScope } from "../middlewares/branchScope.middleware";
import { createUser, deleteUser, getUserById, listUsers, updateUser } from "../controllers/user.controller";

const userRouter = Router();

userRouter.get("/", authMiddleware, adminMiddleware, branchScope, listUsers);
userRouter.get("/:id", authMiddleware, adminMiddleware, branchScope, getUserById);
userRouter.post("/", authMiddleware, adminMiddleware, branchScope, createUser);
userRouter.put("/:id", authMiddleware, adminMiddleware, branchScope, updateUser);
userRouter.delete("/:id", authMiddleware, adminMiddleware, branchScope, deleteUser);

export default userRouter;
