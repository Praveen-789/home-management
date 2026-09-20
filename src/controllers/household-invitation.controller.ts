import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readId } from "../lib/controller.js";
import { readRole } from "./household-member.controller.js";
import type { MemberTarget } from "../services/household-member.service.js";
import * as invitationService from "../services/household-invitation.service.js";

const FALLBACK = "Household invitation operation failed";

// Exactly one of userId or email is accepted so a request never names two different users.
const readTarget = (body: unknown): MemberTarget => {
  const { userId, email } = (body ?? {}) as { userId?: unknown; email?: unknown };
  if (userId !== undefined && email !== undefined) throw new AppError("Provide either a user ID or an email address, not both", 400);
  if (email !== undefined) return { email: readId(email, "Email address") };
  if (userId !== undefined) return { userId: readId(userId, "User ID") };
  throw new AppError("User ID or email address is required", 400);
};

// ---- Household side: /api/households/:householdId/invitations ----

const handle = handleHouseholdRequest(FALLBACK);

export const listForHousehold = handle(async (_req, res, householdId, requesterId) => {
  const invitations = await invitationService.listHouseholdInvitations(householdId, requesterId);
  return res.status(200).json({ message: "Household invitations fetched successfully", invitations });
});

export const invite = handle(async (req, res, householdId, requesterId) => {
  const invitation = await invitationService.inviteHouseholdMember(householdId, requesterId, readTarget(req.body), readRole(req.body?.role, true));
  return res.status(201).json({ message: "Invitation sent successfully", invitation });
});

export const cancel = handle(async (req, res, householdId, requesterId) => {
  await invitationService.cancelHouseholdInvitation(householdId, requesterId, readId(req.params["invitationId"], "Invitation ID"));
  return res.status(200).json({ message: "Invitation cancelled successfully" });
});

// ---- Invited user's side: /api/invitations ----
// The token identifies whose invitations these are, never the body.

type UserOperation = (req: AuthenticatedRequest, res: Response, userId: string) => Promise<unknown>;

const handleUser = (operation: UserOperation) => async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.userId) throw new AppError("Authentication is required", 401);
    return await operation(req, res, req.userId);
  } catch (error) {
    if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message });
    console.error(error);
    return res.status(500).json({ message: FALLBACK });
  }
};

export const listMine = handleUser(async (_req, res, userId) => {
  const invitations = await invitationService.listMyInvitations(userId);
  return res.status(200).json({ message: "Invitations fetched successfully", invitations });
});

export const accept = handleUser(async (req, res, userId) => {
  const result = await invitationService.acceptInvitation(userId, readId(req.params["id"], "Invitation ID"));
  return res.status(200).json({ message: "Invitation accepted successfully", ...result });
});

export const decline = handleUser(async (req, res, userId) => {
  await invitationService.declineInvitation(userId, readId(req.params["id"], "Invitation ID"));
  return res.status(200).json({ message: "Invitation declined successfully" });
});
