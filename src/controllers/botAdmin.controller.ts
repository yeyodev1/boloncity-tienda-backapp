import { Response } from "express";
import { BotLog } from "../models/BotLog";
import { Order } from "../models/Order";
import { WhatsAppSession } from "../models/WhatsAppSession";
import { AuthRequest } from "../types/AuthRequest";
import { normalizePhone } from "../utils/phone";

/**
 * Panel "Chats del bot": conversaciones de WhatsApp tal como las vivió el cliente, con lo que decidió el bot en cada
 * turno (BotLog, 30 días) y los pedidos que salieron de ahí. Solo lectura. Lo ven administración y el equipo de
 * sucursal (pedido del dueño: los colaboradores también pueden revisar los chats).
 */

const DAY_MS = 86_400_000;

/** Rango de fechas del query (?from=YYYY-MM-DD&to=YYYY-MM-DD, hora de Ecuador). Por defecto, los últimos 7 días. */
function readRange(query: any) {
  const parse = (value: unknown, endOfDay: boolean) => {
    const text = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}-05:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const to = parse(query?.to, true) || new Date();
  const from = parse(query?.from, false) || new Date(to.getTime() - 7 * DAY_MS);
  return { from, to };
}

/** Las órdenes guardan el teléfono en varios formatos: se buscan todos. */
function phoneVariants(value: string) {
  const phone = normalizePhone(value);
  if (!phone) return [value];
  return [phone.e164, `${phone.code}${phone.number}`, `0${phone.number}`, phone.number, `+${phone.code} ${phone.number}`];
}

/** GET /api/bot-admin/metrics: cuánto se habló con el bot y cuánto vendió WhatsApp en el rango. */
export async function getBotMetrics(req: AuthRequest, res: Response) {
  try {
    const { from, to } = readRange(req.query);
    const logMatch = { createdAt: { $gte: from, $lte: to }, decision: { $ne: "R0:duplicado" } };
    const [logStats] = await BotLog.aggregate([
      { $match: logMatch },
      {
        $group: {
          _id: null,
          messages: { $sum: 1 },
          phones: { $addToSet: "$phone" },
          avgMs: { $avg: "$ms" },
          aiVoice: { $sum: { $cond: ["$aiVoice", 1, 0] } },
          errors: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$error", ""] } }, 0] }, 1, 0] } },
          humanPhones: { $addToSet: { $cond: [{ $eq: ["$decision", "R2:humano"] }, "$phone", null] } },
          optOuts: { $sum: { $cond: [{ $eq: ["$decision", "R2:opt_out"] }, 1, 0] } },
          offTopic: { $sum: { $cond: [{ $eq: ["$decision", "R11:fuera_de_tema"] }, 1, 0] } },
          notUnderstood: { $sum: { $cond: [{ $in: ["$decision", ["R11:no_entendido", "R11:ayuda"]] }, 1, 0] } },
        },
      },
    ]);
    const orders: any[] = await Order.find({ createdAt: { $gte: from, $lte: to } }).select("source status total customerPhone").lean();
    const whatsapp = orders.filter((order) => order.source === "whatsapp");
    const paid = whatsapp.filter((order) => !["pending", "cancelled"].includes(order.status));
    const phones: string[] = logStats?.phones || [];
    const buyers = new Set(whatsapp.map((order) => normalizePhone(order.customerPhone)?.e164 || order.customerPhone).filter(Boolean));
    const converted = phones.filter((phone) => buyers.has(phone)).length;
    res.json({
      from,
      to,
      conversations: phones.length,
      messages: logStats?.messages || 0,
      avgResponseMs: Math.round(logStats?.avgMs || 0),
      aiVoiceShare: logStats?.messages ? Math.round(((logStats.aiVoice || 0) / logStats.messages) * 100) : 0,
      errors: logStats?.errors || 0,
      humanHandoffs: (logStats?.humanPhones || []).filter(Boolean).length,
      optOuts: logStats?.optOuts || 0,
      offTopic: logStats?.offTopic || 0,
      notUnderstood: logStats?.notUnderstood || 0,
      whatsappOrders: whatsapp.length,
      whatsappPaidOrders: paid.length,
      whatsappRevenue: paid.reduce((sum, order) => sum + (order.total || 0), 0) / 100,
      webOrders: orders.length - whatsapp.length,
      whatsappShare: orders.length ? Math.round((whatsapp.length / orders.length) * 100) : 0,
      conversion: phones.length ? Math.round((converted / phones.length) * 100) : 0,
    });
  } catch (error) {
    console.error("[bot-admin] metrics falló", error);
    res.status(500).json({ message: "No se pudieron leer las métricas del bot" });
  }
}

/** GET /api/bot-admin/conversations: una fila por cliente, con su último mensaje y si compró. */
export async function listBotConversations(req: AuthRequest, res: Response) {
  try {
    const { from, to } = readRange(req.query);
    const search = String(req.query.q || "").replace(/\D/g, "");
    const match: Record<string, unknown> = { createdAt: { $gte: from, $lte: to }, decision: { $ne: "R0:duplicado" } };
    if (search.length >= 3) match.phone = { $regex: search.slice(-9) };
    const rows: any[] = await BotLog.aggregate([
      { $match: match },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: "$phone",
          firstAt: { $first: "$createdAt" },
          lastAt: { $last: "$createdAt" },
          messages: { $sum: 1 },
          lastMessage: { $last: "$message" },
          lastReply: { $last: "$reply" },
          lastDecision: { $last: "$decision" },
          lastStep: { $last: "$step" },
          orders: { $addToSet: "$orderNumber" },
          human: { $max: { $cond: [{ $eq: ["$decision", "R2:humano"] }, 1, 0] } },
          errors: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$error", ""] } }, 0] }, 1, 0] } },
        },
      },
      { $sort: { lastAt: -1 } },
      { $limit: 150 },
    ]);
    const phones = rows.map((row) => row._id).filter(Boolean);
    const sessions: any[] = await WhatsAppSession.find({ phone: { $in: phones } }).select("phone state").lean();
    const sessionByPhone = new Map(sessions.map((session) => [session.phone, session]));
    const orders: any[] = await Order.find({ source: "whatsapp", customerPhone: { $in: phones.flatMap(phoneVariants) } })
      .sort({ createdAt: -1 })
      .select("customerPhone customerName orderNumber status")
      .lean();
    const orderByPhone = new Map<string, any>();
    for (const order of orders) {
      const key = normalizePhone(order.customerPhone)?.e164 || order.customerPhone;
      if (!orderByPhone.has(key)) orderByPhone.set(key, order);
    }
    res.json(
      rows.map((row) => {
        const session: any = sessionByPhone.get(row._id);
        const order = orderByPhone.get(row._id);
        return {
          phone: row._id,
          name: session?.state?.customerName || order?.customerName || "",
          firstAt: row.firstAt,
          lastAt: row.lastAt,
          messages: row.messages,
          lastMessage: row.lastMessage,
          lastReply: row.lastReply,
          lastDecision: row.lastDecision,
          lastStep: row.lastStep,
          orders: (row.orders || []).filter(Boolean),
          lastOrder: order ? { orderNumber: order.orderNumber, status: order.status } : null,
          human: Boolean(row.human),
          errors: row.errors,
          optedOut: Boolean(session?.state?.optedOut),
        };
      })
    );
  } catch (error) {
    console.error("[bot-admin] conversaciones falló", error);
    res.status(500).json({ message: "No se pudieron leer las conversaciones" });
  }
}

/** GET /api/bot-admin/conversations/:phone: el chat completo, el estado actual y sus pedidos por WhatsApp. */
export async function getBotConversation(req: AuthRequest, res: Response) {
  try {
    const raw = String(req.params.phone || "");
    const phone = raw.startsWith("lid:") ? raw : normalizePhone(raw)?.e164 || raw;
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [turns, session, orders] = await Promise.all([
      BotLog.find({ phone, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(600).lean(),
      WhatsAppSession.findOne({ phone }).select("state lastMessageAt").lean(),
      phone.startsWith("lid:")
        ? Promise.resolve([])
        : Order.find({ customerPhone: { $in: phoneVariants(phone) } })
            .sort({ createdAt: -1 })
            .limit(20)
            .select("orderNumber status total createdAt source paymentMethod deliveryType scheduledFor customerName")
            .lean(),
    ]);
    const state: any = (session as any)?.state || null;
    res.json({
      phone,
      name: state?.customerName || (orders as any[])[0]?.customerName || "",
      state: state
        ? {
            stage: state.stage,
            cart: state.cart || [],
            deliveryType: state.deliveryType,
            paymentMethod: state.paymentMethod,
            branchName: state.branchName,
            scheduledLabel: state.scheduledLabel,
            lastOrderNumber: state.lastOrderNumber,
            optedOut: Boolean(state.optedOut),
          }
        : null,
      turns: (turns as any[]).map((turn) => ({
        id: String(turn._id),
        at: turn.createdAt,
        endpoint: turn.endpoint,
        message: turn.message,
        reply: turn.reply,
        decision: turn.decision,
        step: turn.step,
        route: turn.route,
        orderNumber: turn.orderNumber || "",
        aiVoice: Boolean(turn.aiVoice),
        media: turn.media || "",
        ms: turn.ms,
        error: turn.error || "",
      })),
      orders: (orders as any[]).map((order) => ({
        id: String(order._id),
        orderNumber: order.orderNumber,
        status: order.status,
        total: (order.total || 0) / 100,
        createdAt: order.createdAt,
        source: order.source,
        paymentMethod: order.paymentMethod,
        deliveryType: order.deliveryType,
        scheduledFor: order.scheduledFor || null,
      })),
    });
  } catch (error) {
    console.error("[bot-admin] conversación falló", error);
    res.status(500).json({ message: "No se pudo leer la conversación" });
  }
}
