import { Request, Response } from "express";
import axios from "axios";
import { Branch } from "../models/Branch";
import { Setting } from "../models/Setting";
import { preCheckout, getPickerBranchKey } from "../services/pickerexpress.service";

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

  const branches = await Branch.find({ isActive: true });
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

  const branchKey = nearest.branch.pickerApiKey || getPickerBranchKey(nearest.branch.name);
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
    branch: nearest.branch,
    distance: roundedDistance,
    deliveryFee,
  });
}
