import "dotenv/config";
import { dbConnect } from "../config/mongo";
import { Branch } from "../models/Branch";
import { Category } from "../models/Category";
import { Product } from "../models/Product";
import { User } from "../models/User";

async function main() {
  await dbConnect();

  const admin = await User.findOne({ email: "dreyes@bakano.ec" });
  if (!admin) {
    await User.create({
      email: "dreyes@bakano.ec",
      password: "123456789",
      accountType: "admin",
      allBranches: true,
      branches: [],
      isActive: true,
    });
  } else {
    admin.password = "123456789";
    admin.accountType = "admin";
    admin.allBranches = true;
    admin.branches = [];
    admin.isActive = true;
    await admin.save();
  }

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

  const category = await Category.findOneAndUpdate(
    { slug: "bolones-clasicos" },
    { name: "Bolones Clasicos", slug: "bolones-clasicos", sortOrder: 1, isActive: true },
    { upsert: true, new: true }
  );

  const existing = await Product.findOne({ code: "1" });
  if (!existing && category) {
    await Product.create({
      code: "1",
      name: "Bolon Queso Verde",
      slug: "bolon-queso-verde",
      description: "Producto inicial de ejemplo.",
      categories: [category._id],
      branches: branch ? [branch._id] : [],
      branchPrices: [],
      price: 3.52,
      cost: 0,
      hasIva: false,
      ivaRate: 15,
      images: [],
      isAvailable: true,
      isFeatured: true,
      stock: -1,
      pointsValue: 3,
      sortOrder: 1,
      tags: ["seed"],
    });
  }

  console.log("Seed completed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
