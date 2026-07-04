import { Request, Response } from "express";
import { Category } from "../models/Category";
import { Product } from "../models/Product";
import { slugify } from "../utils/slugify";

export async function listCategories(_req: Request, res: Response) {
  const categories = await Category.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
  const counts = (await Product.aggregate([
    { $unwind: { path: "$categories", preserveNullAndEmptyArrays: true } },
    { $group: { _id: "$categories", count: { $sum: 1 } } },
  ])) as Array<{ _id: string; count: number }>;

  const countMap = new Map(counts.map((item) => [String(item._id), item.count]));
  res.json(categories.map((category) => ({ ...category, productsCount: countMap.get(String((category as any)._id)) || 0 })));
}

export async function getCategoryBySlug(req: Request, res: Response) {
  const category = await Category.findOne({ slug: req.params.slug }).lean();
  if (!category) {
    res.status(404).json({ message: "Category not found" });
    return;
  }

  const products = await Product.find({ categories: (category as any)._id, isAvailable: true }).populate("categories");
  res.json({ category, products });
}

export async function createCategory(req: Request, res: Response) {
  const category = await Category.create({
    ...req.body,
    slug: req.body.slug || slugify(req.body.name),
    parentCategory: req.body.parentCategory || null,
  });
  res.status(201).json(category);
}

export async function updateCategory(req: Request, res: Response) {
  const category = await Category.findByIdAndUpdate(
    req.params.id,
    {
      ...req.body,
      slug: req.body.slug || slugify(req.body.name),
      parentCategory: req.body.parentCategory || null,
    },
    { new: true }
  );

  if (!category) {
    res.status(404).json({ message: "Category not found" });
    return;
  }

  res.json(category);
}

export async function deleteCategory(req: Request, res: Response) {
  const category = await Category.findByIdAndDelete(req.params.id);
  if (!category) {
    res.status(404).json({ message: "Category not found" });
    return;
  }

  await Product.updateMany({ categories: (category as any)._id }, { $pull: { categories: (category as any)._id } });
  res.json({ message: "Category deleted" });
}

export async function reorderCategories(req: Request, res: Response) {
  const { ids } = req.body as { ids: string[] };
  await Promise.all(ids.map((id, index) => Category.findByIdAndUpdate(id, { sortOrder: index })));
  res.json({ message: "Categories reordered" });
}
