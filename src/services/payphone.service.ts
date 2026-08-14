import axios from "axios";
import { env } from "../config/env";

export async function confirmPayphoneTransaction(id: number, clientTxId: string) {
  if (!env.PAYPHONE_TOKEN) {
    throw new Error("PAYPHONE_TOKEN is not configured");
  }

  const response = await axios.post(
    "https://pay.payphonetodoesposible.com/api/button/V2/Confirm",
    {
      id,
      clientTxId,
    },
    {
      headers: {
        Authorization: `Bearer ${env.PAYPHONE_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
}

export interface PayphoneReverseResult {
  ok: boolean;
  errorCode?: number;
  message?: string;
}

/**
 * Reverso de un pago aprobado (https://docs.payphone.app/api-reverse).
 *
 * Reglas de PayPhone que condicionan el resto del flujo:
 * - solo el mismo dia de la transaccion, hasta las 20:00 EC;
 * - siempre por el total, no admite reversos parciales;
 * - debe usarse el mismo token con el que se creo la transaccion.
 *
 * Respuesta exitosa: `true`. Fallida: `{ message, errorCode }`.
 */
export async function reversePayphoneTransaction(
  identifier: { transactionId: number } | { clientTransactionId: string }
): Promise<PayphoneReverseResult> {
  if (!env.PAYPHONE_TOKEN) {
    throw new Error("PAYPHONE_TOKEN is not configured");
  }

  const byTransactionId = "transactionId" in identifier;
  const url = byTransactionId
    ? "https://pay.payphonetodoesposible.com/api/Reverse"
    : "https://pay.payphonetodoesposible.com/api/Reverse/Client";
  const body = byTransactionId
    ? { id: Number(identifier.transactionId) }
    : { clientId: identifier.clientTransactionId };

  try {
    const response = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${env.PAYPHONE_TOKEN}`,
        "Content-Type": "application/json",
      },
      // PayPhone responde 4xx con el detalle del error; lo queremos leer, no lanzarlo.
      validateStatus: (status) => status < 500,
    });

    const data = response.data;
    if (data === true || data?.transactionStatus === "Reversed") {
      return { ok: true };
    }
    return {
      ok: false,
      errorCode: typeof data?.errorCode === "number" ? data.errorCode : undefined,
      message: data?.message || `PayPhone respondio ${response.status} sin confirmar el reverso`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "No se pudo contactar a PayPhone",
    };
  }
}
