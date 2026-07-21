import mongoose, { Schema } from "mongoose";

export interface ISetting {
  deliveryPricePerKm: number;
  createdAt?: Date;
  updatedAt?: Date;
}

const settingSchema = new Schema<ISetting>(
  {
    deliveryPricePerKm: { type: Number, required: true, default: 150 },
  },
  { timestamps: true }
);

export const Setting = mongoose.models.Setting || mongoose.model<ISetting>("Setting", settingSchema);
