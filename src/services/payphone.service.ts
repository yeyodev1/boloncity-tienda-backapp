import axios from "axios";
import { env } from "../config/env";

/**
 * SIMULADOR DE PAGO, SOLO PARA PROBAR. Con PAYPHONE_SIMULATE_APPROVED=1 y APP_ENV distinto de "production",
 * PayPhone no se llama: la consulta dice que la venta está aprobada y la confirmación la aprueba por el monto
 * exacto del pedido. Sirve para recorrer el ciclo completo (pagado → cocina → motorizado → tablero) sin gastar
 * una tarjeta de verdad. En producción esta función devuelve false SIEMPRE, aunque la variable esté puesta.
 */
export function payphoneSimulationOn() {
  return process.env.PAYPHONE_SIMULATE_APPROVED === "1" && env.APP_ENV !== "production";
}

/** Id de transacción falso y estable para un clientTransactionId simulado. */
function simulatedTransactionId(clientTxId: string) {
  let hash = 0;
  for (const char of clientTxId) hash = (hash * 31 + char.charCodeAt(0)) % 900_000_000;
  return 900_000_000 + hash;
}

/** `simulatedAmount` (centavos) solo se usa con la simulación encendida: es el total del pedido a aprobar. */
/** Token con el que se cobra: el de PRUEBAS cuando la orden se creó en modo test, si no el de siempre. */
export function payphoneTokenFor(mode?: string) {
  return mode === "test" && env.PAYPHONE_TEST_TOKEN ? env.PAYPHONE_TEST_TOKEN : env.PAYPHONE_TOKEN;
}

/** ¿El bot debe cobrar en modo PRUEBAS? Necesita el interruptor Y el token de prueba cargado. */
export function botPayphoneTestOn() {
  return process.env.BOT_PAYPHONE_TEST === "1" && Boolean(env.PAYPHONE_TEST_TOKEN);
}

export async function confirmPayphoneTransaction(id: number, clientTxId: string, simulatedAmount?: number, mode?: string) {
  if (payphoneSimulationOn()) {
    const amount = Number(simulatedAmount) || 0;
    console.warn(`[payphone] SIMULACIÓN: se aprueba ${clientTxId} por ${amount} centavos sin llamar a PayPhone`);
    return { transactionId: id, clientTransactionId: clientTxId, transactionStatus: "Approved", statusCode: 3, amount, authorizationCode: "SIMULADO", cardBrand: "VISA", lastDigits: "0000" };
  }

  const token = payphoneTokenFor(mode);
  if (!token) {
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
        Authorization: `Bearer ${token}`,
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

/**
 * Resultado de consultar el ESTADO de una transaccion por nuestro clientTransactionId.
 * `found: false` cubre los dos casos inofensivos: la transaccion no existe (el cliente
 * nunca abrio la Cajita) y no se pudo contactar a PayPhone. NUNCA significa "rechazada":
 * quien llame debe dejar la orden intacta.
 */
export type PayphoneSaleLookup =
  | { found: false; error?: string }
  | {
      found: true;
      statusCode?: number;
      transactionStatus?: string;
      transactionId?: number;
      clientTransactionId?: string;
      amount?: number;
      cardBrand?: string;
      lastDigits?: string;
      authorizationCode?: string;
    };

/**
 * Consulta el estado de una venta por NUESTRO identificador (https://docs.payphone.app/api-sale).
 *
 * GET /api/Sale/client/{clientTransactionId} con el MISMO token con el que se creo la
 * transaccion. Es el unico camino para el bot de WhatsApp: el `id` numerico de PayPhone
 * solo vuelve por el navegador (query `?id=`), y el cliente que paga y cierra la pestana
 * nunca lo entrega.
 *
 * statusCode: 1 = Pendiente · 2 = Rechazada/Cancelada · 3 = Aprobada.
 *
 * OJO — esta consulta NO cierra el pago. La doc del boton por redireccion dice que si el
 * comercio no ejecuta la fase de confirmacion (POST /api/button/V2/Confirm) dentro de los
 * primeros 5 minutos, PayPhone REVIERTE la transaccion automaticamente. Por eso el flujo
 * correcto es: este GET para obtener el `transactionId`, y despues
 * `confirmPayphoneTransaction(transactionId, clientTxId)`.
 *
 * Limite publicado: 30 llamadas por minuto; la doc recomienda no consultar mas de una vez
 * por minuto por transaccion.
 *
 * No lanza nunca: cualquier 4xx, cuerpo raro, timeout o caida de red devuelve `found: false`.
 */
export async function getPayphoneSaleByClientTxId(clientTransactionId: string, mode?: string): Promise<PayphoneSaleLookup> {
  if (payphoneSimulationOn()) {
    console.warn(`[payphone] SIMULACIÓN: ${clientTransactionId} se responde como aprobada`);
    return { found: true, statusCode: 3, transactionStatus: "Approved", transactionId: simulatedTransactionId(clientTransactionId) };
  }
  const lookupToken = payphoneTokenFor(mode);
  if (!lookupToken) return { found: false, error: "PAYPHONE_TOKEN is not configured" };
  if (!clientTransactionId) return { found: false, error: "Sin clientTransactionId" };

  try {
    const response = await axios.get(
      `https://pay.payphonetodoesposible.com/api/Sale/client/${encodeURIComponent(clientTransactionId)}`,
      {
        headers: {
          Authorization: `Bearer ${lookupToken}`,
          "Content-Type": "application/json",
        },
        // Mismo timeout que el resto de integraciones del repo (Picker): un turno de WhatsApp
        // no puede quedarse colgado esperando a PayPhone.
        timeout: 8000,
        // PayPhone responde 4xx con el detalle en el cuerpo; lo queremos leer, no lanzarlo.
        validateStatus: (status) => status < 500,
      }
    );

    const data: any = Array.isArray(response.data) ? response.data[0] : response.data;
    // 4xx o cuerpo de error ({ message, errorCode }): la transaccion no existe todavia.
    if (response.status >= 400 || !data || typeof data !== "object" || data.errorCode !== undefined) {
      return { found: false, error: data?.message || `PayPhone respondio ${response.status}` };
    }
    // Sin statusCode ni transactionStatus no hay nada que interpretar: se trata como no encontrada.
    if (data.statusCode === undefined && data.transactionStatus === undefined) {
      return { found: false, error: "PayPhone no devolvio el estado de la transaccion" };
    }

    return {
      found: true,
      statusCode: typeof data.statusCode === "number" ? data.statusCode : undefined,
      transactionStatus: typeof data.transactionStatus === "string" ? data.transactionStatus : undefined,
      transactionId: Number.isFinite(Number(data.transactionId)) && Number(data.transactionId) > 0 ? Number(data.transactionId) : undefined,
      clientTransactionId: typeof data.clientTransactionId === "string" ? data.clientTransactionId : undefined,
      amount: Number.isFinite(Number(data.amount)) ? Number(data.amount) : undefined,
      cardBrand: data.cardBrand,
      lastDigits: data.lastDigits,
      authorizationCode: data.authorizationCode,
    };
  } catch (error) {
    return { found: false, error: error instanceof Error ? error.message : "No se pudo contactar a PayPhone" };
  }
}
