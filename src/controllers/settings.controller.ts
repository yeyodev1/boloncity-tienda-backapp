import { Request, Response } from "express";
import { getActivePromo, getOrCreateSettings, Setting } from "../models/Setting";
import { Product } from "../models/Product";
import { User } from "../models/User";
import { pointsToDiscountCents } from "../services/points.service";

export async function getSettings(_req: Request, res: Response) {
  const settings = await getOrCreateSettings();
  // `activePromo` es la promo ya resuelta (vigencia incluida): el front no repite la lógica.
  res.json({ ...settings.toObject(), activePromo: getActivePromo(settings) });
}

/** Saldo de puntos por correo, para canjearlos desde el checkout sin iniciar sesion. */
export async function getPointsBalance(req: Request, res: Response) {
  const email = String(req.query.email || "").toLowerCase().trim();
  const settings = await getOrCreateSettings();
  if (!settings.pointsEnabled || !email || !email.includes("@")) {
    res.json({ enabled: settings.pointsEnabled, points: 0, discountCents: 0, redeemPerDollar: settings.pointsRedeemPerDollar });
    return;
  }
  const user = await User.findOne({ email }).select("points");
  const points = user?.points || 0;
  res.json({
    enabled: true,
    points,
    discountCents: pointsToDiscountCents(points, settings.pointsRedeemPerDollar),
    redeemPerDollar: settings.pointsRedeemPerDollar,
  });
}

export async function updateSettings(req: Request, res: Response) {
  const { deliveryPricePerKm, deliveryMaxDistanceKm, ivaRate, pricesIncludeIva, pointsEnabled, pointsEarnDollars, pointsEarnAmount, pointsRedeemPerDollar, promoEnabled, promoPercent, promoLabel, promoStartsAt, promoEndsAt } = req.body as {
    deliveryPricePerKm?: number;
    deliveryMaxDistanceKm?: number;
    ivaRate?: number;
    pricesIncludeIva?: boolean;
    pointsEnabled?: boolean;
    pointsEarnDollars?: number;
    pointsEarnAmount?: number;
    pointsRedeemPerDollar?: number;
    promoEnabled?: boolean;
    promoPercent?: number;
    promoLabel?: string;
    promoStartsAt?: string | null;
    promoEndsAt?: string | null;
  };

  if (deliveryPricePerKm !== undefined && (typeof deliveryPricePerKm !== "number" || deliveryPricePerKm < 0)) {
    res.status(400).json({ message: "deliveryPricePerKm debe ser un numero positivo" });
    return;
  }
  if (deliveryMaxDistanceKm !== undefined && (typeof deliveryMaxDistanceKm !== "number" || deliveryMaxDistanceKm < 1)) {
    res.status(400).json({ message: "deliveryMaxDistanceKm debe ser al menos 1 km" });
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
  if (pointsEnabled !== undefined && typeof pointsEnabled !== "boolean") {
    res.status(400).json({ message: "pointsEnabled debe ser booleano" });
    return;
  }
  if (pointsEarnDollars !== undefined && (typeof pointsEarnDollars !== "number" || pointsEarnDollars <= 0)) {
    res.status(400).json({ message: "pointsEarnDollars debe ser un numero mayor a 0" });
    return;
  }
  if (pointsEarnAmount !== undefined && (typeof pointsEarnAmount !== "number" || pointsEarnAmount < 0)) {
    res.status(400).json({ message: "pointsEarnAmount debe ser un numero positivo" });
    return;
  }
  if (pointsRedeemPerDollar !== undefined && (typeof pointsRedeemPerDollar !== "number" || pointsRedeemPerDollar < 1)) {
    res.status(400).json({ message: "pointsRedeemPerDollar debe ser al menos 1" });
    return;
  }

  if (promoEnabled !== undefined && typeof promoEnabled !== "boolean") {
    res.status(400).json({ message: "promoEnabled debe ser booleano" });
    return;
  }
  if (promoPercent !== undefined && (typeof promoPercent !== "number" || promoPercent < 0 || promoPercent > 100)) {
    res.status(400).json({ message: "promoPercent debe ser un porcentaje entre 0 y 100" });
    return;
  }
  const parsePromoDate = (value?: string | null) => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };
  const startsAt = parsePromoDate(promoStartsAt);
  const endsAt = parsePromoDate(promoEndsAt);
  if (startsAt && endsAt && startsAt > endsAt) {
    res.status(400).json({ message: "La promo no puede terminar antes de empezar." });
    return;
  }

  const settings = await getOrCreateSettings();
  if (deliveryPricePerKm !== undefined) settings.deliveryPricePerKm = deliveryPricePerKm;
  if (deliveryMaxDistanceKm !== undefined) settings.deliveryMaxDistanceKm = deliveryMaxDistanceKm;
  if (ivaRate !== undefined) settings.ivaRate = ivaRate;
  if (pricesIncludeIva !== undefined) settings.pricesIncludeIva = pricesIncludeIva;
  if (pointsEnabled !== undefined) settings.pointsEnabled = pointsEnabled;
  if (pointsEarnDollars !== undefined) settings.pointsEarnDollars = pointsEarnDollars;
  if (pointsEarnAmount !== undefined) settings.pointsEarnAmount = pointsEarnAmount;
  if (pointsRedeemPerDollar !== undefined) settings.pointsRedeemPerDollar = pointsRedeemPerDollar;
  if (promoEnabled !== undefined) settings.promoEnabled = promoEnabled;
  if (promoPercent !== undefined) settings.promoPercent = promoPercent;
  if (promoLabel !== undefined) settings.promoLabel = String(promoLabel).slice(0, 120);
  if (promoStartsAt !== undefined) settings.promoStartsAt = startsAt ?? null;
  if (promoEndsAt !== undefined) settings.promoEndsAt = endsAt ?? null;
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
