import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models/User";

export function generateTempPassword() {
  return Math.random().toString(36).slice(-10) + "A1!";
}

export async function createAutoUser(input: { email: string; name?: string; phone?: string; documentId?: string }) {
  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) return { user: existing, tempPassword: null };

  const tempPassword = generateTempPassword();
  const user = await User.create({
    email: input.email.toLowerCase(),
    password: tempPassword,
    name: input.name || "",
    phone: input.phone || "",
    documentId: input.documentId || "",
    accountType: "customer",
    branches: [],
    allBranches: false,
  });

  return { user, tempPassword };
}

export async function verifyPassword(plain: string, hashed: string) {
  return bcrypt.compare(plain, hashed);
}

export function signUserToken(payload: { userId: string; email: string; accountType: string; branches?: string[]; allBranches?: boolean }) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "30d" });
}
