import { Request, Response } from "express";
import { User } from "../models/User";
import { signUserToken, verifyPassword } from "../services/auth.service";
import { AuthRequest } from "../types/AuthRequest";

export async function login(req: Request, res: Response) {
  const { email, password } = req.body as { email: string; password: string };
  const user = await User.findOne({ email: email.toLowerCase() }).select("+password").populate("branches");
  if (!user) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const ok = await verifyPassword(password, user.password);
  if (!ok) {
    res.status(401).json({ message: "Invalid credentials" });
    return;
  }

  const token = signUserToken({
    userId: String(user._id),
    email: user.email,
    accountType: user.accountType,
    branches: user.branches.map((branch: any) => String(branch._id || branch)),
    allBranches: user.allBranches,
  });
  const safeUser = await User.findById(user._id).select("-password").populate("branches");
  res.json({ token, user: safeUser });
}

export async function register(req: Request, res: Response) {
  const user = await User.create(req.body);
  const token = signUserToken({
    userId: String(user._id),
    email: user.email,
    accountType: user.accountType,
    branches: user.branches.map((branch: any) => String(branch._id || branch)),
    allBranches: user.allBranches,
  });
  const safeUser = await User.findById(user._id).select("-password").populate("branches");
  res.status(201).json({ token, user: safeUser });
}

export async function me(req: AuthRequest, res: Response) {
  const userId = req.user?.userId;
  const user = await User.findById(userId).select("-password").populate("branches");
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json(user);
}
