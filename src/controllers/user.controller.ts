import { Request, Response } from "express";
import { User } from "../models/User";
import { AuthRequest } from "../types/AuthRequest";

export async function listUsers(req: AuthRequest, res: Response) {
  const branchFilter = req.branchFilter?.branch;
  const query = branchFilter
    ? { $or: [{ allBranches: true }, { branches: branchFilter }] }
    : { accountType: { $in: ["admin", "branch_admin", "customer"] } };

  const users = await User.find(query)
    .select("-password")
    .populate("branches")
    .sort({ createdAt: -1 });
  res.json(users);
}

export async function getUserById(req: AuthRequest, res: Response) {
  const branchFilter = req.branchFilter?.branch;
  const user = await User.findOne({ _id: req.params.id, ...(branchFilter ? { $or: [{ allBranches: true }, { branches: branchFilter }] } : {}) })
    .select("-password")
    .populate("branches");
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json(user);
}

export async function createUser(req: Request, res: Response) {
  const user = await User.create({
    ...req.body,
    branches: req.body.branches || [],
    allBranches: !!req.body.allBranches,
  });

  const safeUser = await User.findById(user._id).select("-password").populate("branches");
  res.status(201).json(safeUser);
}

export async function deleteUser(req: AuthRequest, res: Response) {
  if (req.params.id === req.user?.userId) {
    res.status(403).json({ message: "Cannot delete yourself" });
    return;
  }

  const user = await User.findByIdAndDelete(req.params.id);

  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json({ message: "User deleted" });
}

export async function updateUser(req: Request, res: Response) {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    {
      ...req.body,
      branches: req.body.branches || [],
      allBranches: !!req.body.allBranches,
    },
    { new: true }
  )
    .select("-password")
    .populate("branches");

  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  res.json(user);
}
