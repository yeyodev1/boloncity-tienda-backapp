import { Router } from "express";
import { getDeliveryPreCheckout } from "../controllers/delivery.controller";

const deliveryRouter = Router();

deliveryRouter.post("/pre-checkout", getDeliveryPreCheckout);

export default deliveryRouter;
