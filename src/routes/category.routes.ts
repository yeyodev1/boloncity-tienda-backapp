import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminOnlyMiddleware } from "../middlewares/adminOnly.middleware";
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
// Mutar categorías: solo admin general.
categoryRouter.put("/reorder", authMiddleware, adminOnlyMiddleware, reorderCategories);
categoryRouter.post("/", authMiddleware, adminOnlyMiddleware, createCategory);
categoryRouter.put("/:id", authMiddleware, adminOnlyMiddleware, updateCategory);
categoryRouter.delete("/:id", authMiddleware, adminOnlyMiddleware, deleteCategory);

export default categoryRouter;
