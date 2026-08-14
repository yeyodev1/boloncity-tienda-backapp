import { createHash } from "crypto";
import { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env";

/**
 * Huella de un secreto: los primeros 12 caracteres de su SHA-256.
 *
 * Sirve para confirmar que un entorno tiene EXACTAMENTE la credencial esperada
 * comparando huellas, sin que el valor viaje nunca en la respuesta. No es
 * reversible y no sirve para autenticarse en ningun lado.
 */
function fingerprint(value?: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "vacio";
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}

/** Host del cluster de Mongo, sin usuario ni contrasena. */
function dbHost(uri: string): string {
  const match = uri.match(/@([^/?]+)/);
  return match?.[1] || "desconocido";
}

/**
 * GET /api/health/config
 *
 * Que entorno esta configurado realmente en este deploy. Vercel oculta el valor de
 * las variables marcadas como sensibles, asi que sin esto no hay forma de comprobar
 * que produccion quedo con las credenciales de produccion.
 */
export function getConfigHealth(_req: Request, res: Response) {
  res.json({
    appEnv: env.APP_ENV,
    nodeEnv: env.NODE_ENV,
    database: {
      host: dbHost(env.DB_URI),
      name: mongoose.connection?.name || null,
      connected: mongoose.connection?.readyState === 1,
    },
    picker: {
      env: env.PICKER_ENV,
      apiBaseUrl: env.PICKER_API_BASE_URL,
      masterKeyFingerprint: fingerprint(env.PICKER_MASTER_KEY),
    },
    payphone: {
      tokenFingerprint: fingerprint(env.PAYPHONE_TOKEN),
      tokenLength: (env.PAYPHONE_TOKEN || "").trim().length,
      // El storeId global ya viaja al navegador en la cajita de pagos: no es secreto.
      globalStoreId: env.PAYPHONE_STORE_ID,
    },
    integrations: {
      resend: Boolean(env.RESEND_API_KEY),
      cloudinary: Boolean(env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_URL),
      googleMaps: Boolean(env.GOOGLE_MAPS_API_KEY),
      gemini: Boolean(env.GEMINI_API_KEY),
      slackErrors: Boolean(env.SLACK_ERROR_WEBHOOK),
    },
    frontendUrl: env.FRONTEND_URLS[env.APP_ENV as keyof typeof env.FRONTEND_URLS] || env.FRONTEND_URLS.local,
  });
}
