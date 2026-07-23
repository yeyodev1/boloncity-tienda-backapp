import bcrypt from "bcryptjs";
import mongoose, { Schema } from "mongoose";

export interface IPointsHistory {
  amount: number;
  reason: string;
  orderId?: Schema.Types.ObjectId | null;
  date: Date;
}

export interface IUser {
  email: string;
  password: string;
  name?: string;
  phone?: string;
  documentId?: string;
  accountType: "customer" | "branch_admin" | "admin";
  branches: Schema.Types.ObjectId[];
  allBranches: boolean;
  points: number;
  pointsHistory: IPointsHistory[];
  isActive: boolean;
  resetPasswordToken?: string | null;
  resetPasswordExpires?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const pointsHistorySchema = new Schema<IPointsHistory>(
  {
    amount: { type: Number, required: true },
    reason: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    date: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    name: { type: String, default: "" },
    phone: { type: String, default: "" },
    documentId: { type: String, default: "" },
    accountType: { type: String, enum: ["customer", "branch_admin", "admin"], default: "customer" },
    branches: [{ type: Schema.Types.ObjectId, ref: "Branch" }],
    allBranches: { type: Boolean, default: false },
    points: { type: Number, default: 0 },
    pointsHistory: { type: [pointsHistorySchema], default: [] },
    isActive: { type: Boolean, default: true },
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) {
    next();
    return;
  }

  this.password = await bcrypt.hash(this.password, 10);
  next();
});

export const User = mongoose.models.User || mongoose.model<IUser>("User", userSchema);
