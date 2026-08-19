import { Request, Response } from "express";
import { Branch } from "../models/Branch";
import { Order } from "../models/Order";
import { resolveMapsCoordinates } from "../utils/parseMapsUrl";
import { distanceKm } from "../utils/haversine";
import { slugify } from "../utils/slugify";
import { deleteFromCloudinary, isCloudinaryConfigured, uploadToCloudinary } from "../services/cloudinary.service";
import { normalizeBranchPayphone, normalizeOpeningHours, normalizePickerStore, normalizeTimezone, pickerEnabledBranchFilter, toPublicBranch } from "../services/branchOperational.service";
import { createPickerStore } from "../services/pickerexpress.service";
import { env } from "../config/env";
import { AuthRequest } from "../types/AuthRequest";

function normalizedBranchInput(body: Record<string, unknown>) {
  const { openingHours, timezone, pickerStore, payphone, cookTimeMinutes, ...values } = body;
  return {
    ...values,
    ...(timezone !== undefined ? { timezone: normalizeTimezone(timezone) } : {}),
    ...(openingHours !== undefined ? { openingHours: normalizeOpeningHours(openingHours) } : {}),
    ...(pickerStore !== undefined ? { pickerStore: normalizePickerStore(pickerStore) } : {}),
    ...(payphone !== undefined ? { payphone: normalizeBranchPayphone(payphone) } : {}),
    ...(cookTimeMinutes !== undefined
      ? { cookTimeMinutes: Math.min(240, Math.max(0, Math.round(Number(cookTimeMinutes)) || 0)) }
      : {}),
  };
}

/**
 * Las llaves de Picker son `select: false` y nunca deben salir del backend, pero el
 * admin necesita saber si la sucursal ya esta conectada en cada entorno. Se manda el
 * hecho, no la llave.
 */
function withPickerFlags(branch: { toObject: () => Record<string, unknown> }) {
  const plain = branch.toObject();
  const pickerStore = (plain.pickerStore || {}) as Record<string, string | undefined>;
  plain.pickerStore = {
    storeId: pickerStore.storeId || "",
    createdAt: pickerStore.createdAt,
    creationStatus: pickerStore.creationStatus || "",
    createdBy: pickerStore.createdBy || "",
    hasDevKey: Boolean(pickerStore.storeApiKey?.trim()),
    hasProdKey: Boolean(pickerStore.productionStoreApiKey?.trim()),
  };
  plain.pickerEnv = env.PICKER_ENV;
  return plain;
}

export async function listBranches(_req: Request, res: Response) {
  const branches = await Branch.find({ isArchived: { $ne: true } })
    .select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey")
    .sort({ createdAt: -1 });
  res.json(branches.map(withPickerFlags));
}

/**
 * Stores que ya existen en Picker, para vincular una sucursal a la suya en vez de
 * crear un duplicado. Marca cuales ya estan tomadas por otra Branch.
 */
export async function listPickerStores(req: Request, res: Response) {
  const environment = req.query.environment === "production" ? "production" : "development";
  const masterKey = env.PICKER_MASTER_KEY.trim();
  if (!masterKey) {
    res.status(503).json({ message: "Falta PICKER_MASTER_KEY en este entorno" });
    return;
  }

  const apiBase = (environment === "production"
    ? "https://api.pickerexpress.com/api"
    : "https://dev-api.pickerexpress.com/api");

  const response = await fetch(`${apiBase}/getStores`, { headers: { Authorization: `Bearer ${masterKey}` } });
  if (!response.ok) {
    res.status(502).json({ message: `Picker respondio ${response.status} al listar las tiendas` });
    return;
  }

  const payload = (await response.json()) as { data?: Array<{ companyName?: string; token?: string }> };
  const stores = payload.data ?? [];

  const keyField = environment === "production" ? "productionStoreApiKey" : "storeApiKey";
  const branches = await Branch.find({ isArchived: { $ne: true } }).select(`+pickerStore.${keyField}`);
  const taken = new Map<string, string>();
  for (const branch of branches) {
    const key = (branch.pickerStore as Record<string, string | undefined> | undefined)?.[keyField];
    if (key) taken.set(key, branch.name);
  }

  res.json({
    environment,
    stores: stores
      .filter((store) => store.token)
      .map((store) => ({
        companyName: store.companyName || "(sin nombre)",
        token: store.token!,
        linkedTo: taken.get(store.token!) || null,
      })),
  });
}

/** Vincula la sucursal a un store que ya existe en Picker. */
export async function linkBranchPickerStore(req: Request, res: Response) {
  const { token, environment } = req.body as { token?: string; environment?: string };
  const target = environment === "production" ? "production" : "development";
  const keyField = target === "production" ? "productionStoreApiKey" : "storeApiKey";

  if (typeof token !== "string" || !token.trim()) {
    res.status(400).json({ message: "Falta el token del store de Picker" });
    return;
  }

  const branch = await Branch.findById(req.params.id);
  if (!branch) {
    res.status(404).json({ message: "Branch not found" });
    return;
  }

  // Dos sucursales apuntando al mismo store mandarian los pedidos al local equivocado.
  const clash = await Branch.findOne({
    _id: { $ne: branch._id },
    isArchived: { $ne: true },
    [`pickerStore.${keyField}`]: token.trim(),
  }).lean();
  if (clash) {
    res.status(409).json({ message: `Ese store de Picker ya esta vinculado a ${(clash as { name?: string }).name || "otra sucursal"}` });
    return;
  }

  await Branch.updateOne(
    { _id: branch._id },
    {
      $set: {
        [`pickerStore.${keyField}`]: token.trim(),
        "pickerStore.creationStatus": "linked",
        "pickerStore.createdBy": "admin",
      },
    }
  );

  const updated = await Branch.findById(branch._id).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  res.json(withPickerFlags(updated!));
}

export async function listPublicBranches(_req: Request, res: Response) {
  const branches = await Branch.find({ isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter() }).sort({ createdAt: -1 });
  res.json(branches.map(toPublicBranch));
}

export async function createBranch(req: Request, res: Response) {
  let input: Record<string, unknown>;
  try {
    input = normalizedBranchInput(req.body);
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "Invalid branch configuration" });
    return;
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    res.status(400).json({ message: "El nombre de la sucursal es obligatorio" });
    return;
  }
  const coordinates = await resolveMapsCoordinates(input.googleMapsUrl as string | undefined, [input.address, input.city].filter(Boolean).join(", "), env.GOOGLE_MAPS_API_KEY);
  const slug = input.slug || slugify(String(input.name || ""));
  const existingBranch = await Branch.findOne({ slug }).lean();
  if (existingBranch) {
    res.status(409).json({ message: "Ya existe una sucursal con ese nombre. Usa otro nombre para crearla." });
    return;
  }

  const branch = await Branch.create({
    ...input,
    slug,
    coordinates,
  });
  res.status(201).json(branch);
}

export async function updateBranch(req: Request, res: Response) {
  let input: Record<string, unknown>;
  try {
    input = normalizedBranchInput(req.body);
  } catch (error) {
    res.status(400).json({ message: error instanceof Error ? error.message : "Invalid branch configuration" });
    return;
  }
  const coordinates = input.googleMapsUrl ? await resolveMapsCoordinates(input.googleMapsUrl as string, [input.address, input.city].filter(Boolean).join(", "), env.GOOGLE_MAPS_API_KEY) : undefined;
  const slug = input.slug || (input.name ? slugify(String(input.name)) : undefined);
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
      ...input,
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
    await Branch.findByIdAndUpdate(req.params.id, { isActive: false, isArchived: true });
    res.json({ message: "Sucursal archivada; las órdenes históricas se conservaron" });
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

function pickerStoreContact(phone: string): { countryCode: string; mobile: string } | null {
  const normalized = phone.replace(/[\s()-]/g, "");
  const mobile = normalized.startsWith("+593")
    ? normalized.slice(4)
    : normalized.startsWith("593")
      ? normalized.slice(3)
      : normalized.startsWith("0")
        ? normalized.slice(1)
        : normalized;

  return /^9\d{8}$/.test(mobile) ? { countryCode: "+593", mobile } : null;
}

export async function createBranchPickerStore(req: AuthRequest, res: Response) {
  if (!env.PICKER_MASTER_KEY.trim()) {
    res.status(503).json({ message: "Picker store integration is not configured" });
    return;
  }

  const branch = await Branch.findById(req.params.id).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  if (!branch) {
    res.status(404).json({ message: "Branch not found" });
    return;
  }

  if (branch.coordinates?.lat == null || branch.coordinates?.lng == null) {
    const coordinates = await resolveMapsCoordinates(branch.googleMapsUrl, [branch.address, branch.city].filter(Boolean).join(", "), env.GOOGLE_MAPS_API_KEY);
    if (coordinates) {
      branch.coordinates = coordinates;
      await branch.save();
    }
  }
  const latitude = branch.coordinates?.lat;
  const longitude = branch.coordinates?.lng;
  const contact = pickerStoreContact(branch.phone || "");
  const email = branch.email?.trim();
  const address = branch.address?.trim();

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude! < -90 || latitude! > 90 || longitude! < -180 || longitude! > 180) {
    res.status(400).json({ message: "Branch must have valid coordinates before creating a Picker store" });
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !contact) {
    res.status(400).json({ message: "Branch must have a valid email and Ecuador mobile number before creating a Picker store" });
    return;
  }
  if (!branch.name.trim() || !address) {
    res.status(400).json({ message: "Branch must have a name and address before creating a Picker store" });
    return;
  }

  const fullAddress = [address, branch.city?.trim()].filter(Boolean).join(", ");
  try {
    const pickerStore = await createPickerStore({
      addressReference: address,
      email,
      mobile: contact.mobile,
      countryCode: contact.countryCode,
      companyName: branch.name.trim(),
      longitude: longitude!,
      latitude: latitude!,
      fullAddress,
    });

    branch.pickerStore = {
      ...branch.pickerStore,
      ...(env.PICKER_ENV === "production" ? { productionStoreApiKey: pickerStore.token } : { storeApiKey: pickerStore.token }),
      ...(pickerStore.storeId ? { storeId: pickerStore.storeId } : {}),
      createdAt: new Date(),
      createdBy: req.user?.userId || "",
      creationStatus: "active",
    };
    await branch.save();

    res.json(toPublicBranch(branch));
  } catch {
    res.status(502).json({ message: "Picker store creation failed" });
  }
}

export async function getNearestBranch(req: Request, res: Response) {
  const { lat, lng } = req.body as { lat: number; lng: number };
  const branches = await Branch.find({ isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter() });
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

  res.json({ ...scored[0], branch: toPublicBranch(scored[0].branch) });
}
