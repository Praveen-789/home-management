import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { AppError } from "./errors.js";

export const readId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${label} is required`, 400);
  return value.trim();
};

export const readNullableId = (value: unknown, label: string): string | null =>
  value === null ? null : readId(value, label);

export const readEnum = <Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value => {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as Value;
  throw new AppError(`${label} must be one of ${allowed.join(", ")}`, 400);
};

// Optional text: null clears it, and a blank string is treated the same way.
export const readNullableText = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") throw new AppError(`${label} must be a string or null`, 400);
  return value.trim() || null;
};

const parseDate = (value: unknown): Date | undefined => {
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

export const readDate = (value: unknown, label: string): Date => {
  const date = parseDate(value);
  if (!date) throw new AppError(`${label} must be an ISO 8601 date string`, 400);
  return date;
};

export const readNullableDate = (value: unknown, label: string): Date | null => {
  if (value === null) return null;
  const date = parseDate(value);
  if (!date) throw new AppError(`${label} must be an ISO 8601 date string or null`, 400);
  return date;
};

// Query-string numbers arrive as strings. Only plain digits are accepted, so
// "1.5", "-1", and a repeated parameter (which Express turns into an array)
// are rejected instead of being silently coerced.
export const readInteger = (value: unknown, label: string, min: number, max: number, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) throw new AppError(`${label} must be an integer between ${min} and ${max}`, 400);
  return parsed;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_PAGE = 100_000;

// Paging shared by every list endpoint. page is 1-based.
export type PageQuery = { page: number; limit: number };

export const readPagination = (query: Record<string, unknown>): PageQuery => ({
  page: readInteger(query["page"], "Page", 1, MAX_PAGE, 1),
  limit: readInteger(query["limit"], "Limit", 1, MAX_LIMIT, DEFAULT_LIMIT),
});

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
