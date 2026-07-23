import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { forgotPassword, login, me, register, resetPassword } from "../controllers/auth.controller";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/register", register);
authRouter.post("/forgot-password", forgotPassword);
authRouter.post("/reset-password", resetPassword);
authRouter.get("/me", authMiddleware, me);

export default authRouter;
