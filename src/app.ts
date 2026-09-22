import express from "express";
import cors from "cors";
import multer from "multer";
import http from "http";
import routerApi from "./routes";
import { dbConnect } from "./config/mongo";
import { globalErrorHandler } from "./middlewares/globalErrorHandler.middleware";

const whitelist = [
  "http://localhost:8100",
  "http://localhost:8080",
  "http://localhost:5173",
  "https://localhost:5173",
  "http://localhost:5174",
  "http://localhost:8101",
  "https://testing-storybrand-frontend.bakano.ec",
  "https://boloncity-tienda.netlify.app",
  "https://boloncity.com",
  "https://www.boloncity.com",
  "https://dev.boloncity.com",
  "https://api.boloncity.com",
  "https://boloncity-tienda-backapp.vercel.app",
  "https://boloncity-tienda-frontapp.vercel.app",
  // Alias estables del entorno de desarrollo (deploys preview)
  "https://boloncity-api-dev.vercel.app",
  "https://boloncity-tienda-dev.vercel.app",
  "https://boloncity-dev.vercel.app",
  ...(process.env.EXTRA_CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

// Los deploys de preview de Vercel usan un host distinto en cada build.
const originPatterns = [/^https:\/\/boloncity-tienda-(front|back)app-[a-z0-9-]+\.vercel\.app$/];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || whitelist.includes(origin) || originPatterns.some((re) => re.test(origin))) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
};

/**
 * Endpoints que llama BuilderBot (servidor a servidor). BuilderBot trata cualquier 4xx/5xx como error del
 * nodo y el cliente se queda sin respuesta, así que aquí todo responde 200 con un mensaje de respaldo.
 */
// Express compara rutas sin distinguir mayúsculas: /WHATSAPP-BOT/ también llega a los controladores del bot,
// así que la comparación aquí tampoco las distingue (si no, esa variante se saltaba X-Bot-Token).
export const isBotPath = (path: string) => {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* ruta mal codificada: se compara tal cual */
  }
  return decoded.toLowerCase().includes("/whatsapp-bot/");
};
const BOT_FALLBACK = {
  success: false,
  intencion: "conversar",
  telefonoSoporte: "+593 99 315 7333",
  route: "conversation",
  message: "Tuve un problema procesando tu mensaje. ¿Me lo repites?",
  missingData: [],
};

export function createApp() {
  const app = express();

  // BuilderBot no es un navegador: sin CORS en sus rutas (antes un Origin fuera de la lista daba 500).
  app.use((req, res, next) => (isBotPath(req.path) ? next() : cors(corsOptions)(req, res, next)));
  app.use(express.json({ limit: "50mb" }));
  // "Body con campos" de BuilderBot puede llegar como formulario si el nodo no manda Content-Type JSON.
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(express.text({ type: "text/plain", limit: "1mb" }));
  // multipart/form-data (nodo HTTP en modo "form-data"): en las rutas del bot se leen solo los campos de texto.
  // Si viene un archivo, multer falla: se sigue con lo que se pudo leer (el bot solo lee texto y ubicaciones).
  const botMultipart = multer({ limits: { fieldSize: 1024 * 1024, fields: 50 } }).none();
  app.use((req, res, next) => {
    if (!isBotPath(req.path) || !req.is("multipart/form-data")) return next();
    botMultipart(req, res, (error?: unknown) => {
      if (error) console.warn(`[whatsapp-bot] multipart en ${req.path} no se pudo leer completo: ${error instanceof Error ? error.message : error}`);
      if (!req.body || typeof req.body !== "object") req.body = {};
      next();
    });
  });
  app.use((req, _res, next) => {
    // text/plain con un JSON adentro (nodo HTTP sin header).
    if (isBotPath(req.path) && typeof req.body === "string") {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        req.body = {};
      }
    }
    next();
  });

  // JSON inválido (RAW encendido y el cliente escribió comillas): en las rutas del bot, 200 con respaldo.
  app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isBotPath(req.path) && (error?.type === "entity.parse.failed" || error instanceof SyntaxError)) {
      console.error(`[whatsapp-bot] body inválido en ${req.path}: ${error.message}. Revisa que el nodo HTTP use "Body con campos" (RAW apagado)`);
      res.status(200).json(BOT_FALLBACK);
      return;
    }
    next(error);
  });

  // Secreto compartido opcional: si WHATSAPP_BOT_SECRET existe, BuilderBot debe mandar el header X-Bot-Token.
  // Sin él, cualquiera que sepa un teléfono podría consultar el pedido de esa persona.
  app.use((req, res, next) => {
    const secret = process.env.WHATSAPP_BOT_SECRET;
    if (!secret || !isBotPath(req.path)) return next();
    const token = String(req.headers["x-bot-token"] || req.query.token || "");
    if (token === secret) return next();
    console.warn(`[whatsapp-bot] ${req.path} sin X-Bot-Token válido`);
    res.status(200).json({ ...BOT_FALLBACK, message: "" });
  });

  app.use(async (req, res, next) => {
    try {
      await dbConnect();
      next();
    } catch {
      if (isBotPath(req.path)) {
        res.status(200).json(BOT_FALLBACK);
        return;
      }
      res.status(503).json({ message: "Database connection failed" });
    }
  });

  app.get("/", (_req, res) => {
    res.send("Server is alive");
  });

  routerApi(app);

  app.use(globalErrorHandler);

  const server = http.createServer(app);

  return { app, server };
}
