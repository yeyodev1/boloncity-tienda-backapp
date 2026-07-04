import { Request } from "express";

export interface JwtPayload {
  userId: string;
  email: string;
  accountType: string;
  branches?: string[];
  allBranches?: boolean;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  branchFilter?: Record<string, unknown>;
  activeBranch?: string | null;
}
