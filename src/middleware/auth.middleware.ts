import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/jwt.js";

export type AuthenticatedRequest = Request & { userId?: string };

export const authenticate = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  const match = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];

  if (!token) {
    return res.status(401).json({ message: "Bearer token is required" });
  }

  try {
    req.userId = verifyToken(token).userId;
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  next();
};
