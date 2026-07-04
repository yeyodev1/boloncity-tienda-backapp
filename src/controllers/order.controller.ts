import { Request, Response } from "express";
import { Order } from "../models/Order";
import { Product } from "../models/Product";
import { confirmPayphoneTransaction } from "../services/payphone.service";
import { createAutoUser } from "../services/auth.service";
import { sendEmail } from "../services/resend.service";
import { User } from "../models/User";
import { calculatePoints } from "../services/points.service";
import { Branch } from "../models/Branch";
import { distanceKm } from "../utils/haversine";
import { AuthRequest } from "../types/AuthRequest";

function centsToDollars(value: number) {
  return value / 100;
}

function pushAudit(order: any, entry: Record<string, unknown>) {
  order.audit = order.audit || [];
  order.audit.push({
    timestamp: new Date(),
    ...entry,
  });
}

async function resolveBranch(input: { branchId?: string; lat?: number; lng?: number }) {
  if (input.branchId) {
    return Branch.findById(input.branchId);
  }

  if (typeof input.lat === "number" && typeof input.lng === "number") {
    const branches = await Branch.find({ isActive: true });
    const scored = branches
      .filter((branch) => branch.coordinates?.lat != null && branch.coordinates?.lng != null)
      .map((branch) => ({
        branch,
        distance: distanceKm(
          { lat: input.lat as number, lng: input.lng as number },
          { lat: branch.coordinates!.lat, lng: branch.coordinates!.lng }
        ),
      }))
      .sort((a, b) => a.distance - b.distance);

    return scored[0]?.branch || null;
  }

  return null;
}

export async function createOrder(req: Request, res: Response) {
  const { items, customerEmail, customerName, customerPhone, notes } = req.body as {
    items: Array<{ productId: string; quantity: number }>;
    customerEmail: string;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
  };

  const branch = await resolveBranch({
    branchId: req.body.branchId,
    lat: req.body.lat,
    lng: req.body.lng,
  });

  const products = await Product.find({ _id: { $in: items.map((item) => item.productId) } });
  const orderItems = items
    .map((item) => {
      const product = products.find((current) => String(current._id) === item.productId);
      if (!product) return null;
      const branchPrice = branch
        ? product.branchPrices?.find((price: { branch: any; price: number }) => String(price.branch) === String(branch._id))
        : null;
      return {
        product: product._id,
        name: product.name,
        price: branchPrice?.price ?? product.price,
        quantity: item.quantity,
        image: product.images[0]?.url || "",
      };
    })
    .filter(Boolean) as Array<{ product: any; name: string; price: number; quantity: number; image: string }>;

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = 0;
  const total = subtotal + tax;

  const order = await Order.create({
    items: orderItems,
    subtotal: Math.round(subtotal * 100),
    tax: Math.round(tax * 100),
    total: Math.round(total * 100),
    status: "pending",
    customerEmail,
    customerName: customerName || "",
    customerPhone: customerPhone || "",
    notes: notes || "",
    branch: branch?._id || null,
    audit: [],
    payphone: {
      clientTransactionId: `BOL-${Date.now()}`,
    },
  });

  pushAudit(order, {
    action: "created",
    details: branch ? `Sucursal: ${branch.name}` : "Sucursal no asignada",
    toValue: order.status,
  });
  await order.save();

  res.status(201).json(order);
}

export async function confirmOrder(req: Request, res: Response) {
  const { id, clientTxId } = req.body as { id: number; clientTxId: string };
  let payphoneResult;

  try {
    payphoneResult = await confirmPayphoneTransaction(id, clientTxId);
  } catch (error) {
    res.status(503).json({
      message: error instanceof Error ? error.message : "PayPhone is not configured",
    });
    return;
  }

  const order = await Order.findOne({ "payphone.clientTransactionId": clientTxId }).populate("user");

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  if (payphoneResult?.statusCode === 3 || payphoneResult?.transactionStatus === "Approved") {
    const previousStatus = order.status;
    order.status = "paid";
    order.payphone = {
      clientTransactionId: clientTxId,
      transactionId: payphoneResult.transactionId,
      authorizationCode: payphoneResult.authorizationCode,
      statusCode: payphoneResult.statusCode,
      cardBrand: payphoneResult.cardBrand,
      lastDigits: payphoneResult.lastDigits,
      confirmedAt: new Date(),
    };

    let user = await User.findOne({ email: order.customerEmail });
    let tempPassword: string | null = null;
    if (!user) {
      const created = await createAutoUser({
        email: order.customerEmail,
        name: order.customerName,
        phone: order.customerPhone,
      });
      user = created.user;
      tempPassword = created.tempPassword;
      order.user = user._id;
    } else {
      order.user = user._id;
    }

    order.pointsEarned = calculatePoints(centsToDollars(order.total));
    pushAudit(order, {
      action: "payment_confirmed",
      performedBy: null,
      performedByEmail: "system",
      fromValue: previousStatus,
      toValue: order.status,
      details: `PayPhone txId: ${payphoneResult.transactionId || ""}`,
    });
    await order.save();

    if (user) {
      user.points += order.pointsEarned;
      user.pointsHistory.push({
        amount: order.pointsEarned,
        reason: `Compra ${order.orderNumber}`,
        orderId: order._id,
        date: new Date(),
      });
      await user.save();

      await sendEmail(
        user.email,
        `Boloncity: tu pedido ${order.orderNumber}`,
        `<p>Tu compra fue aprobada.</p><p>Pedido: ${order.orderNumber}</p><p>Puntos ganados: ${order.pointsEarned}</p>${tempPassword ? `<p>Credenciales temporales: ${user.email} / ${tempPassword}</p>` : ""}`
      ).catch(() => {});
    }

    res.json({ order, payphoneResult });
    return;
  }

  const previousStatus = order.status;
  order.status = "cancelled";
  order.payphone = {
    clientTransactionId: clientTxId,
    transactionId: payphoneResult?.transactionId,
    authorizationCode: payphoneResult?.authorizationCode,
    statusCode: payphoneResult?.statusCode,
    cardBrand: payphoneResult?.cardBrand,
    lastDigits: payphoneResult?.lastDigits,
    confirmedAt: new Date(),
  };
  pushAudit(order, {
    action: "status_change",
    performedBy: null,
    performedByEmail: "system",
    fromValue: previousStatus,
    toValue: order.status,
    details: `PayPhone status: ${payphoneResult?.transactionStatus || "unknown"}`,
  });
  await order.save();

  res.json({ order, payphoneResult });
}

export async function listOrders(req: AuthRequest, res: Response) {
  const orders = await Order.find(req.branchFilter || {}).sort({ createdAt: -1 }).populate("user").populate("items.product").populate("branch");
  res.json(orders);
}

export async function getOrderByNumber(req: Request, res: Response) {
  const { orderNumber } = req.params;
  const { email } = req.query as { email?: string };
  const order = await Order.findOne({ orderNumber, ...(email ? { customerEmail: email.toLowerCase() } : {}) })
    .populate("user")
    .populate("items.product");

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json(order);
}

export async function getOrderById(req: AuthRequest, res: Response) {
  const order = await Order.findOne({ _id: req.params.id, ...(req.branchFilter || {}) })
    .populate("user")
    .populate("items.product")
    .populate("branch");

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json(order);
}

export async function updateOrderStatus(req: AuthRequest, res: Response) {
  const order = await Order.findOne({ _id: req.params.id, ...(req.branchFilter || {}) });
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
  const previousStatus = order.status;
  order.status = req.body.status;
  pushAudit(order, {
    action: "status_change",
    performedBy: req.user?.userId || null,
    performedByEmail: req.user?.email || "",
    fromValue: previousStatus,
    toValue: req.body.status,
    details: note ? `Cambio de estado manual: ${note}` : `Cambio de estado manual`,
  });
  await order.save();

  res.json(order);
}

export async function addOrderNote(req: AuthRequest, res: Response) {
  const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
  if (!note) {
    res.status(400).json({ message: "Note is required" });
    return;
  }

  const order = await Order.findOne({ _id: req.params.id, ...(req.branchFilter || {}) });
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  pushAudit(order, {
    action: "note_added",
    performedBy: req.user?.userId || null,
    performedByEmail: req.user?.email || "",
    details: note,
  });
  await order.save();

  res.json(order);
}
