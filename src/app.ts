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
  "https://boloncity-tienda-backapp.vercel.app",
];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || whitelist.includes(origin)) {
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
