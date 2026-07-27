import mongoose, { Schema, Types } from "mongoose";

export interface IWhatsAppSession {
  phone: string;
  history: Array<{ role: "user" | "assistant"; content: string; createdAt: Date }>;
  data: {
    customerName?: string;
    customerEmail?: string;
    deliveryType?: "delivery" | "pickup";
    deliveryAddress?: string;
    deliveryGoogleMapsUrl?: string;
    deliveryCoordinates?: { lat: number; lng: number };
    branch?: Types.ObjectId;
    paymentMethod?: "card" | "cash";
    billingPreference?: "final_consumer" | "invoice";
    billingName?: string;
    billingDocNumber?: string;
    billingEmail?: string;
    billingAddress?: string;
    items?: Array<{ product: Types.ObjectId; quantity: number }>;
  };
  lastMessageHash?: string;
  lastMessageAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const sessionSchema = new Schema<IWhatsAppSession>(
  {
    phone: { type: String, required: true, unique: true, index: true },
    history: [{
      role: { type: String, enum: ["user", "assistant"], required: true },
      content: { type: String, required: true },
      createdAt: { type: Date, default: Date.now },
    }],
    data: {
      customerName: String,
      customerEmail: String,
      deliveryType: { type: String, enum: ["delivery", "pickup"] },
      deliveryAddress: String,
      deliveryGoogleMapsUrl: String,
      deliveryCoordinates: { lat: Number, lng: Number },
      branch: { type: Schema.Types.ObjectId, ref: "Branch" },
      paymentMethod: { type: String, enum: ["card", "cash"] },
      billingPreference: { type: String, enum: ["final_consumer", "invoice"] },
      billingName: String,
      billingDocNumber: String,
      billingEmail: String,
      billingAddress: String,
      items: [{
        product: { type: Schema.Types.ObjectId, ref: "Product" },
        quantity: Number,
      }],
    },
    lastMessageHash: String,
    lastMessageAt: Date,
  },
  { timestamps: true }
);

sessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

export const WhatsAppSession = mongoose.models.WhatsAppSession || mongoose.model<IWhatsAppSession>("WhatsAppSession", sessionSchema);
