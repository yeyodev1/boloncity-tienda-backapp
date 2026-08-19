import { Request, Response } from "express";
import axios from "axios";
import { Branch } from "../models/Branch";
import { Setting } from "../models/Setting";
import { preCheckout } from "../services/pickerexpress.service";
import { getPickerStoreApiKey, pickerEnabledBranchFilter, toPublicBranch } from "../services/branchOperational.service";
import { resolveMapsCoordinates } from "../utils/parseMapsUrl";
import { env } from "../config/env";

/**
 * Resuelve un enlace de Google Maps a coordenadas. Los links cortos
 * (maps.app.goo.gl) no traen coordenadas en la URL: hay que seguir el
 * redirect desde el servidor (el navegador no puede por CORS).
 */
export async function resolveMapsLink(req: Request, res: Response) {
  const { url, address } = req.body || {};
  if (!url || typeof url !== "string") {
    res.status(400).json({ message: "Falta el enlace de Google Maps" });
    return;
  }
  const coords = await resolveMapsCoordinates(url, typeof address === "string" ? address : "", env.GOOGLE_MAPS_API_KEY);
  if (!coords) {
    res.status(422).json({ message: "No pudimos obtener la ubicación de ese enlace. Verifica que sea un enlace de Google Maps." });
    return;
  }
  res.json(coords);
}

function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const A =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(A), Math.sqrt(1 - A));
}

export async function getDeliveryPreCheckout(req: Request, res: Response) {
  const { lat, lng } = req.body as { lat: number; lng: number };
  if (!lat || !lng) {
    res.status(400).json({ message: "lat and lng are required" });
    return;
  }

  const branches = await Branch.find({ isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter() }).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  const scored = branches
    .filter((b) => b.coordinates?.lat != null && b.coordinates?.lng != null)
    .map((b) => ({
      branch: b,
      distance: distanceKm({ lat, lng }, { lat: b.coordinates!.lat, lng: b.coordinates!.lng }),
    }))
    .sort((a, b) => a.distance - b.distance);

  if (!scored.length) {
    res.status(404).json({ message: "No branches available for delivery" });
    return;
  }

  const nearest = scored[0];
  const roundedDistance = Math.round(nearest.distance * 10) / 10;

  let deliveryFee: number;

  const branchKey = getPickerStoreApiKey(nearest.branch.pickerStore);
  if (branchKey) {
    try {
      const pickerResult = await preCheckout({ branchKey, latitude: lat, longitude: lng });
      deliveryFee = pickerResult.deliveryFee;
    } catch {
      const settings = await Setting.findOne();
      const pricePerKm = settings?.deliveryPricePerKm || 150;
      deliveryFee = Math.round(nearest.distance * (pricePerKm / 100) * 100) / 100;
    }
  } else {
    const settings = await Setting.findOne();
    const pricePerKm = settings?.deliveryPricePerKm || 150;
    deliveryFee = Math.round(nearest.distance * (pricePerKm / 100) * 100) / 100;
  }

  res.json({
    branch: toPublicBranch(nearest.branch),
    distance: roundedDistance,
    deliveryFee,
  });
}
