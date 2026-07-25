import mongoose, { Schema, Types } from "mongoose";
import { slugify } from "../utils/slugify";

export interface IProductImage {
  url: string;
  publicId: string;
}

export interface IProduct {
  code?: string;
  name: string;
  slug: string;
  description?: string;
  categories: Types.ObjectId[];
  branches: Types.ObjectId[];
  unavailableBranches: Types.ObjectId[];
  branchPrices: Array<{ branch: Types.ObjectId; price: number }>;
  price: number;
  cost?: number;
  hasIva: boolean;
  ivaRate: number;
  images: IProductImage[];
  isAvailable: boolean;
  isFeatured: boolean;
  stock: number;
  sellWithoutStock: boolean;
  pointsValue?: number | null;
  scheduledActivation?: Date | null;
  scheduledDeactivation?: Date | null;
  sortOrder: number;
  isBestSeller: boolean;
  tags: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

const productSchema = new Schema<IProduct>(
  {
    code: { type: String, trim: true, unique: true, sparse: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: "" },
    categories: [{ type: Schema.Types.ObjectId, ref: "Category" }],
    branches: [{ type: Schema.Types.ObjectId, ref: "Branch" }],
    unavailableBranches: [{ type: Schema.Types.ObjectId, ref: "Branch" }],
    branchPrices: [
      {
        branch: { type: Schema.Types.ObjectId, ref: "Branch" },
        price: { type: Number, required: true },
      },
    ],
    price: { type: Number, required: true },
    cost: { type: Number, default: 0 },
    hasIva: { type: Boolean, default: false },
    ivaRate: { type: Number, default: 0 },
    images: [
      {
        url: { type: String, default: "" },
        publicId: { type: String, default: "" },
      },
    ],
    isAvailable: { type: Boolean, default: true },
    isFeatured: { type: Boolean, default: false },
    stock: { type: Number, default: 0 },
    sellWithoutStock: { type: Boolean, default: true },
    pointsValue: { type: Number, default: null, min: 0 },
    scheduledActivation: { type: Date, default: null },
    scheduledDeactivation: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
    isBestSeller: { type: Boolean, default: false },
    tags: [{ type: String }],
  },
  { timestamps: true }
);

productSchema.pre("validate", function (next) {
  if (!this.slug && this.name) {
    this.slug = slugify(this.name);
  }
  next();
});

export const Product = mongoose.models.Product || mongoose.model<IProduct>("Product", productSchema);
