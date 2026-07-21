import { Request, Response } from "express";
import { Setting } from "../models/Setting";

export async function getSettings(_req: Request, res: Response) {
  let settings = await Setting.findOne();
  if (!settings) {
    settings = await Setting.create({ deliveryPricePerKm: 150 });
  }
  res.json(settings);
}

export async function updateSettings(req: Request, res: Response) {
  const { deliveryPricePerKm } = req.body as { deliveryPricePerKm?: number };
  if (typeof deliveryPricePerKm !== "number" || deliveryPricePerKm < 0) {
    res.status(400).json({ message: "deliveryPricePerKm must be a positive number" });
    return;
  }
  let settings = await Setting.findOne();
  if (!settings) {
    settings = await Setting.create({ deliveryPricePerKm });
  } else {
    settings.deliveryPricePerKm = deliveryPricePerKm;
    await settings.save();
  }
  res.json(settings);
}
