import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { AppError } from "./errors.js";

export const readId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${label} is required`, 400);
  return value.trim();
};

export type HouseholdOperation = (
  req: AuthenticatedRequest,
  res: Response,
  householdId: string,
  requesterId: string,
) => Promise<unknown>;

// Wraps a household-scoped handler: resolves the authenticated user and the
// household ID, turns AppError into its status and message, and hides any other
// failure behind fallbackMessage so internal details never reach the client.
export const handleHouseholdRequest =
  (fallbackMessage: string) =>
  (operation: HouseholdOperation) =>
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.userId) throw new AppError("Authentication is required", 401);
      return await operation(req, res, readId(req.params["householdId"], "Household ID"), req.userId);
    } catch (error) {
      if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message });
      console.error(error);
      return res.status(500).json({ message: fallbackMessage });
    }
  };
