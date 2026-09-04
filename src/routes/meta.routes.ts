import { Router } from "express";
import { trackMetaEvent } from "../controllers/meta.controller";

const metaRouter = Router();

// Publico a proposito: la tienda mide visitantes sin cuenta.
metaRouter.post("/events", trackMetaEvent);

export default metaRouter;
