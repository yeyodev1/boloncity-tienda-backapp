import axios from "axios";
import { Request, Response } from "express";
import { Order } from "../models/Order";
import { Counter } from "../models/Counter";
import { Product } from "../models/Product";
import { Setting } from "../models/Setting";
import { confirmPayphoneTransaction } from "../services/payphone.service";
import { createAutoUser } from "../services/auth.service";
import { sendEmail } from "../services/resend.service";
import { createPickerBooking, getPickerBranchKey } from "../services/pickerexpress.service";
import { User } from "../models/User";
import { calculatePoints } from "../services/points.service";
import { Branch } from "../models/Branch";
import { distanceKm } from "../utils/haversine";
import { parseMapsUrl } from "../utils/parseMapsUrl";
import { AuthRequest } from "../types/AuthRequest";

function centsToDollars(value: number) {
  return value / 100;
}

function dollarsToCents(value: number) {
  return Math.round(value * 100);
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

async function getDeliveryPricePerKm() {
  const settings = await Setting.findOne();
  return settings?.deliveryPricePerKm ?? 150;
}

export async function createOrder(req: Request, res: Response) {
  const { items, customerEmail, customerName, customerPhone, notes, deliveryAddress, deliveryGoogleMapsUrl, deliveryType, deliveryCost: deliveryCostDollars, billingDocType, billingName, billingDocNumber, billingEmail, billingAddress } = req.body as {
    items: Array<{ productId: string; quantity: number }>;
    customerEmail: string;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
    deliveryAddress?: string;
    deliveryGoogleMapsUrl?: string;
    deliveryType?: "delivery" | "pickup";
    deliveryCost?: number;
    billingDocType?: string;
    billingName?: string;
    billingDocNumber?: string;
    billingEmail?: string;
    billingAddress?: string;
  };

  const branch = await resolveBranch({
    branchId: req.body.branchId,
    lat: req.body.lat,
    lng: req.body.lng,
  });

  if (!branch) {
    res.status(400).json({ message: "No se encontró una sucursal cercana o seleccionada. Selecciona una sucursal e intenta de nuevo." });
    return;
  }

  const isDelivery = deliveryType !== "pickup";
  const deliveryCoords = isDelivery && deliveryGoogleMapsUrl ? parseMapsUrl(deliveryGoogleMapsUrl) : null;

  const billing =
    billingDocType && billingName
      ? {
          docType: billingDocType,
          name: billingName,
          docNumber: billingDocNumber || "",
          email: billingEmail || "",
          address: billingAddress || "",
        }
      : undefined;

  let deliveryCostCents = 0;
  let deliveryDistance = 0;

  if (isDelivery && deliveryCoords && branch?.coordinates?.lat != null && branch?.coordinates?.lng != null) {
    deliveryDistance = distanceKm(
      { lat: deliveryCoords.lat, lng: deliveryCoords.lng },
      { lat: branch.coordinates.lat, lng: branch.coordinates.lng }
    );
    if (typeof deliveryCostDollars === "number" && deliveryCostDollars > 0) {
      deliveryCostCents = dollarsToCents(deliveryCostDollars);
    } else {
      const pricePerKm = await getDeliveryPricePerKm();
      deliveryCostCents = dollarsToCents(deliveryDistance * centsToDollars(pricePerKm));
    }
  }

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
  const total = subtotal + centsToDollars(deliveryCostCents);

  const counter = await Counter.findByIdAndUpdate(
    { _id: "orderNumber" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const orderNumber = `ORD-${String(counter.seq).padStart(5, "0")}`;

  const order = await Order.create({
    orderNumber,
    items: orderItems,
    subtotal: dollarsToCents(subtotal),
    tax: dollarsToCents(tax),
    total: dollarsToCents(total),
    deliveryType: isDelivery ? "delivery" : "pickup",
    deliveryCost: deliveryCostCents,
    deliveryDistance,
    deliveryAddress: deliveryAddress || "",
    deliveryGoogleMapsUrl: deliveryGoogleMapsUrl || "",
    deliveryCoordinates: deliveryCoords,
    status: "pending",
    customerEmail,
    customerName: customerName || "",
    customerPhone: customerPhone || "",
    notes: notes || "",
    branch: branch?._id || null,
    billing,
    audit: [],
    payphone: {
      clientTransactionId: `BOL-${Date.now()}`,
    },
  });

  pushAudit(order, {
    action: "created",
    details: branch
      ? `Sucursal: ${branch.name}${deliveryDistance ? `, distancia: ${deliveryDistance.toFixed(1)} km` : ""}`
      : "Sucursal no asignada",
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

  const order = await Order.findOne({ "payphone.clientTransactionId": clientTxId }).populate("user").populate("branch");

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

    if (order.deliveryType === "delivery") {
      try {
        const branch = order.branch ? await Branch.findById(order.branch) : null;
        const branchKey = branch?.pickerApiKey || (branch ? getPickerBranchKey(branch.name) : "");
        if (branchKey && order.deliveryCoordinates?.lat && order.deliveryCoordinates?.lng) {
          const nameParts = (order.customerName || "").split(" ");
          const firstName = nameParts[0] || order.customerName || "";
          const lastName = nameParts.slice(1).join(" ") || "Cliente";
          const pickerResult = await createPickerBooking({
            branchKey,
            latitude: order.deliveryCoordinates.lat,
            longitude: order.deliveryCoordinates.lng,
            address: order.deliveryAddress || "Sin dirección",
            reference: order.deliveryGoogleMapsUrl || "",
            customerName: firstName,
            customerLastName: lastName,
            customerEmail: order.customerEmail,
            customerPhone: order.customerPhone || "",
            customerCountryCode: "593",
            orderAmount: centsToDollars(order.total),
            externalBookingId: order.orderNumber,
            notes: order.notes || "",
          });
          order.picker = {
            bookingId: pickerResult._id,
            bookingNumericId: pickerResult.bookingNumericId,
            statusText: pickerResult.statusText,
            smrURL: pickerResult.smrURL,
            bookingDetailUrl: pickerResult.bookingDetailUrl,
            createdAt: new Date(),
            currentStatus: pickerResult.currentStatus || "",
          };
          pushAudit(order, {
            action: "note_added",
            performedBy: null,
            performedByEmail: "system",
            details: `Picker booking #${pickerResult.bookingNumericId} creado`,
          });
          await order.save();
        }
      } catch (pickerErr) {
        console.error("Picker booking failed:", pickerErr);
        pushAudit(order, {
          action: "note_added",
          performedBy: null,
          performedByEmail: "system",
          details: `Picker booking falló: ${pickerErr instanceof Error ? pickerErr.message : "error"}`,
        });
        await order.save();
      }
    }

    if (user) {
      user.points += order.pointsEarned;
      user.pointsHistory.push({
        amount: order.pointsEarned,
        reason: `Compra ${order.orderNumber}`,
        orderId: order._id,
        date: new Date(),
      });
      await user.save();

      const itemsRows = order.items
        .map(
          (item: any) =>
            `<tr style="border-bottom:1px solid #e0e0e0"><td style="padding:10px 0">${item.name}</td><td style="padding:10px 0;text-align:center">x${item.quantity}</td><td style="padding:10px 0;text-align:right;font-weight:700">$${(item.price * item.quantity).toFixed(2)}</td></tr>`
        )
        .join("");

      const branchName = (order.branch as any)?.name || "";
      const deliveryLabel = order.deliveryType === "delivery" ? "Delivery a domicilio" : "Recoger en sucursal";
      const deliveryInfo = order.deliveryType === "delivery"
        ? `${deliveryLabel} · ${branchName}${order.deliveryDistance ? ` (${order.deliveryDistance.toFixed(1)} km)` : ""}`
        : `${deliveryLabel} · ${branchName || "Sucursal"}`;
      const trackingLink = order.picker?.smrURL || "";
      const bookingDetailUrl = order.picker?.bookingDetailUrl || "";

      const orderHtml = `
        <div style="font-family:Switzer,-apple-system,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#235931;padding:28px 24px;border-radius:16px 16px 0 0;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:26px;letter-spacing:-1px">Boloncity</h1>
            <p style="color:#efd537;margin:8px 0 0;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase">Pedido confirmado</p>
          </div>
          <div style="background:#fff;padding:28px 24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 16px 16px">
            <p style="font-size:20px;font-weight:800;margin:0 0 4px">¡Hola${order.customerName ? " " + order.customerName : ""}!</p>
            <p style="color:#666;margin:0 0 24px">Tu pedido <strong style="color:#235931">#${order.orderNumber}</strong> ha sido confirmado.</p>
            <div style="background:#f8f6ec;border-radius:12px;padding:12px 16px;margin-bottom:20px;font-size:14px;color:#235931;font-weight:700">
              ${deliveryInfo}
            </div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${itemsRows}</table>
            <div style="border-top:2px solid #235931;padding:12px 0;text-align:right;font-size:15px;font-weight:700">
              Subtotal: $${centsToDollars(order.subtotal).toFixed(2)}<br />
              ${order.deliveryCost ? `Envío: $${centsToDollars(order.deliveryCost).toFixed(2)}<br />` : ""}
              <span style="font-size:18px;color:#235931">Total pagado: $${centsToDollars(order.total).toFixed(2)}</span>
            </div>
            ${order.deliveryAddress ? `<p style="margin:16px 0 0;color:#666;font-size:14px"><strong>Dirección:</strong> ${order.deliveryAddress}</p>` : ""}
            ${trackingLink ? `
              <div style="margin:20px 0 0;text-align:center">
                <a href="${trackingLink}" style="display:inline-block;background:#235931;color:#fff;padding:14px 24px;border-radius:999px;font-size:15px;font-weight:800;text-decoration:none">Seguir delivery en vivo</a>
              </div>
            ` : ""}
            <p style="color:#00a523;font-weight:700;margin:16px 0 0">Puntos ganados: ${order.pointsEarned}</p>
            <p style="color:#999;font-size:13px;margin:20px 0 0;text-align:center">Puedes seguir tu pedido en <a href="https://boloncity.com/pedido" style="color:#235931">boloncity.com/pedido</a></p>
          </div>
        </div>`;

      if (tempPassword) {
        const welcomeHtml = `
          <div style="font-family:Switzer,sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#235931;padding:24px;border-radius:16px 16px 0 0;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:24px">¡Bienvenido a Boloncity!</h1>
            </div>
            <div style="background:#fff;padding:24px;border:1px solid #e0e0e0;border-top:0;border-radius:0 0 16px 16px">
              <p style="font-size:18px;font-weight:700;margin:0 0 4px">Tu cuenta ha sido creada</p>
              <p style="color:#666;margin:0 0 16px">Con tu primera compra, hemos creado automáticamente una cuenta para ti.</p>
              <div style="background:#f5f5f5;border-radius:12px;padding:16px;margin-bottom:16px">
                <p style="margin:0 0 8px"><strong>Email:</strong> ${user.email}</p>
                <p style="margin:0"><strong>Contraseña temporal:</strong> ${tempPassword}</p>
              </div>
              <p style="color:#999;font-size:13px">Te recomendamos cambiar tu contraseña en tu próxima visita. Puedes ingresar en boloncity.com/login</p>
            </div>
          </div>`;

        await sendEmail(user.email, "Bienvenido a Boloncity — tu cuenta ha sido creada", welcomeHtml).catch(() => {});
      }

      await sendEmail(user.email, `Boloncity: pedido #${order.orderNumber} confirmado`, orderHtml).catch(() => {});
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

  res.status(400).json({
    message: "El pago no fue aprobado. Intenta de nuevo.",
    order,
    payphoneResult,
  });
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
    .populate("branch")
    .populate("items.product");

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json(order);
}

export async function getOrdersByEmail(req: Request, res: Response) {
  const rawEmail = req.params.email as string;
  if (!rawEmail) {
    res.status(400).json({ message: "Email is required" });
    return;
  }

  const orders = await Order.find({ customerEmail: rawEmail.toLowerCase() })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate("items.product");

  if (!orders.length) {
    res.status(404).json({ message: "No se encontraron pedidos para este correo" });
    return;
  }

  res.json(orders);
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

export async function getMyOrders(req: AuthRequest, res: Response) {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }

  const orders = await Order.find({ user: userId })
    .sort({ createdAt: -1 })
    .populate("branch")
    .populate("items.product");

  res.json(orders);
}

export async function getMyOrderById(req: AuthRequest, res: Response) {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }

  const order = await Order.findOne({ _id: req.params.id, user: userId })
    .populate("branch")
    .populate("items.product");

  if (!order) {
    res.status(404).json({ message: "Orden no encontrada" });
    return;
  }

  res.json(order);
}

export async function retryPickerBooking(req: AuthRequest, res: Response) {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }

  const order = await Order.findById(req.params.id).populate("branch");
  if (!order) {
    res.status(404).json({ message: "Orden no encontrada" });
    return;
  }

  if (String(order.user) !== userId) {
    res.status(403).json({ message: "No tienes permiso para modificar esta orden" });
    return;
  }

  if (order.deliveryType !== "delivery") {
    res.status(400).json({ message: "Esta orden no es de tipo delivery" });
    return;
  }

  if (order.picker?.bookingId) {
    res.status(400).json({ message: "Esta orden ya tiene un delivery asignado" });
    return;
  }

  const branch = order.branch ? await Branch.findById(order.branch) : null;
  const branchKey = branch?.pickerApiKey || (branch ? getPickerBranchKey(branch.name) : "");

  if (!branchKey || !order.deliveryCoordinates?.lat || !order.deliveryCoordinates?.lng) {
    res.status(400).json({ message: "No hay coordenadas de entrega o llave de sucursal para crear el delivery" });
    return;
  }

  const nameParts = (order.customerName || "").split(" ");
  const firstName = nameParts[0] || order.customerName || "";
  const lastName = nameParts.slice(1).join(" ") || "Cliente";

  try {
    const pickerResult = await createPickerBooking({
      branchKey,
      latitude: order.deliveryCoordinates.lat,
      longitude: order.deliveryCoordinates.lng,
      address: order.deliveryAddress || "Sin dirección",
      reference: order.deliveryGoogleMapsUrl || "",
      customerName: firstName,
      customerLastName: lastName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone || "",
      customerCountryCode: "593",
      orderAmount: centsToDollars(order.total),
      externalBookingId: order.orderNumber,
      notes: order.notes || "",
    });

    order.picker = {
      bookingId: pickerResult._id,
      bookingNumericId: pickerResult.bookingNumericId,
      statusText: pickerResult.statusText,
      smrURL: pickerResult.smrURL,
      bookingDetailUrl: pickerResult.bookingDetailUrl,
      createdAt: new Date(),
      currentStatus: pickerResult.currentStatus || "",
    };

    pushAudit(order, {
      action: "note_added",
      performedBy: req.user?.userId || null,
      performedByEmail: req.user?.email || "",
      details: `Delivery solicitado por el cliente — Picker booking #${pickerResult.bookingNumericId} creado`,
    });

    await order.save();
    res.json({ success: true, order, picker: pickerResult });
  } catch (pickerErr) {
    console.error("Retry Picker booking failed:", pickerErr);
    let errorMsg = "Error desconocido al crear el delivery";

    if (axios.isAxiosError(pickerErr) && pickerErr.response) {
      const pickerData = pickerErr.response.data;
      errorMsg = pickerData?.message || pickerData?.error || `Picker API error: ${pickerErr.response.status}`;
      console.error("Picker API response data:", JSON.stringify(pickerData, null, 2));
    } else if (pickerErr instanceof Error) {
      errorMsg = pickerErr.message;
    }

    pushAudit(order, {
      action: "note_added",
      performedBy: req.user?.userId || null,
      performedByEmail: req.user?.email || "",
      details: `Intento de delivery falló: ${errorMsg}`,
    });
    await order.save();

    res.status(502).json({
      message: "No pudimos crear el delivery. " + errorMsg,
      error: errorMsg,
    });
  }
}
