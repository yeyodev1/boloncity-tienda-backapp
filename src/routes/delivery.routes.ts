import { Router } from "express";
import { getDeliveryPreCheckout, resolveMapsLink } from "../controllers/delivery.controller";

const deliveryRouter = Router();

deliveryRouter.post("/pre-checkout", getDeliveryPreCheckout);
deliveryRouter.post("/resolve-maps", resolveMapsLink);

export default deliveryRouter;
