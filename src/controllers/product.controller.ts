import { Request, Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { Product } from "../models/Product";
import { Category } from "../models/Category";
import { deleteFromCloudinary, isCloudinaryConfigured, uploadToCloudinary } from "../services/cloudinary.service";
import { slugify } from "../utils/slugify";
import { getOrCreateSettings } from "../models/Setting";

function parseCategoryIds(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function parseJsonArray<T>(value: unknown, fallback: T[] = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T[];
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBoolean(value: unknown, fallback = false) {
  if (value === undefined) return fallback;
  return value === true || value === "true";
}

function parseInternalCode(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export async function listProducts(req: Request, res: Response) {
  const { category, q, available, paginate, admin } = req.query;
  const filter: Record<string, unknown> = {};
  const queryParts: Array<Record<string, unknown>> = [];

  if (category) {
    const categoryDoc = await Category.findOne({ slug: category }).lean();
    if (categoryDoc) filter.categories = (categoryDoc as any)._id;
  }
  if (typeof q === "string" && q.trim()) {
    const safeQuery = new RegExp(escapeRegExp(q.trim()), "i");
    queryParts.push({
      $or: [{ name: safeQuery }, { code: safeQuery }, { description: safeQuery }],
    });
  }
  if (available === "true") filter.isAvailable = true;
  const branchFilter = (req as Request & { branchFilter?: Record<string, unknown> }).branchFilter;
  if (branchFilter?.branch && admin !== "true") {
    queryParts.push({
      $or: [
        { branches: { $size: 0 }, unavailableBranches: { $ne: branchFilter.branch } },
        { branches: branchFilter.branch },
      ],
    });
  }

  if (queryParts.length === 1) {
    Object.assign(filter, queryParts[0]);
  } else if (queryParts.length > 1) {
    filter.$and = queryParts;
  }

  const query = Product.find(filter).populate("categories").populate("branches").populate("unavailableBranches").sort({ isBestSeller: -1, sortOrder: 1, createdAt: -1 });

  if (paginate === "true") {
    const requestedPage = Number(req.query.page);
    const requestedLimit = Number(req.query.limit);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : 10;
    const total = await Product.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const products = await query.skip((safePage - 1) * limit).limit(limit);

    res.json({
      data: products,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
      },
    });
    return;
  }

  res.json(await query);
}

export async function getProductBySlug(req: Request, res: Response) {
  const branchFilter = (req as Request & { branchFilter?: Record<string, unknown> }).branchFilter;
  const product = await Product.findOne({
    slug: req.params.slug,
    ...(branchFilter?.branch ? { $or: [{ branches: { $size: 0 }, unavailableBranches: { $ne: branchFilter.branch } }, { branches: branchFilter.branch }] } : {}),
  }).populate("categories").populate("branches").populate("unavailableBranches");
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  res.json(product);
}

/**
 * IVA del producto. Si el formulario no manda nada, hereda la tasa global de settings
 * en vez de quedar en cero: los precios del catalogo ya vienen con IVA incluido.
 */
async function resolveIva(body: Record<string, unknown>) {
  const settings = await getOrCreateSettings();
  const hasIva = body.hasIva === undefined ? true : parseBoolean(body.hasIva, true);
  if (!hasIva) return { hasIva: false, ivaRate: 0 };
  const rate = Number(body.ivaRate);
  return { hasIva: true, ivaRate: Number.isFinite(rate) && rate > 0 ? rate : settings.ivaRate };
}

export async function createProduct(req: Request, res: Response) {
  const imagePayload = parseJsonArray<{ url: string; publicId: string }>(req.body.images, []);
  const branchPrices = parseJsonArray<{ branch: string; price: number }>(req.body.branchPrices, []);
  const iva = await resolveIva(req.body);
  const product = await Product.create({
    ...req.body,
    code: parseInternalCode(req.body.code),
    ...iva,
    slug: req.body.slug || slugify(req.body.name),
    categories: parseCategoryIds(req.body.categories),
    branches: parseCategoryIds(req.body.branches),
    unavailableBranches: parseCategoryIds(req.body.unavailableBranches),
    branchPrices,
    sellWithoutStock: parseBoolean(req.body.sellWithoutStock, true),
    stock: parseBoolean(req.body.sellWithoutStock, true) ? 0 : Number(req.body.stock || 0),
    images: imagePayload,
  });

  res.status(201).json(product);
}

export async function updateProduct(req: Request, res: Response) {
  const branchPrices = parseJsonArray<{ branch: string; price: number }>(req.body.branchPrices, []);
  const iva = await resolveIva(req.body);
  const updateData: Record<string, unknown> = {
    ...req.body,
    code: parseInternalCode(req.body.code),
    ...iva,
    slug: req.body.slug || slugify(req.body.name),
    categories: parseCategoryIds(req.body.categories),
    branches: parseCategoryIds(req.body.branches),
    unavailableBranches: parseCategoryIds(req.body.unavailableBranches),
    branchPrices,
    sellWithoutStock: parseBoolean(req.body.sellWithoutStock, false),
    stock: parseBoolean(req.body.sellWithoutStock, false) ? 0 : Number(req.body.stock || 0),
  };

  if (req.body.images !== undefined) {
    updateData.images = parseJsonArray<{ url: string; publicId: string }>(req.body.images, []);
  }

  const product = await Product.findByIdAndUpdate(
    req.params.id,
    updateData,
    { new: true }
  );

  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  res.json(product);
}

/**
 * Resuelve sobre qué sucursal opera el usuario:
 *  - admin general: la que venga en query/body (branchId), obligatoria.
 *  - admin de sucursal (branch_admin): SIEMPRE su propia sucursal; si pide otra, 403.
 * Devuelve { branchId } o { error, status }.
 */
function resolveBranchForUser(req: AuthRequest, requested?: string): { branchId?: string; error?: string; status?: number } {
  const user = req.user;
  if (!user) return { error: "No autenticado", status: 401 };
  const own = (user.branches || []).map((b) => String(b));
  if (user.allBranches || user.accountType === "admin") {
    if (!requested) return { error: "Falta branchId de la sucursal", status: 400 };
    return { branchId: String(requested) };
  }
  // branch_admin: su propia sucursal
  if (!own.length) return { error: "Tu usuario no tiene sucursal asignada", status: 400 };
  if (requested && !own.includes(String(requested))) return { error: "Solo puedes gestionar tu sucursal", status: 403 };
  return { branchId: requested ? String(requested) : own[0] };
}

/** Un producto está disponible en una sucursal si no está en unavailableBranches y (branches vacío o incluye la sucursal). */
function isAvailableAt(product: { isAvailable?: boolean; branches?: unknown[]; unavailableBranches?: unknown[] }, branchId: string) {
  if (product.isAvailable === false) return false;
  const unavailable = (product.unavailableBranches || []).map((b: unknown) => String((b as { _id?: unknown })?._id ?? b));
  if (unavailable.includes(branchId)) return false;
  const limited = (product.branches || []).map((b: unknown) => String((b as { _id?: unknown })?._id ?? b));
  if (limited.length && !limited.includes(branchId)) return false;
  return true;
}

/**
 * Lista de productos con su disponibilidad para UNA sucursal. La usa el vendedor
 * (branch_admin) para ver y togglear lo de su local, y el admin para cualquier sucursal.
 */
export async function listBranchAvailability(req: AuthRequest, res: Response) {
  const resolved = resolveBranchForUser(req, req.query.branchId as string | undefined);
  if (resolved.error) {
    res.status(resolved.status || 400).json({ message: resolved.error });
    return;
  }
  const branchId = resolved.branchId!;
  const search = String(req.query.search || "").trim();
  const filter: Record<string, unknown> = {};
  if (search) {
    const rx = new RegExp(escapeRegExp(search), "i");
    filter.$or = [{ name: rx }, { code: rx }];
  }
  const products = await Product.find(filter)
    .select("name price code images categories branches unavailableBranches isAvailable sortOrder")
    .populate("categories", "name")
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  const items = products.map((p: Record<string, unknown>) => ({
    _id: p._id,
    name: p.name,
    price: p.price,
    image: (p.images as Array<{ url?: string }> | undefined)?.[0]?.url || "",
    category: (p.categories as Array<{ name?: string }> | undefined)?.[0]?.name || "",
    available: isAvailableAt(p as { isAvailable?: boolean; branches?: unknown[]; unavailableBranches?: unknown[] }, branchId),
    globallyOff: p.isAvailable === false,
  }));
  const availableCount = items.filter((i) => i.available).length;
  res.json({ branchId, products: items, summary: { total: items.length, available: availableCount, unavailable: items.length - availableCount } });
}

/** Activa/desactiva un producto para una sucursal (toggle de unavailableBranches). */
export async function toggleBranchAvailability(req: AuthRequest, res: Response) {
  const resolved = resolveBranchForUser(req, req.body.branchId);
  if (resolved.error) {
    res.status(resolved.status || 400).json({ message: resolved.error });
    return;
  }
  const branchId = resolved.branchId!;
  const available = req.body.available === true || req.body.available === "true";

  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404).json({ message: "Producto no encontrado" });
    return;
  }

  const unavailable = (product.unavailableBranches || []).map((b: unknown) => String(b));
  if (available) {
    // Disponible: quitar de unavailableBranches y, si usa lista blanca legacy, incluir la sucursal.
    product.unavailableBranches = product.unavailableBranches.filter((b: unknown) => String(b) !== branchId) as typeof product.unavailableBranches;
    if (product.branches?.length && !product.branches.map((b: unknown) => String(b)).includes(branchId)) {
      product.branches.push(branchId as never);
    }
  } else if (!unavailable.includes(branchId)) {
    product.unavailableBranches.push(branchId as never);
  }
  await product.save();
  res.json({ _id: product._id, name: product.name, branchId, available });
}

export async function deleteProduct(req: Request, res: Response) {
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  // La limpieza de imágenes no debe bloquear el borrado: si Cloudinary falla (id
  // inválido, imagen sembrada, red), igual se elimina el producto del catálogo.
  await Promise.all(
    product.images.map((image: { publicId: string }) =>
      deleteFromCloudinary(image.publicId).catch(() => undefined)
    )
  );
  await Product.findByIdAndDelete(req.params.id);
  res.json({ message: "Product deleted" });
}

export async function deleteProductImage(req: Request, res: Response) {
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  const image = product.images.find((item: { publicId: string }) => item.publicId === req.params.publicId);
  if (!image) {
    res.status(404).json({ message: "Image not found" });
    return;
  }

  product.images = product.images.filter((item: { publicId: string }) => item.publicId !== req.params.publicId);
  await product.save();
  await deleteFromCloudinary(String(req.params.publicId));
  res.json(product);
}

export async function uploadProductImage(req: Request, res: Response) {
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404).json({ message: "Product not found" });
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

  const replacingPrimary = req.query.replace === "true";
  const previousImages = replacingPrimary ? [...product.images] : [];
  const result = await uploadToCloudinary(file.buffer, `boloncity/products/${product.slug}`);
  const uploadedImage = { url: result.secure_url, publicId: result.public_id };

  product.images = replacingPrimary ? [uploadedImage] : [...product.images, uploadedImage];
  await product.save();

  if (replacingPrimary) {
    await Promise.all(previousImages.map((image: { publicId: string }) => deleteFromCloudinary(image.publicId)));
  }

  res.status(201).json(product);
}
