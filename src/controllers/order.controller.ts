import axios from "axios";
import { Request, Response } from "express";
import { Order } from "../models/Order";
import { Counter } from "../models/Counter";
import { Product } from "../models/Product";
import { extractIva, getActivePromo, getOrCreateSettings, promoDiscountCents, Setting } from "../models/Setting";
import { confirmPayphoneTransaction, reversePayphoneTransaction } from "../services/payphone.service";
import { createAutoUser } from "../services/auth.service";
import { sendEmail } from "../services/resend.service";
import { createPickerBooking, startSearch } from "../services/pickerexpress.service";
import { User } from "../models/User";
import { calculateEarnedPoints, discountCentsToPoints, pointsToDiscountCents } from "../services/points.service";
import { Branch } from "../models/Branch";
import { distanceKm } from "../utils/haversine";
import { parseMapsUrl } from "../utils/parseMapsUrl";
import { AuthRequest } from "../types/AuthRequest";
import { publishOrderUpdate, subscribeToOrder } from "../services/orderEvents.service";
import { getBranchAvailability, getBranchPayphoneStoreId, getPickerStoreApiKey, isBranchOpenAt, pickerEnabledBranchFilter, validateScheduledTime } from "../services/branchOperational.service";
import { pushOrderToRunfood } from "../services/runfood.service";
import { getFrontendUrl } from "../config/env";
import { getOrderStatusEmailHtml } from "../services/email-templates";
import { PICKER_STATUS_LABELS } from "./webhook.controller";

function centsToDollars(value: number) {
  return value / 100;
}

// Picker devuelve el código legible en statusText y un número en currentStatus.
// Guardamos el código en picker.currentStatus (igual que el webhook) y la
// etiqueta en español en picker.statusText.
export function pickerStatusFields(result: { currentStatus?: unknown; statusText?: unknown }) {
  const code = typeof result.statusText === "string" && result.statusText ? result.statusText : String(result.currentStatus || "");
  return { currentStatus: code, statusText: PICKER_STATUS_LABELS[code] || code };
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

/**
 * Administración general: `admin` o un usuario con acceso a todas las sucursales.
 * Un `branch_admin` de una o varias sucursales NO lo es (no puede cancelar ni devolver).
 */
function isGeneralAdmin(req: AuthRequest) {
  return Boolean(req.user && (req.user.accountType === "admin" || req.user.allBranches));
}

function pickerErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error) && error.response) {
    const data = error.response.data;
    return data?.message || data?.error || `Picker API error: ${error.response.status}`;
  }
  return error instanceof Error ? error.message : "Error desconocido al crear el delivery";
}

async function resolveBranch(input: { branchId?: string; lat?: number; lng?: number }) {
  if (input.branchId) {
    return Branch.findOne({ _id: input.branchId, isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter() }).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
  }

  if (typeof input.lat === "number" && typeof input.lng === "number") {
    const branches = await Branch.find({ isActive: true, isArchived: { $ne: true }, ...pickerEnabledBranchFilter() }).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey");
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
  const { items, customerEmail, customerName, customerPhone, notes, deliveryAddress, deliveryGoogleMapsUrl, deliveryType, deliveryCost: deliveryCostDollars, paymentMethod = "card", billingDocType, billingName, billingDocNumber, billingEmail, billingAddress, scheduledFor: scheduledForInput } = req.body as {
    items: Array<{ productId: string; quantity: number }>;
    customerEmail: string;
    customerName?: string;
    customerPhone?: string;
    notes?: string;
    deliveryAddress?: string;
    deliveryGoogleMapsUrl?: string;
    deliveryType?: "delivery" | "pickup";
    deliveryCost?: number;
    paymentMethod?: "card" | "cash";
    billingDocType?: string;
    billingName?: string;
    billingDocNumber?: string;
    billingEmail?: string;
    billingAddress?: string;
    scheduledFor?: string;
    /** true = canjear los puntos disponibles de la cuenta asociada al correo. */
    redeemPoints?: boolean;
  };
  const redeemPoints = req.body.redeemPoints === true;

  if (paymentMethod !== "card" && paymentMethod !== "cash") {
    res.status(400).json({ message: "Método de pago inválido" });
    return;
  }

  const branch = await resolveBranch({
    branchId: req.body.branchId,
    lat: req.body.lat,
    lng: req.body.lng,
  });

  if (!branch) {
    res.status(400).json({ message: "No se encontró una sucursal cercana o seleccionada. Selecciona una sucursal e intenta de nuevo." });
    return;
  }

  let scheduledFor: Date | undefined;
  if (scheduledForInput !== undefined && scheduledForInput !== null && scheduledForInput !== "") {
    // Los pedidos programados aceptan efectivo además de tarjeta (regla levantada a
    // pedido del cliente): el efectivo se cobra al entregar/retirar, igual que un pedido
    // inmediato. La reserva de Picker y la comanda RunFood se disparan más tarde
    // (ver bookPickerForOrder en "Listas para recolección" y sendOrderToRunfood en "En preparación").
    scheduledFor = new Date(scheduledForInput);
    if (Number.isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
      res.status(400).json({ message: "La fecha programada debe ser futura y válida." });
      return;
    }
    const scheduledValidation = validateScheduledTime(branch, scheduledFor);
    if (!scheduledValidation.valid) {
      res.status(400).json({ message: scheduledValidation.message || "La sucursal no atiende en el horario seleccionado" });
      return;
    }
  } else if (!isBranchOpenAt(branch)) {
    // Fuera de horario no se vende para ahora: el cliente debe programar el pedido.
    const availability = getBranchAvailability(branch);
    res.status(409).json({
      message: availability.nextOpening
        ? `${branch.name} está cerrada en este momento. Programa tu pedido a partir de las ${availability.nextOpening.opensAt}.`
        : `${branch.name} no tiene horarios de atención configurados. Elige otra sucursal.`,
      code: "BRANCH_CLOSED",
      branchClosed: true,
      availability,
    });
    return;
  }

  const isDelivery = deliveryType !== "pickup";
  const deliveryCoords = isDelivery && deliveryGoogleMapsUrl ? parseMapsUrl(deliveryGoogleMapsUrl) : null;

  // El documento de factura debe ser usable por contabilidad: solo dígitos y con la
  // longitud correcta (cédula 10, RUC 13). Antes se guardaba cualquier texto tipeado.
  const billingDocDigits = String(billingDocNumber || "").replace(/\D+/g, "");
  if (billingDocType && billingName) {
    const expectedDigits = billingDocType === "ruc" ? 13 : billingDocType === "cedula" ? 10 : 0;
    if (expectedDigits && billingDocDigits.length !== expectedDigits) {
      res.status(400).json({
        message: `Para la factura, ${billingDocType === "ruc" ? "el RUC debe tener 13 dígitos" : "la cédula debe tener 10 dígitos"}. Revisa el número ingresado.`,
      });
      return;
    }
  }

  const billing =
    billingDocType && billingName
      ? {
          docType: billingDocType,
          name: billingName,
          docNumber: billingDocDigits,
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
        pointsValue: product.pointsValue || 0,
      };
    })
  .filter(Boolean) as Array<{ product: any; name: string; price: number; quantity: number; image: string; pointsValue: number }>;

  const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = subtotal + centsToDollars(deliveryCostCents);

  // Los precios del catalogo YA incluyen IVA: el impuesto se desglosa hacia atras,
  // no se suma encima. `tax` es informativo (facturacion y desglose en PayPhone);
  // no altera el total que paga el cliente.
  const settings = await getOrCreateSettings();

  // ─── Promoción global: % sobre el subtotal de PRODUCTOS. El envío nunca se descuenta. ───
  const activePromo = getActivePromo(settings);
  const promoCents = promoDiscountCents(dollarsToCents(subtotal), activePromo.percent);

  const taxCents = settings.pricesIncludeIva
    ? orderItems.reduce((sum, item) => {
        const product = products.find((current) => String(current._id) === String(item.product));
        if (!product?.hasIva) return sum;
        const rate = product.ivaRate || settings.ivaRate;
        return sum + extractIva(dollarsToCents(item.price * item.quantity), rate).tax;
      }, 0)
    : 0;

  // ─── Puntos: cuanto gana esta compra y canje opcional del saldo del correo ───
  // Los puntos se ganan sobre lo que el cliente realmente paga en productos (ya con promo).
  const pointsEarned = calculateEarnedPoints(Math.max(0, dollarsToCents(subtotal) - promoCents), orderItems, settings);
  const totalCents = Math.max(0, dollarsToCents(total) - promoCents);
  let pointsRedeemed = 0;
  let discountCents = 0;
  let redeemUser: InstanceType<typeof User> | null = null;
  if (redeemPoints && settings.pointsEnabled && customerEmail) {
    redeemUser = await User.findOne({ email: String(customerEmail).toLowerCase().trim() });
    const balance = redeemUser?.points || 0;
    // Siempre queda al menos $1 por pagar: PayPhone no procesa montos menores.
    const maxDiscount = Math.max(0, Math.min(pointsToDiscountCents(balance, settings.pointsRedeemPerDollar), totalCents - 100));
    if (redeemUser && maxDiscount > 0) {
      pointsRedeemed = Math.min(balance, discountCentsToPoints(maxDiscount, settings.pointsRedeemPerDollar));
      discountCents = Math.min(pointsToDiscountCents(pointsRedeemed, settings.pointsRedeemPerDollar), maxDiscount);
    }
  }
  // El IVA informativo se ajusta en proporcion al descuento para que el desglose cuadre.
  const finalTaxCents = discountCents > 0 && totalCents > 0 ? Math.round(taxCents * ((totalCents - discountCents) / totalCents)) : taxCents;

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
    tax: finalTaxCents,
    total: totalCents - discountCents,
    pointsEarned,
    pointsRedeemed,
    discount: discountCents,
    promo: promoCents > 0 ? { percent: activePromo.percent, label: activePromo.label, amount: promoCents } : null,
    paymentMethod,
    deliveryType: isDelivery ? "delivery" : "pickup",
    deliveryCost: deliveryCostCents,
    deliveryDistance,
    deliveryAddress: deliveryAddress || "",
    deliveryGoogleMapsUrl: deliveryGoogleMapsUrl || "",
    deliveryCoordinates: deliveryCoords,
    scheduledFor,
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
      storeId: getBranchPayphoneStoreId(branch?.payphone),
    },
  });

  pushAudit(order, {
    action: "created",
    details: branch
      ? `Sucursal: ${branch.name}${deliveryDistance ? `, distancia: ${deliveryDistance.toFixed(1)} km` : ""}`
      : "Sucursal no asignada",
    toValue: order.status,
  });
  if (pointsRedeemed > 0 && redeemUser) {
    redeemUser.points = Math.max(0, (redeemUser.points || 0) - pointsRedeemed);
    redeemUser.pointsHistory.push({
      amount: -pointsRedeemed,
      reason: `Canje en compra ${order.orderNumber}`,
      orderId: order._id,
      date: new Date(),
    });
    await redeemUser.save();
    pushAudit(order, {
      action: "note_added",
      details: `Canje de puntos: ${pointsRedeemed} pts = descuento de $${(discountCents / 100).toFixed(2)}`,
    });
  }
  await order.save();

  // Picker SOLO para efectivo inmediato. Los pedidos PROGRAMADOS no reservan Picker
  // aquí: la reserva se crea recién cuando el cajero mueve el pedido a "Listas para
  // recolección" (awaiting_pickup). Ver bookPickerForOrder + updateOrderStatus.
  if (paymentMethod === "cash" && !scheduledFor && isDelivery) {
    await bookPickerForOrder(order, "CASH");
  }

  // Efectivo sin programar: la cocina arranca ya, así que la comanda entra al POS RunFood.
  // (Tarjeta se envía al confirmarse el pago; programados, cuando pasan a "En preparación".)
  if (paymentMethod === "cash" && !scheduledFor) {
    await sendOrderToRunfood(order);
  }

  // Confirmación por correo para efectivo — tarjeta recibe la suya al confirmarse el pago.
  // En serverless hay que esperar el envío antes de responder o el correo muere en vuelo.
  if (paymentMethod === "cash") {
    const scheduledLabel = scheduledFor
      ? new Intl.DateTimeFormat("es-EC", {
          timeZone: "America/Guayaquil",
          weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
        }).format(new Date(scheduledFor))
      : "";
    const html = getOrderStatusEmailHtml({
      orderNumber: order.orderNumber,
      customerName: order.customerName || "Cliente",
      status: order.status,
      statusText: scheduledLabel
        ? `Pedido programado para ${scheduledLabel}`
        : `Recibimos tu pedido — pagas en efectivo al ${order.deliveryType === "pickup" ? "retirarlo en el local" : "recibirlo"}`,
      detailUrl: `${getFrontendUrl()}/mis-ordenes/${order._id}`,
      items: order.items || [],
      total: order.total,
    });
    await sendEmail(order.customerEmail, `Boloncity: recibimos tu pedido ${order.orderNumber}`, html).catch(() => {});
  }

  res.status(201).json(order);
}

/**
 * Crea la reserva de Picker de un delivery y la guarda en order.picker. No lanza:
 * si falla, deja el motivo en la auditoría. Idempotente (si ya hay bookingId, no hace nada).
 * Se llama para efectivo inmediato (al crear), tarjeta inmediata (al confirmar el pago)
 * y para CUALQUIER pedido al pasar a "Listas para recolección" (incluidos los programados).
 */
async function bookPickerForOrder(
  order: InstanceType<typeof Order>,
  paymentMethod: "CASH" | "CARD",
  // applyCookTime=false cuando la comida ya está lista (p. ej. al pasar a "Listas para
  // recolección"): ahí Picker debe buscar motorizado de inmediato, sin esperar cocina.
  { applyCookTime = true }: { applyCookTime?: boolean } = {}
) {
  if (order.deliveryType !== "delivery" || order.picker?.bookingId) return;
  try {
    const branch = order.branch
      ? await Branch.findById(order.branch).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey")
      : null;
    // Picker recibe cookTime en milisegundos; la sucursal lo configura en minutos.
    const cookTimeMs = applyCookTime ? Math.max(0, Math.round(Number(branch?.cookTimeMinutes) || 0)) * 60_000 : 0;
    const branchKey = getPickerStoreApiKey(branch?.pickerStore);
    const coords = order.deliveryCoordinates;
    if (!branchKey || !coords?.lat || !coords?.lng) throw new Error("No hay llave de Picker o coordenadas de entrega");
    const nameParts = (order.customerName || "").split(" ");
    const pickerResult = await createPickerBooking({
      branchKey,
      latitude: coords.lat,
      longitude: coords.lng,
      address: order.deliveryAddress || "Sin dirección",
      reference: order.deliveryGoogleMapsUrl || "",
      customerName: nameParts[0] || order.customerName || "",
      customerLastName: nameParts.slice(1).join(" ") || "Cliente",
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone || "",
      customerCountryCode: "593",
      orderAmount: centsToDollars(order.subtotal),
      businessDeliveryFee: centsToDollars(order.deliveryCost),
      paymentMethod,
      externalBookingId: order.orderNumber,
      notes: order.notes || "",
      cookTime: cookTimeMs,
    });
    order.picker = {
      bookingId: pickerResult._id,
      bookingNumericId: pickerResult.bookingNumericId,
      ...pickerStatusFields(pickerResult),
      smrURL: pickerResult.smrURL,
      bookingDetailUrl: pickerResult.bookingDetailUrl,
      createdAt: new Date(),
      deliveryFee: pickerResult.deliveryFee || 0,
    };
    pushAudit(order, { action: "note_added", performedBy: null, performedByEmail: "system", details: `Picker booking #${pickerResult.bookingNumericId} creado` });
    await order.save();
  } catch (pickerErr) {
    const errorMessage = pickerErr instanceof Error ? pickerErr.message : "error";
    console.error("Picker booking failed:", errorMessage);
    pushAudit(order, { action: "note_added", performedBy: null, performedByEmail: "system", details: `Picker booking falló: ${errorMessage}` });
    await order.save();
  }
}

/** Empuja el pedido al POS RunFood de su sucursal (si esta configurado) y lo deja en la auditoria. */
async function sendOrderToRunfood(order: InstanceType<typeof Order>) {
  try {
    if (!order.branch) return;
    const branch = await Branch.findById(order.branch).select("+runfood.apiKey");
    const runfood = branch?.runfood;
    if (!runfood?.enabled || !runfood.baseUrl || !runfood.apiKey) return;
    const result = await pushOrderToRunfood({
      config: { baseUrl: runfood.baseUrl, apiKey: runfood.apiKey },
      orderNumber: order.orderNumber,
      customerName: order.customerName || order.customerEmail,
      deliveryType: order.deliveryType,
      notes: order.notes || "",
      items: (order.items || []).map((item: { name: string; quantity: number }) => ({ name: item.name, quantity: item.quantity })),
    });
    pushAudit(order, {
      action: "note_added",
      performedBy: null,
      performedByEmail: "system",
      details: result.ok ? `RunFood: ${result.message}` : `RunFood NO recibió el pedido: ${result.message}`,
    });
    await order.save();
  } catch (err) {
    console.error("RunFood push failed:", err);
  }
}

export async function confirmOrder(req: Request, res: Response) {
  const { id, clientTxId } = req.body as { id: number; clientTxId: string };

  const order = await Order.findOne({ "payphone.clientTransactionId": clientTxId }).populate("user").populate("branch");

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  if (order.payphone?.confirmedAt) {
    res.json({ order });
    return;
  }

  let payphoneResult;

  try {
    payphoneResult = await confirmPayphoneTransaction(id, clientTxId);
  } catch (error) {
    res.status(503).json({
      message: error instanceof Error ? error.message : "PayPhone is not configured",
    });
    return;
  }

  if (payphoneResult?.statusCode === 3 || payphoneResult?.transactionStatus === "Approved") {
    const previousStatus = order.status;
    order.status = "paid";
    order.payphone = {
      ...(order.payphone?.toObject ? order.payphone.toObject() : order.payphone),
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

    // pointsEarned ya se calculo al crear la orden (tarifa por dolar + extras por producto).
    pushAudit(order, {
      action: "payment_confirmed",
      performedBy: null,
      performedByEmail: "system",
      fromValue: previousStatus,
      toValue: order.status,
      details: `PayPhone txId: ${payphoneResult.transactionId || ""}`,
    });
    await order.save();

    // Pago confirmado: la comanda entra al POS RunFood del local (si esta configurado).
    if (!order.scheduledFor) {
      await sendOrderToRunfood(order);
    }

    // Tarjeta inmediata: se reserva Picker al confirmar el pago. Los PROGRAMADOS no:
    // su Picker se pide recién al pasar a "Listas para recolección" (ver updateOrderStatus).
    if (order.deliveryType === "delivery" && !order.picker?.bookingId && !order.scheduledFor) {
      await bookPickerForOrder(order, "CARD");
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
              ${order.promo?.amount ? `${order.promo.label || "Promoción"}: -$${centsToDollars(order.promo.amount).toFixed(2)}<br />` : ""}
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
    ...(order.payphone?.toObject ? order.payphone.toObject() : order.payphone),
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

const REFUNDABLE_UNTIL_HOUR = 20;

/**
 * PayPhone solo acepta el reverso el mismo dia de la transaccion y antes de las 20:00 EC.
 * Se evalua en hora de Ecuador, no en la del servidor (Vercel corre en UTC).
 */
export function getRefundWindow(confirmedAt: Date | null | undefined, now = new Date()) {
  const ecuadorParts = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Guayaquil",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});

  if (!confirmedAt) return { open: false, reason: "El pedido no tiene un pago confirmado en PayPhone." };

  const paid = ecuadorParts(confirmedAt);
  const current = ecuadorParts(now);
  const paidDate = `${paid.year}-${paid.month}-${paid.day}`;
  const currentDate = `${current.year}-${current.month}-${current.day}`;

  if (paidDate !== currentDate) {
    return { open: false, reason: "PayPhone solo permite reversar el mismo dia del pago. Gestiona la devolucion desde PayPhone Business." };
  }
  if (Number(current.hour) >= REFUNDABLE_UNTIL_HOUR) {
    return { open: false, reason: `El reverso solo se acepta hasta las ${REFUNDABLE_UNTIL_HOUR}:00 de Ecuador. Gestiona la devolucion desde PayPhone Business.` };
  }
  return { open: true as const };
}

/**
 * Reversa el cobro en PayPhone y cancela el pedido. El reverso es siempre por el total:
 * la API no admite montos parciales.
 */
export async function refundOrder(req: AuthRequest, res: Response) {
  // La devolución del dinero la ejecuta administración general, igual que la cancelación.
  if (!isGeneralAdmin(req)) {
    res.status(403).json({
      code: "REFUND_FORBIDDEN",
      message: "Solo un administrador general puede devolver el pago de un pedido.",
    });
    return;
  }

  const order = await Order.findOne({ _id: req.params.id, ...(req.branchFilter || {}) });
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  if (order.paymentMethod !== "card") {
    res.status(400).json({ message: "Solo se pueden reversar pedidos pagados con tarjeta." });
    return;
  }
  if (!order.payphone?.transactionId && !order.payphone?.clientTransactionId) {
    res.status(400).json({ message: "El pedido no tiene una transaccion de PayPhone asociada." });
    return;
  }
  if (order.payphone?.refund?.status === "refunded") {
    res.status(409).json({ message: "Este pedido ya fue reversado." });
    return;
  }
  if (order.payphone?.refund?.status === "processing") {
    res.status(409).json({ message: "Ya hay un reverso en curso para este pedido." });
    return;
  }

  const window = getRefundWindow(order.payphone?.confirmedAt);
  if (!window.open) {
    res.status(422).json({ message: window.reason });
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const requestedByEmail = req.user?.email || "";

  order.payphone.refund = {
    status: "processing",
    amount: order.total,
    reason,
    requestedBy: req.user?.userId || null,
    requestedByEmail,
    requestedAt: new Date(),
  };
  pushAudit(order, {
    action: "refund_requested",
    performedBy: req.user?.userId || null,
    performedByEmail: requestedByEmail,
    details: reason ? `Reverso solicitado: ${reason}` : "Reverso solicitado",
  });
  await order.save();

  const result = order.payphone.transactionId
    ? await reversePayphoneTransaction({ transactionId: order.payphone.transactionId })
    : await reversePayphoneTransaction({ clientTransactionId: order.payphone.clientTransactionId! });

  if (!result.ok) {
    order.payphone.refund.status = "failed";
    order.payphone.refund.errorCode = result.errorCode;
    order.payphone.refund.errorMessage = result.message || "";
    pushAudit(order, {
      action: "refund_failed",
      performedBy: req.user?.userId || null,
      performedByEmail: requestedByEmail,
      details: `PayPhone rechazo el reverso: ${result.message || "sin detalle"}${result.errorCode ? ` (codigo ${result.errorCode})` : ""}`,
    });
    await order.save();
    publishOrderUpdate(order);
    res.status(502).json({ message: result.message || "PayPhone rechazo el reverso.", order });
    return;
  }

  const previousStatus = order.status;
  order.payphone.refund.status = "refunded";
  order.payphone.refund.refundedAt = new Date();
  order.status = "cancelled";

  // Al reversar se devuelven los puntos canjeados y se retiran los ganados por esta compra.
  if (order.pointsRedeemed > 0 || order.pointsEarned > 0) {
    const pointsUser = await User.findOne({ email: String(order.customerEmail || "").toLowerCase().trim() });
    if (pointsUser) {
      const adjustment = (order.pointsRedeemed || 0) - (order.pointsEarned || 0);
      if (adjustment !== 0) {
        pointsUser.points = Math.max(0, (pointsUser.points || 0) + adjustment);
        pointsUser.pointsHistory.push({
          amount: adjustment,
          reason: `Reverso de compra ${order.orderNumber}`,
          orderId: order._id,
          date: new Date(),
        });
        await pointsUser.save();
      }
    }
  }
  pushAudit(order, {
    action: "refunded",
    performedBy: req.user?.userId || null,
    performedByEmail: requestedByEmail,
    fromValue: previousStatus,
    toValue: order.status,
    details: `Reverso aprobado por PayPhone${reason ? `: ${reason}` : ""}`,
  });
  await order.save();
  publishOrderUpdate(order);

  const html = getOrderStatusEmailHtml({
    orderNumber: order.orderNumber,
    customerName: order.customerName || "Cliente",
    status: order.status,
    statusText: "Tu pago fue devuelto",
    detailUrl: `${getFrontendUrl()}/mis-ordenes/${order._id}`,
    items: order.items || [],
    total: order.total,
  });
  // En serverless hay que esperar el envio: responder antes congela la funcion y el correo muere en vuelo.
  await sendEmail(order.customerEmail, `Boloncity: devolucion del pedido ${order.orderNumber}`, html).catch(() => {});

  res.json({ message: "Reverso aprobado por PayPhone", order });
}

export async function listOrders(req: AuthRequest, res: Response) {
  const { period = "today", date, from, to, status, limit = "100" } = req.query as Record<string, string | undefined>;
  const query: Record<string, unknown> = { ...(req.branchFilter || {}) };

  if (from && to) {
    const start = new Date(`${from}T00:00:00-05:00`);
    const end = new Date(`${to}T00:00:00-05:00`);
    end.setDate(end.getDate() + 1);
    query.createdAt = { $gte: start, $lt: end };
  } else if (period !== "all") {
    const dateParts = new Intl.DateTimeFormat("en", {
      timeZone: "America/Guayaquil",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: string) => dateParts.find((item) => item.type === type)?.value || "";
    const dateValue = date || `${part("year")}-${part("month")}-${part("day")}`;
    const start = new Date(`${dateValue}T00:00:00-05:00`);
    const end = new Date(`${dateValue}T00:00:00-05:00`);
    end.setDate(end.getDate() + 1);
    query.createdAt = { $gte: start, $lt: end };
  }

  if (status && status !== "all") query.status = status;

  // Ocultar órdenes de TARJETA que quedaron sin pagar (checkout abandonado o pago
  // fallido): no deben aparecer en el tablero ni prepararse. Solo se muestran cuando
  // PayPhone confirmó el cobro (hay transactionId) o si son en efectivo. Con
  // ?includeUnpaid=true un admin puede verlas para auditar.
  if (req.query.includeUnpaid !== "true") {
    query.$nor = [{ paymentMethod: "card", status: "pending", "payphone.transactionId": null }];
  }

  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const orders = await Order.find(query)
    .sort({ createdAt: -1 })
    .limit(cappedLimit)
    .populate("branch", "name")
    .lean();
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

export async function streamOrderByNumber(req: Request, res: Response) {
  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
  if (!email) {
    res.status(400).json({ message: "Email is required" });
    return;
  }

  const order = await Order.findOne({ orderNumber: req.params.orderNumber, customerEmail: email });
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.status(200);
  res.set({
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  });
  res.flushHeaders();

  let latestUpdate = order.updatedAt?.getTime() || 0;
  const sendOrder = (updatedOrder: typeof order) => {
    latestUpdate = updatedOrder.updatedAt?.getTime() || Date.now();
    res.write(`event: order\ndata: ${JSON.stringify(updatedOrder)}\n\n`);
  };
  const unsubscribe = subscribeToOrder(String(order._id), (updatedOrder) => sendOrder(updatedOrder as typeof order));
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  const databaseCheck = setInterval(() => {
    void Order.findById(order._id).then((updatedOrder) => {
      if (updatedOrder && (updatedOrder.updatedAt?.getTime() || 0) > latestUpdate) {
        sendOrder(updatedOrder as typeof order);
      }
    });
  }, 2000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clearInterval(databaseCheck);
    unsubscribe();
  });
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

  // Un delivery normalmente pasa a "entregado" por el webhook de Picker, pero si el
  // webhook no llega (p. ej. no está registrado en el entorno) el cajero puede
  // confirmarlo manualmente; queda auditado como confirmación manual.
  const manualDeliveryConfirmation = order.deliveryType === "delivery" && req.body.status === "delivered" && order.picker?.currentStatus !== "COMPLETED";

  // Una orden de TARJETA sin pago confirmado no se puede procesar: solo se puede
  // cancelar. Sin esto, un pedido no pagado podría prepararse y entregarse gratis.
  const cardUnpaid = order.paymentMethod === "card" && !order.payphone?.transactionId && !order.payphone?.confirmedAt;
  if (cardUnpaid && req.body.status !== "cancelled") {
    res.status(409).json({
      code: "ORDER_UNPAID",
      message: "Este pedido no está pagado. El cliente no completó el pago con tarjeta, así que no se puede preparar ni avanzar. Solo puede cancelarse.",
    });
    return;
  }

  const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
  const isCancelling = req.body.status === "cancelled" && order.status !== "cancelled";

  // Cancelar es privilegio de administración general (contabilidad/gerencia): un admin de
  // sucursal no puede cancelar pedidos. Además exige motivo, porque una cancelación con
  // tarjeta NO devuelve el dinero: la devolución se hace aparte desde el detalle.
  if (isCancelling && !isGeneralAdmin(req)) {
    res.status(403).json({
      code: "CANCEL_FORBIDDEN",
      message: "Solo un administrador general puede cancelar pedidos. Pide la cancelación a administración.",
    });
    return;
  }
  if (isCancelling && !note) {
    res.status(400).json({
      code: "CANCEL_REASON_REQUIRED",
      message: "Escribe el motivo de la cancelación: queda registrado en la auditoría del pedido.",
    });
    return;
  }

  // Retiro en local: la orden la cierra el cajero cuando el cliente se lleva el pedido.
  const manualPickupConfirmation = order.deliveryType === "pickup" && req.body.status === "delivered";

  const previousStatus = order.status;
  order.status = req.body.status;

  if (isCancelling) {
    order.set("cancellation", {
      by: req.user?.userId || null,
      byEmail: req.user?.email || "",
      byName: req.user?.email || "",
      reason: note,
      at: new Date(),
    });
  }

  const cardStillCharged = isCancelling
    && order.paymentMethod === "card"
    && Boolean(order.payphone?.transactionId)
    && order.payphone?.refund?.status !== "refunded";

  pushAudit(order, {
    action: "status_change",
    performedBy: req.user?.userId || null,
    performedByEmail: req.user?.email || "",
    fromValue: previousStatus,
    toValue: req.body.status,
    details: isCancelling
      ? `Orden cancelada por ${req.user?.email || "administración"}. Motivo: ${note}${cardStillCharged ? " · El cobro con tarjeta NO se anuló automáticamente: hay que hacer la devolución desde el detalle del pedido." : ""}`
      : manualDeliveryConfirmation
      ? `Entrega confirmada manualmente por el cajero (Picker no reportó la entrega por webhook)${note ? `: ${note}` : ""}`
      : manualPickupConfirmation
      ? `Retiro confirmado en el local por ${req.user?.email || "el cajero"}${note ? `: ${note}` : ""}`
      : note ? `Cambio de estado manual: ${note}` : `Cambio de estado manual`,
  });
  await order.save();
  publishOrderUpdate(order);

  if (previousStatus !== order.status) {
    // Picker se pide SOLO al llegar a "Listas para recolección" (cubre los programados,
    // que a propósito no reservan Picker antes). Idempotente: si ya hay reserva, no repite.
    if (order.status === "awaiting_pickup" && order.deliveryType === "delivery" && !order.picker?.bookingId) {
      // La comida ya está lista para recolección: sin espera de cocina.
      await bookPickerForOrder(order, order.paymentMethod === "cash" ? "CASH" : "CARD", { applyCookTime: false });
      publishOrderUpdate(order);
    }
    // Pedido programado: la comanda entra al POS RunFood cuando la cocina arranca.
    if (order.status === "preparing" && order.scheduledFor) {
      await sendOrderToRunfood(order);
    }
  }

  if (previousStatus !== order.status) {
    const statusText: Record<string, string> = {
      pending: "Pedido recibido",
      paid: "Pago confirmado",
      preparing: "Tu pedido está en preparación",
      awaiting_pickup: order.deliveryType === "pickup" ? "Tu pedido ya está listo para retirar" : "Tu pedido espera recolección",
      ready: "Tu pedido ya va en entrega",
      delivered: order.deliveryType === "pickup" ? "Pedido retirado" : "Pedido entregado",
      cancelled: "Pedido cancelado",
    };
    const html = getOrderStatusEmailHtml({
      orderNumber: order.orderNumber,
      customerName: order.customerName || "Cliente",
      status: order.status,
      statusText: statusText[order.status] || "Actualización de tu pedido",
      detailUrl: `${getFrontendUrl()}/mis-ordenes/${order._id}`,
      items: order.items || [],
      total: order.total,
    });
    // En serverless hay que esperar el envio: responder antes congela la funcion y el correo muere en vuelo.
    await sendEmail(order.customerEmail, `Tu pedido ${order.orderNumber} — ${statusText[order.status] || "Actualización"}`, html).catch(() => {});
  }

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

export async function streamMyOrder(req: AuthRequest, res: Response) {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }

  const order = await Order.findOne({ _id: req.params.id, user: userId });
  if (!order) {
    res.status(404).json({ message: "Orden no encontrada" });
    return;
  }

  res.status(200);
  res.set({
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  });
  res.flushHeaders();

  let latestUpdate = order.updatedAt?.getTime() || 0;
  const sendOrder = (updatedOrder: typeof order) => {
    latestUpdate = updatedOrder.updatedAt?.getTime() || Date.now();
    res.write(`event: order\ndata: ${JSON.stringify(updatedOrder)}\n\n`);
  };

  const unsubscribe = subscribeToOrder(String(order._id), (updatedOrder) => {
    sendOrder(updatedOrder as typeof order);
  });
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  // Covers webhook and SSE requests handled by different serverless instances.
  const databaseCheck = setInterval(() => {
    void Order.findById(order._id).then((updatedOrder) => {
      if (updatedOrder && (updatedOrder.updatedAt?.getTime() || 0) > latestUpdate) {
        sendOrder(updatedOrder as typeof order);
      }
    });
  }, 2000);

  req.on("close", () => {
    clearInterval(keepAlive);
    clearInterval(databaseCheck);
    unsubscribe();
  });
}

export async function retryPickerBooking(req: AuthRequest, res: Response) {
  const userId = req.user?.userId;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const isPublicRetry = Boolean(email);
  if (!userId && !isPublicRetry) {
    res.status(401).json({ message: "No autenticado" });
    return;
  }

  const order = isPublicRetry
    ? await Order.findOne({ orderNumber: req.params.orderNumber, customerEmail: email }).populate("branch")
    : await Order.findById(req.params.id).populate("branch");
  if (!order) {
    res.status(404).json({ message: "Orden no encontrada" });
    return;
  }

  if (!isPublicRetry && String(order.user) !== userId && req.user?.accountType !== "admin") {
    res.status(403).json({ message: "No tienes permiso para modificar esta orden" });
    return;
  }

  if (order.status !== "paid") {
    res.status(400).json({ message: "Solo se puede solicitar delivery para una orden pagada" });
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

  if (isPublicRetry && !order.audit.some((entry: { action: string; details?: string }) => entry.action === "note_added" && /picker booking fall[oó]|intento de delivery fall[oó]/i.test(entry.details || ""))) {
    res.status(409).json({ message: "Esta orden no tiene un error de delivery para reintentar" });
    return;
  }

  const branch = order.branch ? await Branch.findById(order.branch).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey") : null;
  const branchKey = getPickerStoreApiKey(branch?.pickerStore);

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
      orderAmount: centsToDollars(order.subtotal),
      businessDeliveryFee: centsToDollars(order.deliveryCost),
      paymentMethod: order.paymentMethod === "cash" ? "CASH" : "CARD",
      externalBookingId: order.orderNumber,
      notes: order.notes || "",
    });

    order.picker = {
      bookingId: pickerResult._id,
      bookingNumericId: pickerResult.bookingNumericId,
      ...pickerStatusFields(pickerResult),
      smrURL: pickerResult.smrURL,
      bookingDetailUrl: pickerResult.bookingDetailUrl,
      createdAt: new Date(),
      deliveryFee: pickerResult.deliveryFee || 0,
    };

    pushAudit(order, {
      action: "note_added",
      performedBy: req.user?.userId || null,
      performedByEmail: req.user?.email || order.customerEmail,
      details: `Delivery reintentado — Picker booking #${pickerResult.bookingNumericId} creado`,
    });

    await order.save();
    res.json({ success: true, order, picker: pickerResult });
  } catch (pickerErr) {
    const errorMsg = pickerErrorMessage(pickerErr);
    console.error("Retry Picker booking failed:", errorMsg);

    pushAudit(order, {
      action: "note_added",
      performedBy: req.user?.userId || null,
      performedByEmail: req.user?.email || order.customerEmail,
      details: `Intento de delivery falló: ${errorMsg}`,
    });
    await order.save();

    res.status(502).json({
      message: "No pudimos crear el delivery. " + errorMsg,
      error: errorMsg,
    });
  }
}

export async function startScheduledPickerSearch(req: AuthRequest, res: Response) {
  const order = await Order.findOne({ _id: req.params.id, ...(req.branchFilter || {}) });
  if (!order) {
    res.status(404).json({ message: "Orden no encontrada" });
    return;
  }

  if (!order.scheduledFor || order.deliveryType !== "delivery") {
    res.status(400).json({ message: "Esta orden no es un delivery programado" });
    return;
  }
  if (!order.picker?.bookingId) {
    res.status(400).json({ message: "La orden programada no tiene una reserva de Picker" });
    return;
  }
  if (!(["on_hold", "failed"] as const).includes(order.picker.searchState || "on_hold") || order.picker.currentStatus !== "ON_HOLD") {
    res.status(409).json({ message: "La búsqueda de driver solo puede iniciarse para una reserva Picker en espera" });
    return;
  }

  const branch = order.branch
    ? await Branch.findById(order.branch).select("+pickerStore.storeApiKey +pickerStore.productionStoreApiKey")
    : null;
  const branchKey = getPickerStoreApiKey(branch?.pickerStore);
  if (!branchKey) {
    res.status(400).json({ message: "La sucursal no tiene una llave de Picker configurada" });
    return;
  }

  try {
    const pickerResult = await startSearch(order.picker.bookingId, branchKey);
    order.picker.searchState = "started";
    order.picker.searchStartedAt = new Date();
    order.picker.searchResult = pickerResult;
    order.picker.searchError = "";
    order.picker.currentStatus = typeof pickerResult.statusText === "string" ? pickerResult.statusText : "READY_FOR_PICKUP";
    order.picker.statusText = "Buscando delivery";
    pushAudit(order, {
      action: "status_change",
      performedBy: req.user?.userId || null,
      performedByEmail: req.user?.email || "",
      fromValue: "ON_HOLD",
      toValue: order.picker.currentStatus,
      details: "Búsqueda de driver iniciada manualmente para la reserva programada de Picker",
    });
    await order.save();
    res.json({ success: true, order, picker: pickerResult });
  } catch (error) {
    const message = axios.isAxiosError(error)
      ? error.response?.data?.message || error.response?.data?.error || `Picker API error: ${error.response?.status || "unavailable"}`
      : error instanceof Error ? error.message : "Error desconocido";
    order.picker.searchState = "failed";
    order.picker.searchError = String(message);
    pushAudit(order, {
      action: "note_added",
      performedBy: req.user?.userId || null,
      performedByEmail: req.user?.email || "",
      details: `No se pudo iniciar la búsqueda de driver: ${message}`,
    });
    await order.save();
    console.error("Picker start search failed:", message);
    res.status(502).json({ message: `No se pudo iniciar la búsqueda de driver: ${message}` });
  }
}
