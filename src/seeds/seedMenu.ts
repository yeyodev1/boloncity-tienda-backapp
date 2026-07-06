import "dotenv/config";
import { dbConnect } from "../config/mongo";
import { Branch } from "../models/Branch";
import { Category } from "../models/Category";
import { Product } from "../models/Product";
import { slugify } from "../utils/slugify";
import { menuSeedItems } from "./menuItems";

const categoryColors: Record<string, string> = {
  COCINA: "#235931",
  BEBIDAS: "#1b4d7e",
  CAJA: "#efd537",
  GENERAL: "#6b7280",
};

const categoryIcons: Record<string, string> = {
  COCINA: "fa-solid fa-utensils",
  BEBIDAS: "fa-solid fa-mug-hot",
  CAJA: "fa-solid fa-cash-register",
  GENERAL: "fa-solid fa-store",
};

const duplicateCount = new Map<string, number>();

function uniqueSeedCode(code: string, sourceId: string) {
  const normalized = code || sourceId;
  const count = duplicateCount.get(normalized) || 0;
  duplicateCount.set(normalized, count + 1);
  return count === 0 ? normalized : `${normalized}-${sourceId}`;
}

async function upsertCategory(name: string, sortOrder: number, parentCategory: unknown = null) {
  const slug = slugify(name);
  return Category.findOneAndUpdate(
    { slug },
    {
      name,
      slug,
      description: parentCategory ? `Subcategoria operativa ${name}` : `Categoria principal ${name}`,
      icon: parentCategory ? "fa-solid fa-tag" : categoryIcons[name] || categoryIcons.GENERAL,
      color: parentCategory ? "#235931" : categoryColors[name] || categoryColors.GENERAL,
      sortOrder,
      isActive: true,
      parentCategory,
    },
    { upsert: true, new: true }
  );
}

async function main() {
  await dbConnect();

  const branch = await Branch.findOneAndUpdate(
    { slug: "sucursal-principal" },
    {
      name: "Sucursal Principal",
      slug: "sucursal-principal",
      address: "Boloncity",
      city: "Quito",
      googleMapsUrl: "",
      coordinates: null,
      isActive: true,
    },
    { upsert: true, new: true }
  );

  const areas = Array.from(new Set(menuSeedItems.map((item) => item.area)));
  const parentByName = new Map<string, Awaited<ReturnType<typeof upsertCategory>>>();

  for (const [index, area] of areas.entries()) {
    parentByName.set(area, await upsertCategory(area, index + 1));
  }

  const lineKey = (item: { area: string; line: string }) => `${item.area}:${item.line}`;
  const lines = Array.from(new Map(menuSeedItems.map((item) => [lineKey(item), item])).values());
  const lineByKey = new Map<string, Awaited<ReturnType<typeof upsertCategory>>>();

  for (const [index, item] of lines.entries()) {
    lineByKey.set(lineKey(item), await upsertCategory(item.line, 100 + index, parentByName.get(item.area)?._id || null));
  }

  let updated = 0;

  for (const [index, item] of menuSeedItems.entries()) {
    const code = uniqueSeedCode(item.code, item.sourceId);
    const parent = parentByName.get(item.area);
    const line = lineByKey.get(lineKey(item));
    const categoryIds = [parent?._id, line?._id].filter(Boolean);
    const productSlug = slugify(`${item.name}-${code}`);

    await Product.findOneAndUpdate(
      { code },
      {
        code,
        name: item.name,
        slug: productSlug,
        description: `${item.line} · ${item.area}`,
        categories: categoryIds,
        branches: branch ? [branch._id] : [],
        branchPrices: [],
        price: item.price,
        cost: 0,
        hasIva: true,
        ivaRate: 15,
        images: [],
        isAvailable: true,
        isFeatured: ["BOLONES CLASICOS", "BOLONES ESPECIALES", "TIGRILLOS CLASICOS", "ESPECIALES", "COMBOS"].includes(item.line),
        stock: -1,
        pointsValue: Math.max(0, Math.round(item.price)),
        sortOrder: index + 1,
        tags: [item.area, item.line, `source:${item.sourceId}`],
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    updated += 1;
  }

  console.log(`Menu seed completed: ${updated} products, ${areas.length} parent categories, ${lines.length} line categories.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
