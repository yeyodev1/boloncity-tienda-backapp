import { Request, Response } from "express";
import { Order } from "../models/Order";
import { sendEmail } from "../services/resend.service";
import { getFrontendUrl } from "../config/env";
import { getOrderStatusEmailHtml } from "../services/email-templates";

const PICKER_STATUS_ORDER_MAP: Record<string, string> = {
  ON_HOLD: "paid",
  READY_FOR_PICKUP: "preparing",
  ACCEPTED: "preparing",
  ARRIVED_AT_PICKUP: "preparing",
  WAY_TO_DELIVER: "ready",
  ARRIVED_AT_DELIVERY: "ready",
  COMPLETED: "delivered",
  PROVIDER_NOT_FOUND: "ready",
  CANCELLED_BY_BUSINESS: "cancelled",
  CANCELLED_BY_ADMIN: "cancelled",
  CANCELLED_BY_DELIVERY_PROVIDER: "cancelled",
  NOT_DELIVERED: "ready",
  RETURNING: "ready",
  RETURNED: "ready",
};

const PICKER_STATUS_LABELS: Record<string, string> = {
  ON_HOLD: "Esperando preparación",
  READY_FOR_PICKUP: "Buscando delivery",
  ACCEPTED: "Delivery asignado",
  ARRIVED_AT_PICKUP: "Motorizado llegó al local",
  WAY_TO_DELIVER: "En camino",
  ARRIVED_AT_DELIVERY: "Llegó a tu dirección",
  COMPLETED: "Entregado",
  PROVIDER_NOT_FOUND: "Sin delivery disponible",
  CANCELLED_BY_BUSINESS: "Cancelado por el negocio",
  CANCELLED_BY_ADMIN: "Cancelado",
  CANCELLED_BY_DELIVERY_PROVIDER: "Cancelado por el proveedor",
  NOT_DELIVERED: "No entregado",
  RETURNING: "Devolviendo al local",
  RETURNED: "Devuelto al local",
};

async function handleUpdateBookingStatus(payload: any) {
  const { bookingId, bookingNumericId, currentStatus, statusText, validationCode, cancelReason } = payload;

  const order = await Order.findOne({
    $or: [
      { "picker.bookingId": bookingId || "" },
      { "picker.bookingNumericId": bookingNumericId || null },
      { "picker.bookingNumericId": Number(bookingNumericId) || null },
    ],
  });

  if (!order) {
    console.warn(`[Picker Webhook] No order found for bookingId=${bookingId} numericId=${bookingNumericId}`);
    return;
  }

  if (!order.picker) {
    console.warn(`[Picker Webhook] Order ${order.orderNumber} has no picker data`);
    return;
  }

  const oldStatus = order.picker.currentStatus || "";
  const newStatus = currentStatus || "";
  const newStatusText = statusText || PICKER_STATUS_LABELS[newStatus] || "";

  order.picker.currentStatus = newStatus;
  order.picker.statusText = newStatusText;

  if (validationCode) {
    order.picker.validationCode = String(validationCode);
  }

  const mappedOrderStatus = PICKER_STATUS_ORDER_MAP[newStatus];
  const isNewDeliveryStatus = newStatus && newStatus !== oldStatus;

  if (mappedOrderStatus && isNewDeliveryStatus) {
    if (
      (mappedOrderStatus === "cancelled" && order.status !== "cancelled") ||
      mappedOrderStatus !== "cancelled"
    ) {
      order.status = mappedOrderStatus;
    }
  }

  pushAudit(order, {
    action: "status_change",
    details: `Picker delivery: ${PICKER_STATUS_LABELS[oldStatus] || oldStatus} → ${newStatusText}`,
    fromValue: oldStatus,
    toValue: newStatus,
  });

  await order.save();

  sendStatusEmail(order, newStatus, newStatusText).catch(() => {});
}

async function handleDriverAssigned(payload: any) {
  const { bookingId, bookingNumericId, driver } = payload;

  const order = await Order.findOne({
    $or: [
      { "picker.bookingId": bookingId || "" },
      { "picker.bookingNumericId": bookingNumericId || null },
    ],
  });

  if (!order) {
    console.warn(`[Picker Webhook DRIVER] No order found for bookingId=${bookingId}`);
    return;
  }

  if (!order.picker) return;

  order.picker.currentStatus = "ACCEPTED";
  order.picker.statusText = "Delivery asignado";

  if (driver) {
    order.picker.driverName = driver.name || driver.driverName || "";
    order.picker.driverPhone = driver.phone || driver.driverPhone || "";
    order.picker.driverVehicle = driver.vehicle || driver.driverVehicle || "";
    order.picker.driverPhoto = driver.photo || driver.driverPhoto || "";
  }

  if (order.status !== "cancelled") {
    order.status = "preparing";
  }

  pushAudit(order, {
    action: "status_change",
    details: `Delivery asignado: ${order.picker.driverName || "Conductor"} — ${order.picker.driverVehicle || ""}`,
    fromValue: "READY_FOR_PICKUP",
    toValue: "ACCEPTED",
  });

  await order.save();

  sendStatusEmail(order, "ACCEPTED", "Delivery asignado", order.picker.driverName).catch(() => {});
}

function pushAudit(order: any, entry: Record<string, unknown>) {
  order.audit = order.audit || [];
  order.audit.push({
    timestamp: new Date(),
    ...entry,
  });
}

async function sendStatusEmail(order: any, status: string, statusText: string, driverName?: string) {
  const frontendUrl = getFrontendUrl();
  const detailUrl = `${frontendUrl}/mis-ordenes/${order._id}`;

  const html = getOrderStatusEmailHtml({
    orderNumber: order.orderNumber,
    customerName: order.customerName || "Cliente",
    status,
    statusText,
    driverName,
    detailUrl,
    items: order.items || [],
    total: order.total,
  });

  await sendEmail(order.customerEmail, `Tu pedido ${order.orderNumber} — ${statusText}`, html);
}

export async function handlePickerWebhook(req: Request, res: Response) {
  try {
    const { type, eventType, ...payload } = req.body;
    const event = type || eventType || "";

    console.log(`[Picker Webhook] Received event: ${event}`, JSON.stringify(payload).slice(0, 500));

    if (event === "UPDATE_BOOKING_STATUS") {
      await handleUpdateBookingStatus(payload);
    } else if (event === "DRIVER_ASSIGNED") {
      await handleDriverAssigned(payload);
    } else {
      console.warn(`[Picker Webhook] Unknown event type: ${event}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[Picker Webhook] Error processing webhook:", err);
    res.status(200).json({ received: true });
  }
}
