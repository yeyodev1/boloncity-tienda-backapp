import { Request, Response } from "express";
import axios from "axios";
import { Branch } from "../models/Branch";
import { quoteDelivery } from "../services/deliveryQuote.service";
import { pickerEnabledBranchFilter, toPublicBranch } from "../services/branchOperational.service";
import { resolveMapsCoordinates } from "../utils/parseMapsUrl";
import { env } from "../config/env";
import { distanceKm } from "../utils/haversine";

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

  // Se recorren de la mas cercana hacia afuera: la sucursal mas cerca puede tener el
  // punto fuera de su poligono y la siguiente cubrirlo igual.
  for (const candidate of scored) {
    const quote = await quoteDelivery({ branch: candidate.branch, lat, lng });
    if (!quote.covered) continue;

    res.json({
      branch: toPublicBranch(candidate.branch),
      distance: Math.round(quote.distance * 10) / 10,
      deliveryFee: quote.deliveryFee,
    });
    return;
  }

  // Ninguna sucursal llega: se dice claro en vez de inventar un precio por distancia.
  res.status(422).json({
    code: "DELIVERY_OUT_OF_COVERAGE",
    message: "Esa dirección queda fuera de nuestra zona de entrega. Puedes elegir retiro en tienda o escribirnos por WhatsApp.",
  });
}
