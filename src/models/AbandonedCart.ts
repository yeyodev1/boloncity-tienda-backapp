import { Schema, model, Types } from "mongoose";

/**
 * CARRITO ABANDONADO.
 *
 * Un cliente que puso productos en el carrito y dejo sus datos, pero no termino el pedido.
 * Cada documento guarda el embudo completo de ESE carrito, porque las cinco metricas que
 * pide el negocio se responden leyendo este modelo y nada mas:
 *
 *   1. cuantos carritos se abandonaron      → documentos con status distinto de "recovered"
 *   2. cuantos dejaron datos antes de irse  → los que tienen telefono o correo
 *   3. cuantos mensajes se enviaron         → los que tienen notifiedAt
 *   4. cuantos volvieron desde el mensaje   → los que tienen clickedAt
 *   5. cuanto se recupero                   → status "recovered", sumando recoveredTotal
 *
 * No se borra nunca: un carrito recuperado sigue existiendo para poder medir la conversion.
 */

/** Hasta donde llego el cliente antes de irse. Sirve para saber que tan tibio esta el lead. */
export type CartStage =
  /** Puso algo en el carrito y nada mas. */
  | "cart"
  /** Entro al checkout y empezo a llenar sus datos. */
  | "checkout"
  /** Completo nombre, correo y telefono, pero no confirmo. */
  | "contact_ready";

export type CartStatus =
  /** Abandonado y todavia sin mensaje. */
  | "pending"
  /** Se le mando el WhatsApp de recuperacion. */
  | "notified"
  /** Volvio y compro. */
  | "recovered"
  /** Paso demasiado tiempo: ya no se le escribe. */
  | "expired"
  /** No se le puede escribir (sin telefono, o pidio no recibir mensajes). */
  | "unreachable";

export interface IAbandonedCartItem {
  product?: Types.ObjectId | null;
  name: string;
  /** En centavos, igual que en Order: aqui nunca entran dolares. */
  price: number;
  quantity: number;
  image?: string;
}

const itemSchema = new Schema<IAbandonedCartItem>(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", default: null },
    name: { type: String, default: "" },
    price: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },
    image: { type: String, default: "" },
  },
  { _id: false }
);

const abandonedCartSchema = new Schema(
  {
    /**
     * Identifica el navegador del cliente aunque todavia no haya escrito su correo.
     * Sin esto, cada tecla en el checkout creaba un carrito nuevo.
     */
    sessionId: { type: String, required: true, index: true },
    /** Token publico del link de recuperacion. Es lo unico que viaja por WhatsApp. */
    token: { type: String, required: true, unique: true, index: true },

    customerName: { type: String, default: "" },
    /** En E.164 ("+593968434421"), normalizado al guardar: es a donde se manda el WhatsApp. */
    customerPhone: { type: String, default: "", index: true },
    customerEmail: { type: String, default: "", lowercase: true, trim: true, index: true },
    /** Cliente registrado, cuando lo sabemos. */
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },

    items: { type: [itemSchema], default: [] },
    /** Centavos. Solo productos, sin envio: el envio depende de la direccion final. */
    subtotal: { type: Number, default: 0 },
    branch: { type: Schema.Types.ObjectId, ref: "Branch", default: null },

    stage: { type: String, enum: ["cart", "checkout", "contact_ready"], default: "cart" },
    status: { type: String, enum: ["pending", "notified", "recovered", "expired", "unreachable"], default: "pending", index: true },

    /** Ultima senal de vida del carrito. El reloj del abandono se mide desde aqui. */
    lastActivityAt: { type: Date, default: Date.now, index: true },

    // ---- Embudo de recuperacion ----
    /** Cuando salio el WhatsApp. Su existencia ES la metrica "mensajes enviados". */
    notifiedAt: { type: Date, default: null },
    /** Cuantas veces se le escribio. Tope duro para no acosar a nadie. */
    notifyCount: { type: Number, default: 0 },
    /** Por donde salio ("builderbot", "meta"), para auditar el canal. */
    notifyChannel: { type: String, default: "" },
    /** Por que no se pudo mandar. Sin esto, un fallo de canal es invisible. */
    notifyError: { type: String, default: "" },
    /** Cuando abrio el link del mensaje. Es la metrica "volvieron desde el mensaje". */
    clickedAt: { type: Date, default: null },
    clickCount: { type: Number, default: 0 },

    /** Pedido con el que se cerro. */
    recoveredOrder: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    recoveredOrderNumber: { type: String, default: "" },
    recoveredAt: { type: Date, default: null },
    /** Centavos del pedido recuperado: es el "valor de ventas recuperadas". */
    recoveredTotal: { type: Number, default: 0 },
    /**
     * true solo si el cliente habia abierto el link antes de comprar. Separa la venta que
     * de verdad trajo la automatizacion de la que iba a ocurrir igual.
     */
    recoveredFromLink: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/** El cron busca siempre por lo mismo: candidatos a mensaje ordenados por antiguedad. */
abandonedCartSchema.index({ status: 1, lastActivityAt: 1 });

export const AbandonedCart = model("AbandonedCart", abandonedCartSchema);
