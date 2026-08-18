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

/**
 * Clientes (accountType "customer") con sus puntos acumulados. Para el panel de
 * fidelidad: buscar por nombre/correo/teléfono y ordenar por puntos.
 */
export async function listCustomers(req: AuthRequest, res: Response) {
  const search = String(req.query.search || "").trim();
  const query: Record<string, unknown> = { accountType: "customer" };
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const customers = await User.find(query)
    .select("name email phone points pointsHistory createdAt")
    .sort({ points: -1, createdAt: -1 })
    .limit(500)
    .lean();

  const totalPoints = customers.reduce((sum, c) => sum + (c.points || 0), 0);
  res.json({
    customers: customers.map((c) => ({
      _id: c._id,
      name: c.name || "",
      email: c.email,
      phone: c.phone || "",
      points: c.points || 0,
      movements: Array.isArray(c.pointsHistory) ? c.pointsHistory.length : 0,
      lastMovement: Array.isArray(c.pointsHistory) && c.pointsHistory.length
        ? c.pointsHistory[c.pointsHistory.length - 1]
        : null,
      createdAt: c.createdAt,
    })),
    summary: { count: customers.length, totalPoints },
  });
}

export async function getCustomerPoints(req: AuthRequest, res: Response) {
  const customer = await User.findOne({ _id: req.params.id, accountType: "customer" })
    .select("name email phone points pointsHistory")
    .lean<{ _id: unknown; name?: string; email: string; phone?: string; points?: number; pointsHistory?: Array<{ amount: number; reason?: string; date?: Date }> }>();
  if (!customer) {
    res.status(404).json({ message: "Cliente no encontrado" });
    return;
  }
  const history = Array.isArray(customer.pointsHistory) ? [...customer.pointsHistory].reverse() : [];
  res.json({
    _id: customer._id,
    name: customer.name || "",
    email: customer.email,
    phone: customer.phone || "",
    points: customer.points || 0,
    history,
  });
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
