import mongoose, { Schema } from "mongoose";

/**
 * Bitácora del bot de WhatsApp: una fila por mensaje con lo que llegó, qué decidió el router y qué se
 * respondió, o el error. Sirve para revisar conversaciones reales (`npm run bot:logs`). Se borra sola a los 30 días.
 */
export interface IBotLog {
  phone: string;
  endpoint: string;
  message: string;
  reply: string;
  decision: string;
  step: string;
  route: string;
  /** Ruta que devolvió /brain (solo enruta) para que BuilderBot elija el flujo. */
  routed?: string;
  orderNumber?: string;
  /** La IA reescribió la respuesta con la voz del bot (o se mandó la plantilla). */
  aiVoice?: boolean;
  media?: string;
  ms: number;
  error?: string;
  createdAt?: Date;
}

const botLogSchema = new Schema<IBotLog>(
  {
    phone: { type: String, index: true, default: "" },
    endpoint: { type: String, default: "" },
    message: { type: String, default: "" },
    reply: { type: String, default: "" },
    decision: { type: String, default: "" },
    step: { type: String, default: "" },
    route: { type: String, default: "" },
    routed: { type: String },
    orderNumber: { type: String },
    aiVoice: { type: Boolean },
    media: { type: String },
    ms: { type: Number, default: 0 },
    error: { type: String },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
  },
  { versionKey: false }
);

export const BotLog = mongoose.models.BotLog || mongoose.model<IBotLog>("BotLog", botLogSchema);
