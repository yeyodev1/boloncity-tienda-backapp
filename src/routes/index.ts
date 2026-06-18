import express, { Application } from "express";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  // Register your routes here:
  // router.use("/users", userRouter);
}

export default routerApi;
