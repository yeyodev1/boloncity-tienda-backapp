import mongoose, { Schema, Types } from "mongoose";
import { slugify } from "../utils/slugify";

export interface ICategory {
  name: string;
  slug: string;
  description?: string;
  image?: {
    url: string;
    publicId: string;
  };
  icon?: string;
  color?: string;
  sortOrder: number;
  isActive: boolean;
  parentCategory?: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const categorySchema = new Schema<ICategory>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: "" },
    image: {
      url: { type: String, default: "" },
      publicId: { type: String, default: "" },
    },
    icon: { type: String, default: "" },
    color: { type: String, default: "" },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    parentCategory: { type: Schema.Types.ObjectId, ref: "Category", default: null },
  },
  { timestamps: true }
);

categorySchema.pre("validate", function (next) {
  if (!this.slug && this.name) {
    this.slug = slugify(this.name);
  }
  next();
});

export const Category = mongoose.models.Category || mongoose.model<ICategory>("Category", categorySchema);
