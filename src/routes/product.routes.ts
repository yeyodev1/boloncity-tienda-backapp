import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { adminOnlyMiddleware } from "../middlewares/adminOnly.middleware";
import { branchScope } from "../middlewares/branchScope.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import {
  createProduct,
  deleteProduct,
  deleteProductImage,
  getProductBySlug,
  listBranchAvailability,
  listProducts,
  toggleBranchAvailability,
  updateProduct,
  uploadProductImage,
} from "../controllers/product.controller";

const productRouter = Router();

// Disponibilidad por sucursal: el vendedor (branch_admin) ve y togglea SU sucursal;
// el admin, cualquiera. No permite crear ni eliminar productos.
productRouter.get("/availability", authMiddleware, adminMiddleware, listBranchAvailability);
productRouter.patch("/:id/availability", authMiddleware, adminMiddleware, toggleBranchAvailability);

productRouter.get("/", branchScope, listProducts);
productRouter.get("/:slug", branchScope, getProductBySlug);
// Crear/editar/eliminar catálogo e imágenes: SOLO admin general (no branch_admin).
productRouter.post("/", authMiddleware, adminOnlyMiddleware, createProduct);
productRouter.put("/:id", authMiddleware, adminOnlyMiddleware, updateProduct);
productRouter.delete("/:id", authMiddleware, adminOnlyMiddleware, deleteProduct);
productRouter.post("/:id/images", authMiddleware, adminOnlyMiddleware, uploadMiddleware.single("image"), uploadProductImage);
productRouter.delete("/:id/images/:publicId", authMiddleware, adminOnlyMiddleware, deleteProductImage);

export default productRouter;
