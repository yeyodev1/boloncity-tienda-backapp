import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { changePassword, deleteProfilePhoto, forgotPassword, login, me, register, resetPassword, updateProfile, uploadProfilePhoto } from "../controllers/auth.controller";
import { uploadMiddleware } from "../middlewares/upload.middleware";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.post("/register", register);
authRouter.post("/forgot-password", forgotPassword);
authRouter.post("/reset-password", resetPassword);
authRouter.get("/me", authMiddleware, me);
authRouter.put("/profile", authMiddleware, updateProfile);
authRouter.post("/profile/photo", authMiddleware, uploadMiddleware.single("photo"), uploadProfilePhoto);
authRouter.delete("/profile/photo", authMiddleware, deleteProfilePhoto);
authRouter.put("/change-password", authMiddleware, changePassword);

export default authRouter;
