import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import {
  createCategory,
  deleteCategory,
  getCategoryBySlug,
  listCategories,
  reorderCategories,
  updateCategory,
} from "../controllers/category.controller";

const categoryRouter = Router();

categoryRouter.get("/", listCategories);
categoryRouter.get("/:slug", getCategoryBySlug);
categoryRouter.put("/reorder", authMiddleware, adminMiddleware, reorderCategories);
categoryRouter.post("/", authMiddleware, adminMiddleware, createCategory);
categoryRouter.put("/:id", authMiddleware, adminMiddleware, updateCategory);
categoryRouter.delete("/:id", authMiddleware, adminMiddleware, deleteCategory);

export default categoryRouter;
