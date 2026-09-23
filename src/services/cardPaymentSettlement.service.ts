import { Order } from "../models/Order";
import {
  evaluatePayphoneResult,
  markCardOrderRejected,
  recordPayphoneMismatch,
  settleApprovedCardOrder,
} from "../controllers/order.controller";
import { confirmPayphoneTransaction, getPayphoneSaleByClientTxId } from "./payphone.service";

/**
 * CIERRE DE UN PAGO DE TARJETA SIN EL NAVEGADOR.
 *
 * El checkout web cierra el pago cuando PayPhone redirige al cliente de vuelta y el frontend
 * llama POST /api/orders/confirm. El cliente de WhatsApp paga en el navegador y vuelve al chat:
 * nadie confirma. Este caso de uso es el que tapa ese hueco cuando el cliente escribe *pagado*.
 *
 * Son DOS pasos y ninguno se puede saltar:
 *   1) GET /api/Sale/client/{clientTransactionId} para saber si existe la transaccion y con que
 *      `transactionId` numerico (el bot nunca lo recibe).
 *   2) POST /api/button/V2/Confirm con ese id — la FASE DE CONFIRMACION. Si el comercio no la
 *      ejecuta dentro de los 5 minutos siguientes al pago, PayPhone revierte la venta sola.
 *      Su respuesta es la que alimenta las mismas validaciones de monto/clientTxId de la web.
 *
 * REGLA QUE EVITA EL DESASTRE: "pendiente" y "no encontrada" NO tocan la orden. Ni cancelan ni
 * escriben `payphone.confirmedAt` — si se escribiera, el confirm del navegador saldria temprano y
 * el pedido real quedaria sin cocina, sin Picker y sin correo.
 */
export type CardSettlementOutcome =
  /** Ya estaba pagada (pago previo o segundo "pagado"): no se llama a PayPhone. */
  | "already_paid"
  /** Este llamado la cobro y la despacho (cocina, Picker, correo). */
  | "paid_now"
  /** PayPhone no tiene la transaccion o la tiene pendiente: la orden queda intacta. */
  | "pending"
  /** PayPhone dice rechazada/cancelada. */
  | "rejected"
  /** Aprobada por otro monto o con otro identificador: queda para revision manual. */
  | "mismatch"
  /** No existe la orden, no es de tarjeta, o ya estaba cancelada. */
  | "not_applicable"
  /** Fallo tecnico (sin token, sin clientTransactionId, error inesperado). */
  | "error";

export interface CardSettlementResult {
  outcome: CardSettlementOutcome;
  order?: any;
  /** Motivo tecnico (auditoria/logs), NO un texto para el cliente. */
  detail?: string;
}

/**
 * Consulta el estado real del pago de un pedido de tarjeta y, si PayPhone lo tiene cobrado,
 * lo cierra por el MISMO camino que el regreso del navegador (settleApprovedCardOrder).
 *
 * Idempotente: dos llamados seguidos devuelven "paid_now" y luego "already_paid"; el segundo
 * no vuelve a mandar a cocina, no vuelve a reservar Picker y no vuelve a mandar correo.
 */
/** Lo que toca hacer tras consultar la venta en PayPhone (ver decideFromSale). */
export type SaleDecision =
  | { next: "pending"; detail?: string }
  | { next: "rejected"; detail?: string }
  | { next: "confirm"; transactionId: number; detail?: string };

/**
 * Qué hacer con lo que responde la CONSULTA de PayPhone, sin tocar la base. Se decide aquí, aparte, porque de
 * esto depende que a nadie se le cancele un pedido con la tarjeta a medio cobrar:
 *
 *   pending  → no existe la venta, PayPhone no respondió, o existe pero AÚN NO está aprobada (el cliente abrió
 *              la Cajita y no terminó). La orden se deja intacta y al cliente se le dice que todavía no llega.
 *   rejected → PayPhone dice cancelada/rechazada y no hay transacción que confirmar.
 *   confirm  → venta aprobada y con id numérico: toca la fase de confirmación (evita el auto-reverso de 5 min).
 */
export function decideFromSale(sale: {
  found: boolean;
  statusCode?: number;
  transactionStatus?: string;
  transactionId?: number;
  error?: string;
}): SaleDecision {
  if (!sale.found) return { next: "pending", detail: sale.error };

  const declined = sale.statusCode === 2 || sale.transactionStatus === "Canceled" || sale.transactionStatus === "Cancelled";
  if (declined && !sale.transactionId) return { next: "rejected", detail: `PayPhone: ${sale.transactionStatus || "statusCode 2"}` };

  if (!sale.transactionId) return { next: "pending", detail: `PayPhone statusCode ${sale.statusCode}` };

  const approved = sale.statusCode === 3 || sale.transactionStatus === "Approved";
  if (!approved) return { next: "pending", detail: `PayPhone statusCode ${sale.statusCode} (${sale.transactionStatus || "sin estado"})` };

  return { next: "confirm", transactionId: sale.transactionId };
}

export async function settleCardPaymentByOrderNumber(orderNumber: string): Promise<CardSettlementResult> {
  if (!orderNumber) return { outcome: "not_applicable", detail: "Sin número de pedido" };

  const order: any = await Order.findOne({ orderNumber }).populate("user").populate("branch");
  if (!order) return { outcome: "not_applicable", detail: `No existe ${orderNumber}` };
  if (order.paymentMethod !== "card") return { outcome: "not_applicable", order, detail: "El pedido no es con tarjeta" };

  // Cancelada (pago rechazado antes o cancelación del local): no se consulta nada y se le dice claro.
  if (order.status === "cancelled") return { outcome: "rejected", order, detail: "El pedido está cancelado" };
  // Ya cobrada: ni se molesta a PayPhone. Sirve igual para el segundo "pagado" del cliente y
  // para el caso en que el navegador ya cerro el pago antes de que escriba.
  if (isSettled(order)) return { outcome: "already_paid", order };

  const clientTxId = order.payphone?.clientTransactionId;
  if (!clientTxId) return { outcome: "error", order, detail: "El pedido no tiene clientTransactionId de PayPhone" };

  const sale = await getPayphoneSaleByClientTxId(clientTxId);

  const decision = decideFromSale(sale);
  if (decision.next === "pending") return { outcome: "pending", order, detail: decision.detail };
  if (decision.next === "rejected") return { outcome: "rejected", order, detail: decision.detail };

  let payphoneResult: any;
  try {
    // La fase de confirmación obligatoria (evita el auto-reverso de los 5 minutos).
    payphoneResult = await confirmPayphoneTransaction(decision.transactionId, clientTxId);
  } catch (error) {
    return { outcome: "error", order, detail: error instanceof Error ? error.message : "No se pudo confirmar con PayPhone" };
  }

  // Carrera con el /pay-response del navegador: se relee la orden justo antes de cerrarla.
  // Si el navegador gano, esta ya quedo pagada y aqui no se duplica nada.
  const fresh: any = await Order.findOne({ orderNumber }).populate("user").populate("branch");
  if (!fresh) return { outcome: "not_applicable", detail: `No existe ${orderNumber}` };
  if (isSettled(fresh)) return { outcome: "already_paid", order: fresh };

  const verdict = evaluatePayphoneResult(fresh, payphoneResult, clientTxId);
  if (verdict === "approved") {
    await settleApprovedCardOrder(fresh, payphoneResult, clientTxId);
    return { outcome: "paid_now", order: fresh };
  }
  if (verdict === "mismatch") {
    await recordPayphoneMismatch(fresh, payphoneResult, clientTxId);
    return { outcome: "mismatch", order: fresh, detail: `Aprobado por ${payphoneResult?.amount} (total ${fresh.total})` };
  }

  // La consulta dijo aprobada y la confirmación la niega: puede ser un rechazo real, pero también una
  // respuesta a medias. Desde el chat NO se cancela el pedido (dejarlo cancelado con la tarjeta cobrada es
  // peor que esperar): se deja pendiente para que el navegador o el local lo resuelvan.
  console.warn(`[pago] ${orderNumber}: la consulta decía aprobada y la confirmación devolvió "${payphoneResult?.transactionStatus || "no aprobado"}". El pedido queda pendiente.`);
  return { outcome: "pending", order: fresh, detail: `PayPhone: ${payphoneResult?.transactionStatus || "no aprobado"}` };
}

/** Ya cobrada: el estado dejó de ser `pending` o PayPhone ya dejó su transactionId/confirmedAt. */
function isSettled(order: any) {
  // Una orden cancelada nunca es "pagada", aunque PayPhone haya dejado su rastro.
  if (order.status === "cancelled") return false;
  return Boolean(order.status !== "pending" || order.payphone?.transactionId || order.payphone?.confirmedAt);
}
