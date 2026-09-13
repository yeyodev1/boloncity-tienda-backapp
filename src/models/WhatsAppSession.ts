import mongoose, { Schema } from "mongoose";

/**
 * Conversación de WhatsApp de un teléfono. `state` es el estado del router del bot
 * (carrito, paso actual, elección pendiente, datos de entrega y pago). Ver
 * services/whatsappBot/router.ts. Se borra sola 24 h después del último mensaje.
 */
export interface IWhatsAppSession {
  /** Teléfono en E.164 ("+593987654321"). */
  phone: string;
  history: Array<{ role: "user" | "assistant"; content: string; createdAt: Date }>;
  state?: Record<string, unknown> | null;
  lastMessageHash?: string;
  lastMessageAt?: Date;
  /** Última respuesta enviada: se reenvía si BuilderBot repite el mismo mensaje por un reintento. */
  lastReply?: string;
  /** Evita que dos "confirmo" simultáneos creen dos órdenes. */
  checkoutLockUntil?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const sessionSchema = new Schema<IWhatsAppSession>(
  {
    phone: { type: String, required: true, unique: true, index: true },
    history: [
      {
        role: { type: String, enum: ["user", "assistant"], required: true },
        content: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    state: { type: Schema.Types.Mixed, default: null },
    lastMessageHash: String,
    lastMessageAt: Date,
    lastReply: String,
    checkoutLockUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

sessionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

export const WhatsAppSession = mongoose.models.WhatsAppSession || mongoose.model<IWhatsAppSession>("WhatsAppSession", sessionSchema);
