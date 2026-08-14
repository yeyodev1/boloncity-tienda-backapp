import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { createBranch, createBranchPickerStore, deleteBranch, getNearestBranch, linkBranchPickerStore, listBranches, listPickerStores, listPublicBranches, updateBranch, uploadBranchImage } from "../controllers/branch.controller";
import { uploadMiddleware } from "../middlewares/upload.middleware";

const branchRouter = Router();

branchRouter.get("/", authMiddleware, adminMiddleware, listBranches);
branchRouter.get("/public", listPublicBranches);
branchRouter.post("/", authMiddleware, adminMiddleware, createBranch);
branchRouter.put("/:id", authMiddleware, adminMiddleware, updateBranch);
branchRouter.delete("/:id", authMiddleware, adminMiddleware, deleteBranch);
branchRouter.post("/:id/image", authMiddleware, adminMiddleware, uploadMiddleware.single("image"), uploadBranchImage);
branchRouter.get("/picker-stores", authMiddleware, adminMiddleware, listPickerStores);
branchRouter.post("/:id/picker-store", authMiddleware, adminMiddleware, createBranchPickerStore);
branchRouter.post("/:id/picker-link", authMiddleware, adminMiddleware, linkBranchPickerStore);
branchRouter.post("/nearest", getNearestBranch);

export default branchRouter;
