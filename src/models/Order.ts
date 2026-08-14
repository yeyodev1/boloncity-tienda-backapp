import mongoose, { Schema, Types } from "mongoose";

export interface IOrderItem {
  product: Types.ObjectId;
  name: string;
  price: number;
  quantity: number;
  image?: string;
  pointsValue: number;
}

/** Reverso de PayPhone. Solo total: la API no admite reversos parciales. */
export interface IPayphoneRefund {
  status: "none" | "processing" | "refunded" | "failed";
  amount?: number;
  reason?: string;
  requestedBy?: Types.ObjectId | null;
  requestedByEmail?: string;
  requestedAt?: Date;
  refundedAt?: Date;
  errorCode?: number;
  errorMessage?: string;
}

export interface IPayphoneData {
  clientTransactionId?: string;
  /** Tienda de PayPhone de la sucursal que cobro este pedido. */
  storeId?: string;
  transactionId?: number;
  authorizationCode?: string;
  statusCode?: number;
  cardBrand?: string;
  lastDigits?: string;
  confirmedAt?: Date;
  refund?: IPayphoneRefund;
}

export interface IOrderAudit {
  action: "created" | "status_change" | "payment_confirmed" | "user_assigned" | "note_added" | "branch_assigned" | "refund_requested" | "refunded" | "refund_failed";
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
  currentStatus?: string;
  driverName?: string;
  driverPhone?: string;
  driverVehicle?: string;
  driverPhoto?: string;
  validationCode?: string;
  proofOfDelivery?: string;
  deliveryFee?: number;
  searchState?: "on_hold" | "started" | "failed";
  searchStartedAt?: Date;
  searchResult?: Record<string, unknown>;
  searchError?: string;
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
  paymentMethod: "card" | "cash";
  deliveryType: "delivery" | "pickup";
  deliveryCost: number;
  deliveryDistance: number;
  deliveryAddress: string;
  deliveryGoogleMapsUrl: string;
  deliveryCoordinates?: { lat: number; lng: number } | null;
  scheduledFor?: Date;
  status: "pending" | "paid" | "preparing" | "awaiting_pickup" | "ready" | "delivered" | "cancelled";
  payphone: IPayphoneData;
  source: "web" | "whatsapp";
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
    pointsValue: { type: Number, default: 0 },
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
    paymentMethod: { type: String, enum: ["card", "cash"], default: "card" },
    status: {
      type: String,
      enum: ["pending", "paid", "preparing", "awaiting_pickup", "ready", "delivered", "cancelled"],
      default: "pending",
    },
    payphone: {
      clientTransactionId: { type: String, default: "" },
      storeId: { type: String, default: "" },
      transactionId: { type: Number, default: null },
      authorizationCode: { type: String, default: "" },
      statusCode: { type: Number, default: null },
      cardBrand: { type: String, default: "" },
      lastDigits: { type: String, default: "" },
      confirmedAt: { type: Date, default: null },
      refund: {
        status: { type: String, enum: ["none", "processing", "refunded", "failed"], default: "none" },
        amount: { type: Number, default: 0 },
        reason: { type: String, default: "" },
        requestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        requestedByEmail: { type: String, default: "" },
        requestedAt: { type: Date, default: null },
        refundedAt: { type: Date, default: null },
        errorCode: { type: Number, default: null },
        errorMessage: { type: String, default: "" },
      },
    },
    source: { type: String, enum: ["web", "whatsapp"], default: "web", index: true },
    deliveryType: { type: String, enum: ["delivery", "pickup"], default: "delivery" },
    deliveryCost: { type: Number, default: 0 },
    deliveryDistance: { type: Number, default: 0 },
    deliveryAddress: { type: String, default: "" },
    deliveryGoogleMapsUrl: { type: String, default: "" },
    deliveryCoordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    scheduledFor: { type: Date, default: null },
    picker: {
      bookingId: { type: String, default: "" },
      bookingNumericId: { type: Number, default: null },
      statusText: { type: String, default: "" },
      smrURL: { type: String, default: "" },
      bookingDetailUrl: { type: String, default: "" },
      createdAt: { type: Date, default: null },
      currentStatus: { type: String, default: "" },
      driverName: { type: String, default: "" },
      driverPhone: { type: String, default: "" },
      driverVehicle: { type: String, default: "" },
      driverPhoto: { type: String, default: "" },
      validationCode: { type: String, default: "" },
      proofOfDelivery: { type: String, default: "" },
      deliveryFee: { type: Number, default: 0 },
      searchState: { type: String, enum: ["on_hold", "started", "failed"], default: null },
      searchStartedAt: { type: Date, default: null },
      searchResult: { type: Schema.Types.Mixed, default: null },
      searchError: { type: String, default: "" },
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

orderSchema.index({ branch: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });

export const Order = mongoose.models.Order || mongoose.model<IOrder>("Order", orderSchema);
