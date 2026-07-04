import { Request, Response } from "express";
import { Product } from "../models/Product";
import { Category } from "../models/Category";
import { deleteFromCloudinary, isCloudinaryConfigured, uploadToCloudinary } from "../services/cloudinary.service";
import { slugify } from "../utils/slugify";

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

export async function listProducts(req: Request, res: Response) {
  const { category, q, available } = req.query;
  const filter: Record<string, unknown> = {};
  const queryParts: Array<Record<string, unknown>> = [];

  if (category) {
    const categoryDoc = await Category.findOne({ slug: category }).lean();
    if (categoryDoc) filter.categories = (categoryDoc as any)._id;
  }
  if (typeof q === "string" && q.trim()) {
    queryParts.push({
      $or: [{ name: new RegExp(q, "i") }, { code: new RegExp(q, "i") }, { description: new RegExp(q, "i") }],
    });
  }
  if (available === "true") filter.isAvailable = true;
  const branchFilter = (req as Request & { branchFilter?: Record<string, unknown> }).branchFilter;
  if (branchFilter?.branch) {
    queryParts.push({ $or: [{ branches: { $size: 0 } }, { branches: branchFilter.branch }] });
  }

  if (queryParts.length === 1) {
    Object.assign(filter, queryParts[0]);
  } else if (queryParts.length > 1) {
    filter.$and = queryParts;
  }

  const products = await Product.find(filter).populate("categories").populate("branches").sort({ sortOrder: 1, createdAt: -1 });
  res.json(products);
}

export async function getProductBySlug(req: Request, res: Response) {
  const branchFilter = (req as Request & { branchFilter?: Record<string, unknown> }).branchFilter;
  const product = await Product.findOne({
    slug: req.params.slug,
    ...(branchFilter?.branch ? { $or: [{ branches: { $size: 0 } }, { branches: branchFilter.branch }] } : {}),
  }).populate("categories").populate("branches");
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  res.json(product);
}

export async function createProduct(req: Request, res: Response) {
  const imagePayload = parseJsonArray<{ url: string; publicId: string }>(req.body.images, []);
  const branchPrices = parseJsonArray<{ branch: string; price: number }>(req.body.branchPrices, []);
  const product = await Product.create({
    ...req.body,
    slug: req.body.slug || slugify(req.body.name),
    categories: parseCategoryIds(req.body.categories),
    branches: parseCategoryIds(req.body.branches),
    branchPrices,
    images: imagePayload,
  });

  res.status(201).json(product);
}

export async function updateProduct(req: Request, res: Response) {
  const imagePayload = parseJsonArray<{ url: string; publicId: string }>(req.body.images, []);
  const branchPrices = parseJsonArray<{ branch: string; price: number }>(req.body.branchPrices, []);
  const product = await Product.findByIdAndUpdate(
    req.params.id,
    {
      ...req.body,
      slug: req.body.slug || slugify(req.body.name),
      categories: parseCategoryIds(req.body.categories),
      branches: parseCategoryIds(req.body.branches),
      branchPrices,
      ...(imagePayload ? { images: imagePayload } : {}),
    },
    { new: true }
  );

  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  res.json(product);
}

export async function deleteProduct(req: Request, res: Response) {
  const product = await Product.findById(req.params.id);
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  await Promise.all(product.images.map((image: { publicId: string }) => deleteFromCloudinary(image.publicId)));
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

  const result = await uploadToCloudinary(file.buffer, `boloncity/products/${product.slug}`);
  product.images.push({ url: result.secure_url, publicId: result.public_id });
  await product.save();
  res.status(201).json(product);
}
