import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { dbConnect } from "../config/mongo";
import { Product } from "../models/Product";
import { isCloudinaryConfigured, uploadToCloudinary } from "../services/cloudinary.service";
import { slugify } from "../utils/slugify";

const SOURCE_API = "https://api.mie-commerce.com/front/categorias/productos-low/30";
const SOURCE_CONFIG = "https://boloncity.com/config.js";
const REPORT_PATH = path.resolve(process.cwd(), "scripts/product-image-import-report.json");
const applyChanges = process.argv.includes("--apply");

interface SourceProduct {
  cod_producto: string;
  nombre: string;
  image_max: string;
}

interface SourceCategory {
  categoria: string;
  productos: SourceProduct[];
}

interface SourceResponse {
  data: SourceCategory[];
}

const ignoredWords = new Set(["a", "al", "con", "de", "del", "el", "en", "la", "las", "los", "por", "unidad", "x2"]);
const massWords = new Set(["maduro", "pinton", "verde"]);
const protectedQualifiers = new Set(["agrandar", "combo", "congelado", "congelados", "mega", "medio", "mini", "promo", "promocion"]);

function words(value: string, removeMass = false) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bporciones?\b/g, "porcion")
    .replace(/\bhuevos\b/g, "huevo")
    .replace(/\bcafe\b/g, "cafe")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word && !ignoredWords.has(word) && (!removeMass || !massWords.has(word)));
}

function matchScore(productName: string, sourceName: string) {
  const target = words(productName, true);
  const source = words(sourceName, true);
  const targetSet = new Set(target);
  const sourceSet = new Set(source);

  if ([...protectedQualifiers].some((word) => targetSet.has(word) !== sourceSet.has(word))) return 0;

  const intersection = source.filter((word) => targetSet.has(word)).length;
  const union = new Set([...target, ...source]).size;
  const containment = intersection / Math.max(source.length, target.length, 1);
  const jaccard = intersection / Math.max(union, 1);

  return containment * 0.7 + jaccard * 0.3;
}

function sourceApiKey(config: string) {
  const match = config.match(/VITE_API_KEY:\s*["']([^"']+)["']/);
  if (!match) throw new Error("Could not read the public Boloncity source API key");
  return match[1];
}

async function fetchSourceProducts() {
  const configResponse = await fetch(SOURCE_CONFIG);
  if (!configResponse.ok) throw new Error(`Source config failed with ${configResponse.status}`);

  const response = await fetch(SOURCE_API, {
    headers: { "Api-Key": sourceApiKey(await configResponse.text()) },
  });
  if (!response.ok) throw new Error(`Source catalog failed with ${response.status}`);

  const payload = (await response.json()) as SourceResponse;
  const unique = new Map<string, SourceProduct>();
  payload.data.forEach((category) => {
    category.productos.forEach((product) => {
      if (product.image_max) unique.set(product.cod_producto, product);
    });
  });
  return [...unique.values()];
}

async function downloadImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image download failed with ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  await dbConnect();
  const [products, sourceProducts] = await Promise.all([
    Product.find().sort({ sortOrder: 1 }).exec(),
    fetchSourceProducts(),
  ]);

  const report = [];
  let imported = 0;

  for (const product of products) {
    const ranked = sourceProducts
      .map((source) => ({ source, score: matchScore(product.name, source.nombre) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    const second = ranked[1];
    const confident = !!best && best.score >= 0.82 && best.score - (second?.score || 0) >= 0.08;

    if (!confident) {
      report.push({ code: product.code, product: product.name, status: "unmatched", suggestion: best?.source.nombre || null, score: Number((best?.score || 0).toFixed(3)) });
      continue;
    }

    if (product.images.length > 0) {
      report.push({ code: product.code, product: product.name, status: "skipped-existing", source: best.source.nombre, score: Number(best.score.toFixed(3)) });
      continue;
    }

    if (applyChanges) {
      const buffer = await downloadImage(best.source.image_max);
      const upload = await uploadToCloudinary(buffer, "boloncity/products/imported", `${slugify(product.name)}-${product.code}`);
      product.images = [{ url: upload.secure_url, publicId: upload.public_id }];
      product.tags = [...new Set([...product.tags, `image-source:${best.source.cod_producto}`])];
      await product.save();
      imported += 1;
    }

    report.push({ code: product.code, product: product.name, status: applyChanges ? "imported" : "matched-dry-run", source: best.source.nombre, sourceUrl: best.source.image_max, score: Number(best.score.toFixed(3)) });
  }

  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const matched = report.filter((item) => item.status !== "unmatched").length;
  console.log(JSON.stringify({ mode: applyChanges ? "apply" : "dry-run", products: products.length, sourceProducts: sourceProducts.length, matched, imported, unmatched: products.length - matched, report: REPORT_PATH }, null, 2));
  process.exit(0);
}

if (applyChanges && !isCloudinaryConfigured()) {
  throw new Error("Cloudinary is not configured");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
