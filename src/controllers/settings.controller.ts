import { Request, Response } from "express";
import { getOrCreateSettings, Setting } from "../models/Setting";
import { Product } from "../models/Product";

export async function getSettings(_req: Request, res: Response) {
  const settings = await getOrCreateSettings();
  res.json(settings);
}

export async function updateSettings(req: Request, res: Response) {
  const { deliveryPricePerKm, ivaRate, pricesIncludeIva } = req.body as {
    deliveryPricePerKm?: number;
    ivaRate?: number;
    pricesIncludeIva?: boolean;
  };

  if (deliveryPricePerKm !== undefined && (typeof deliveryPricePerKm !== "number" || deliveryPricePerKm < 0)) {
    res.status(400).json({ message: "deliveryPricePerKm debe ser un numero positivo" });
    return;
  }
  if (ivaRate !== undefined && (typeof ivaRate !== "number" || ivaRate < 0 || ivaRate > 100)) {
    res.status(400).json({ message: "ivaRate debe ser un porcentaje entre 0 y 100" });
    return;
  }
  if (pricesIncludeIva !== undefined && typeof pricesIncludeIva !== "boolean") {
    res.status(400).json({ message: "pricesIncludeIva debe ser booleano" });
    return;
  }

  const settings = await getOrCreateSettings();
  if (deliveryPricePerKm !== undefined) settings.deliveryPricePerKm = deliveryPricePerKm;
  if (ivaRate !== undefined) settings.ivaRate = ivaRate;
  if (pricesIncludeIva !== undefined) settings.pricesIncludeIva = pricesIncludeIva;
  await settings.save();

  res.json(settings);
}

/**
 * Aplica el IVA global a todo el catalogo de una pasada.
 * Existe porque cambiar la tasa en settings no reescribe los productos ya guardados,
 * y en Ecuador el cambio de IVA aplica al catalogo entero el mismo dia.
 */
export async function applyIvaToCatalog(req: Request, res: Response) {
  const settings = await getOrCreateSettings();
  const rate = typeof req.body?.ivaRate === "number" ? req.body.ivaRate : settings.ivaRate;
  const hasIva = req.body?.hasIva === undefined ? true : Boolean(req.body.hasIva);

  if (typeof rate !== "number" || rate < 0 || rate > 100) {
    res.status(400).json({ message: "ivaRate debe ser un porcentaje entre 0 y 100" });
    return;
  }

  const result = await Product.updateMany({}, { $set: { hasIva, ivaRate: hasIva ? rate : 0 } });

  if (typeof req.body?.ivaRate === "number" && req.body.ivaRate !== settings.ivaRate) {
    settings.ivaRate = req.body.ivaRate;
    await settings.save();
  }

  res.json({
    message: hasIva
      ? `IVA del ${rate}% aplicado a ${result.modifiedCount} productos`
      : `IVA retirado de ${result.modifiedCount} productos`,
    modified: result.modifiedCount,
    settings,
  });
}
