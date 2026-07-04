import mongoose from "mongoose";
import { env } from "./env";

export async function dbConnect() {
  try {
    await mongoose.connect(env.DB_URI);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}
