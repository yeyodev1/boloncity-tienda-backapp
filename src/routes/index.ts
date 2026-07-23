import express, { Application } from "express";
import authRouter from "./auth.routes";
import categoryRouter from "./category.routes";
import branchRouter from "./branch.routes";
import orderRouter from "./order.routes";
import productRouter from "./product.routes";
import userRouter from "./user.routes";
import settingsRouter from "./settings.routes";
import deliveryRouter from "./delivery.routes";
import webhookRouter from "./webhook.routes";

function routerApi(app: Application) {
  const router = express.Router();
  router.use("/auth", authRouter);
  router.use("/branches", branchRouter);
  router.use("/categories", categoryRouter);
  router.use("/products", productRouter);
  router.use("/orders", orderRouter);
  router.use("/users", userRouter);
  router.use("/settings", settingsRouter);
  router.use("/delivery", deliveryRouter);
  router.use("/webhooks", webhookRouter);
  app.use("/api", router);
}

export default routerApi;
