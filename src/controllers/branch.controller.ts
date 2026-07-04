import { Request, Response } from "express";
import { Branch } from "../models/Branch";
import { Order } from "../models/Order";
import { parseMapsUrl } from "../utils/parseMapsUrl";
import { distanceKm } from "../utils/haversine";
import { slugify } from "../utils/slugify";
import { deleteFromCloudinary, isCloudinaryConfigured, uploadToCloudinary } from "../services/cloudinary.service";

export async function listBranches(_req: Request, res: Response) {
  const branches = await Branch.find().sort({ createdAt: -1 });
  res.json(branches);
}

export async function listPublicBranches(_req: Request, res: Response) {
  const branches = await Branch.find({ isActive: true }).sort({ createdAt: -1 });
  res.json(branches);
}

export async function createBranch(req: Request, res: Response) {
  const coordinates = parseMapsUrl(req.body.googleMapsUrl);
  const slug = req.body.slug || slugify(req.body.name);
  const existingBranch = await Branch.findOne({ slug }).lean();
  if (existingBranch) {
    res.status(409).json({ message: "Ya existe una sucursal con ese nombre. Usa otro nombre para crearla." });
    return;
  }

  const branch = await Branch.create({
    ...req.body,
    slug,
    coordinates,
  });
  res.status(201).json(branch);
}

export async function updateBranch(req: Request, res: Response) {
  const coordinates = req.body.googleMapsUrl ? parseMapsUrl(req.body.googleMapsUrl) : undefined;
  const slug = req.body.slug || (req.body.name ? slugify(req.body.name) : undefined);
  if (slug) {
    const existingBranch = await Branch.findOne({ slug, _id: { $ne: req.params.id } }).lean();
    if (existingBranch) {
      res.status(409).json({ message: "Ya existe una sucursal con ese nombre. Usa otro nombre para actualizarla." });
      return;
    }
  }

  const branch = await Branch.findByIdAndUpdate(
    req.params.id,
    {
      ...req.body,
      ...(slug ? { slug } : {}),
      ...(coordinates ? { coordinates } : {}),
    },
    { new: true }
  );

  if (!branch) {
    res.status(404).json({ message: "Branch not found" });
    return;
  }

  res.json(branch);
}

export async function deleteBranch(req: Request, res: Response) {
  const ordersCount = await Order.countDocuments({ branch: req.params.id });
  if (ordersCount > 0) {
    res.status(400).json({ message: "No se puede eliminar una sucursal con ordenes asociadas" });
    return;
  }

  const branch = await Branch.findByIdAndDelete(req.params.id);
  if (!branch) {
    res.status(404).json({ message: "Branch not found" });
    return;
  }

  await deleteFromCloudinary(branch.imagePublicId || "");
  res.json({ message: "Branch deleted" });
}

export async function uploadBranchImage(req: Request, res: Response) {
  const branch = await Branch.findById(req.params.id);
  if (!branch) {
    res.status(404).json({ message: "Branch not found" });
    return;
  }

  const file = (req as Request & { file?: { buffer?: Buffer } }).file;
  if (!file?.buffer) {
    res.status(400).json({ message: "Image file is required" });
    return;
  }

  if (!isCloudinaryConfigured()) {
    res.status(503).json({ message: "Cloudinary is not configured" });
    return;
  }

  if (branch.imagePublicId) {
    await deleteFromCloudinary(branch.imagePublicId);
  }

  const result = await uploadToCloudinary(file.buffer, `boloncity/branches/${branch.slug}`);
  branch.imageUrl = result.secure_url;
  branch.imagePublicId = result.public_id;
  await branch.save();

  res.status(201).json(branch);
}

export async function getNearestBranch(req: Request, res: Response) {
  const { lat, lng } = req.body as { lat: number; lng: number };
  const branches = await Branch.find({ isActive: true });
  const scored = branches
    .filter((branch) => branch.coordinates?.lat != null && branch.coordinates?.lng != null)
    .map((branch) => ({
      branch,
      distance: distanceKm({ lat, lng }, { lat: branch.coordinates!.lat, lng: branch.coordinates!.lng }),
    }))
    .sort((a, b) => a.distance - b.distance);

  if (!scored.length) {
    res.status(404).json({ message: "No branches available" });
    return;
  }

  res.json(scored[0]);
}
