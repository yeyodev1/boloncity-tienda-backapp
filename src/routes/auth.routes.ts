import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { login, me, register } from "../controllers/auth.controller";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/register", register);
authRouter.get("/me", authMiddleware, me);

export default authRouter;
