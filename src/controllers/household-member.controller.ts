import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { AppError } from "../lib/errors.js";
import { addHouseholdMember, listHouseholdMembers, removeHouseholdMember, updateHouseholdMember, type AssignableRole } from "../services/household-member.service.js";

const readId = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new AppError(`${label} is required`, 400);
  return value.trim();
};

const readRole = (value: unknown, defaultMember = false): AssignableRole => {
  if (value === undefined && defaultMember) return "MEMBER";
  if (value !== "ADMIN" && value !== "MEMBER") throw new AppError("Role must be ADMIN or MEMBER", 400);
  return value;
};

type Operation = (req: AuthenticatedRequest, res: Response, householdId: string, requesterId: string) => Promise<unknown>;
const handle = (operation: Operation) => async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) throw new AppError("Authentication is required", 401);
    return await operation(req, res, readId(req.params["householdId"], "Household ID"), req.userId);
  } catch (error) {
    if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message });
    console.error(error);
    return res.status(500).json({ message: "Household member operation failed" });
  }
};

export const list = handle(async (_req, res, householdId, requesterId) => {
  const members = await listHouseholdMembers(householdId, requesterId);
  return res.status(200).json({ message: "Household members fetched successfully", members });
});

export const add = handle(async (req, res, householdId, requesterId) => {
  const member = await addHouseholdMember(householdId, requesterId, readId(req.body?.userId, "User ID"), readRole(req.body?.role, true));
  return res.status(201).json({ message: "Household member added successfully", member });
});

export const updateRole = handle(async (req, res, householdId, requesterId) => {
  const member = await updateHouseholdMember(householdId, requesterId, readId(req.params["userId"], "User ID"), readRole(req.body?.role));
  return res.status(200).json({ message: "Household member role updated successfully", member });
});

export const remove = handle(async (req, res, householdId, requesterId) => {
  await removeHouseholdMember(householdId, requesterId, readId(req.params["userId"], "User ID"));
  return res.status(200).json({ message: "Household member removed successfully" });
});
