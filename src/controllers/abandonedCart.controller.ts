import { Request, Response } from "express";
import { AbandonedCart } from "../models/AbandonedCart";
import {
  enviarRecordatoriosPendientes,
  linkDeRecuperacion,
  mensajeDeRecuperacion,
  metricasDeCarritos,
  trackCart,
} from "../services/abandonedCart.service";

/**
 * POST /api/carts/track — la web avisa como va el carrito.
 *
 * Publico a proposito: lo llama gente que todavia no se identifico, que es justamente a quien
 * queremos recuperar. No devuelve datos de nadie, solo confirma; asi no sirve para espiar.
 */
export async function trackAbandonedCart(req: Request, res: Response) {
  const carrito = await trackCart(req.body || {});
  if (!carrito) {
    res.json({ tracked: false });
    return;
  }
  res.json({ tracked: true, token: carrito.token, status: carrito.status });
}

/**
 * GET /api/carts/recover/:token — devuelve el carrito para rearmarlo en la web.
 *
 * Ademas marca `clickedAt`, que es la metrica "personas que regresaron desde el mensaje".
 * Se cuenta la PRIMERA apertura como la buena y se llevan las repeticiones aparte, para que
 * reenviarse el link a uno mismo no infle el indicador.
 */
export async function recoverCart(req: Request, res: Response) {
  const carrito = await AbandonedCart.findOne({ token: String(req.params.token || "") }).populate("items.product");
  if (!carrito) {
    res.status(404).json({ message: "Ese carrito ya no está disponible" });
    return;
  }

  if (carrito.status !== "recovered") {
    if (!carrito.clickedAt) carrito.set("clickedAt", new Date());
    carrito.set("clickCount", (carrito.clickCount || 0) + 1);
    carrito.set("lastActivityAt", new Date());
    await carrito.save();
  }

  res.json({
    token: carrito.token,
    status: carrito.status,
    customerName: carrito.customerName,
    customerEmail: carrito.customerEmail,
    customerPhone: carrito.customerPhone,
    branch: carrito.branch,
    subtotal: carrito.subtotal,
    items: carrito.items,
    /** Ya compro: la web debe decirlo en vez de rearmar un carrito viejo. */
    yaComprado: carrito.status === "recovered",
  });
}

/** GET /api/carts/metrics?desde=&hasta= — el embudo completo para el tablero. */
export async function getCartMetrics(req: Request, res: Response) {
  const desde = req.query.desde ? new Date(String(req.query.desde)) : undefined;
  const hasta = req.query.hasta ? new Date(String(req.query.hasta)) : undefined;
  res.json(await metricasDeCarritos(desde, hasta));
}

/** GET /api/carts — el listado para el tablero, del mas reciente al mas viejo. */
export async function listAbandonedCarts(req: Request, res: Response) {
  const limite = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const filtro: Record<string, unknown> = {};
  if (req.query.status) filtro.status = String(req.query.status);

  const carritos = await AbandonedCart.find(filtro).sort({ lastActivityAt: -1 }).limit(limite).populate("branch", "name");
  res.json(
    carritos.map((c) => ({
      id: c._id,
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      customerEmail: c.customerEmail,
      items: c.items.length,
      subtotal: c.subtotal,
      stage: c.stage,
      status: c.status,
      lastActivityAt: c.lastActivityAt,
      notifiedAt: c.notifiedAt,
      notifyError: c.notifyError,
      clickedAt: c.clickedAt,
      recoveredOrderNumber: c.recoveredOrderNumber,
      recoveredTotal: c.recoveredTotal,
      recoveredFromLink: c.recoveredFromLink,
      link: linkDeRecuperacion(c.token),
      branch: (c.branch as any)?.name || "",
    }))
  );
}

/**
 * GET|POST /api/carts/cron/reminders — la corrida del cron de Vercel.
 *
 * Protegido con CRON_SECRET: la ruta es publica en internet y sin eso cualquiera podria
 * disparar los envios a discrecion (y gastar la cuota de mensajes de Meta).
 */
export async function runCartReminders(req: Request, res: Response) {
  const esperado = process.env.CRON_SECRET;
  if (esperado) {
    const auth = req.headers.authorization || "";
    const enviado = auth.replace(/^Bearer\s+/i, "") || String(req.query.secret || "");
    if (enviado !== esperado) {
      res.status(401).json({ message: "No autorizado" });
      return;
    }
  }

  const resumen = await enviarRecordatoriosPendientes();
  console.log("[carritos] recordatorios:", JSON.stringify(resumen));
  res.json(resumen);
}

/**
 * POST /api/carts/:id/test-message — reenvio manual desde el tablero.
 * Sirve para probar el canal sin esperar al cron, y para rescatar a mano un carrito jugoso.
 */
export async function sendCartTestMessage(req: Request, res: Response) {
  const carrito = await AbandonedCart.findById(req.params.id);
  if (!carrito) {
    res.status(404).json({ message: "Carrito no encontrado" });
    return;
  }

  const { sendWhatsapp } = await import("../services/whatsappSender.service");
  const resultado = await sendWhatsapp({
    phone: carrito.customerPhone,
    message: mensajeDeRecuperacion(carrito.customerName, carrito.token),
  });

  if (resultado.sent) {
    carrito.set("status", carrito.status === "pending" ? "notified" : carrito.status);
    carrito.set("notifiedAt", carrito.notifiedAt || new Date());
    carrito.set("notifyCount", (carrito.notifyCount || 0) + 1);
    carrito.set("notifyChannel", resultado.channel);
    carrito.set("notifyError", "");
  } else {
    carrito.set("notifyError", resultado.error || "No se pudo enviar");
  }
  await carrito.save();

  res.status(resultado.sent ? 200 : 502).json(resultado);
}
