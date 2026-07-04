import express, { Application } from "express";
import authRouter from "./auth.routes";
import categoryRouter from "./category.routes";
import branchRouter from "./branch.routes";
import orderRouter from "./order.routes";
import productRouter from "./product.routes";
import userRouter from "./user.routes";

function routerApi(app: Application) {
  const router = express.Router();
  router.use("/auth", authRouter);
  router.use("/branches", branchRouter);
  router.use("/categories", categoryRouter);
  router.use("/products", productRouter);
  router.use("/orders", orderRouter);
  router.use("/users", userRouter);
  app.use("/api", router);
}

export default routerApi;
