import mongoose, { Schema, Types } from "mongoose";

export interface IOrderItem {
  product: Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
  image?: string;
}

export interface IPayphoneData {
  clientTransactionId?: string;
  transactionId?: number;
  authorizationCode?: string;
  statusCode?: number;
  cardBrand?: string;
  lastDigits?: string;
  confirmedAt?: Date;
}

export interface IOrderAudit {
  action: "created" | "status_change" | "payment_confirmed" | "user_assigned" | "note_added" | "branch_assigned";
  performedBy?: Types.ObjectId | null;
  performedByEmail?: string;
  fromValue?: string;
  toValue?: string;
  details?: string;
  timestamp: Date;
}

export interface IPickerData {
  bookingId: string;
  bookingNumericId: number;
  statusText: string;
  smrURL: string;
  bookingDetailUrl: string;
  createdAt?: Date;
}

export interface IBillingData {
  docType: string;
  name: string;
  docNumber: string;
  email: string;
  address: string;
}

export interface IOrder {
  orderNumber: string;
  user?: Types.ObjectId | null;
  branch?: Types.ObjectId | null;
  items: IOrderItem[];
  subtotal: number;
  tax: number;
  total: number;
  deliveryType: "delivery" | "pickup";
  deliveryCost: number;
  deliveryDistance: number;
  deliveryAddress: string;
  deliveryGoogleMapsUrl: string;
  deliveryCoordinates?: { lat: number; lng: number } | null;
  status: "pending" | "paid" | "preparing" | "ready" | "delivered" | "cancelled";
  payphone: IPayphoneData;
  picker?: IPickerData;
  billing?: IBillingData;
  pointsEarned: number;
  pointsRedeemed: number;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  audit: IOrderAudit[];
  createdAt?: Date;
  updatedAt?: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    image: { type: String, default: "" },
  },
  { _id: false }
);

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },
    items: { type: [orderItemSchema], required: true },
    subtotal: { type: Number, required: true },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "paid", "preparing", "ready", "delivered", "cancelled"],
      default: "pending",
    },
    payphone: {
      clientTransactionId: { type: String, default: "" },
      transactionId: { type: Number, default: null },
      authorizationCode: { type: String, default: "" },
      statusCode: { type: Number, default: null },
      cardBrand: { type: String, default: "" },
      lastDigits: { type: String, default: "" },
      confirmedAt: { type: Date, default: null },
    },
    deliveryType: { type: String, enum: ["delivery", "pickup"], default: "delivery" },
    deliveryCost: { type: Number, default: 0 },
    deliveryDistance: { type: Number, default: 0 },
    deliveryAddress: { type: String, default: "" },
    deliveryGoogleMapsUrl: { type: String, default: "" },
    deliveryCoordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    picker: {
      bookingId: { type: String, default: "" },
      bookingNumericId: { type: Number, default: null },
      statusText: { type: String, default: "" },
      smrURL: { type: String, default: "" },
      bookingDetailUrl: { type: String, default: "" },
      createdAt: { type: Date, default: null },
    },
    billing: {
      docType: { type: String, default: "" },
      name: { type: String, default: "" },
      docNumber: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: String, default: "" },
    },
    pointsEarned: { type: Number, default: 0 },
    pointsRedeemed: { type: Number, default: 0 },
    customerEmail: { type: String, required: true },
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    notes: { type: String, default: "" },
    audit: [
      {
        action: { type: String, required: true },
        performedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        performedByEmail: { type: String, default: "" },
        fromValue: { type: String, default: "" },
        toValue: { type: String, default: "" },
        details: { type: String, default: "" },
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export const Order = mongoose.models.Order || mongoose.model<IOrder>("Order", orderSchema);
