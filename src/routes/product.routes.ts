import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { branchScope } from "../middlewares/branchScope.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import {
  createProduct,
  deleteProduct,
  deleteProductImage,
  getProductBySlug,
  listProducts,
  updateProduct,
  uploadProductImage,
} from "../controllers/product.controller";

const productRouter = Router();

productRouter.get("/", branchScope, listProducts);
productRouter.get("/:slug", branchScope, getProductBySlug);
productRouter.post("/", authMiddleware, adminMiddleware, createProduct);
productRouter.put("/:id", authMiddleware, adminMiddleware, updateProduct);
productRouter.delete("/:id", authMiddleware, adminMiddleware, deleteProduct);
productRouter.post("/:id/images", authMiddleware, adminMiddleware, uploadMiddleware.single("image"), uploadProductImage);
productRouter.delete("/:id/images/:publicId", authMiddleware, adminMiddleware, deleteProductImage);

export default productRouter;
