import express from "express";
import cors from "cors";
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

export function createApp() {
  const app = express();

  app.use(cors(corsOptions));
  app.use(express.json({ limit: "50mb" }));

  app.use(async (_req, res, next) => {
    try {
      await dbConnect();
      next();
    } catch {
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
