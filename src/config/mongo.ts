import mongoose from "mongoose";
import { env } from "./env";

let cachedConnection: typeof mongoose | null = null;

export async function dbConnect() {
  if (cachedConnection) return cachedConnection;
  if (mongoose.connection.readyState >= 1) {
    cachedConnection = mongoose;
    return cachedConnection;
  }
  try {
    cachedConnection = await mongoose.connect(env.DB_URI);
    console.log("Connected to MongoDB");
    return cachedConnection;
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw error;
  }
}
