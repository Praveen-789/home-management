import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readId } from "../lib/controller.js";
import { addHouseholdMember, listHouseholdMembers, removeHouseholdMember, updateHouseholdMember, type AssignableRole, type MemberTarget } from "../services/household-member.service.js";

const readRole = (value: unknown, defaultMember = false): AssignableRole => {
  if (value === undefined && defaultMember) return "MEMBER";
  if (value !== "ADMIN" && value !== "MEMBER") throw new AppError("Role must be ADMIN or MEMBER", 400);
  return value;
};

// Exactly one of userId or email is accepted so a request never names two different users.
const readTarget = (body: unknown): MemberTarget => {
  const { userId, email } = (body ?? {}) as { userId?: unknown; email?: unknown };
  if (userId !== undefined && email !== undefined) throw new AppError("Provide either a user ID or an email address, not both", 400);
  if (email !== undefined) return { email: readId(email, "Email address") };
  if (userId !== undefined) return { userId: readId(userId, "User ID") };
  throw new AppError("User ID or email address is required", 400);
};

const handle = handleHouseholdRequest("Household member operation failed");

export const list = handle(async (_req, res, householdId, requesterId) => {
  const members = await listHouseholdMembers(householdId, requesterId);
  return res.status(200).json({ message: "Household members fetched successfully", members });
});

export const add = handle(async (req, res, householdId, requesterId) => {
  const member = await addHouseholdMember(householdId, requesterId, readTarget(req.body), readRole(req.body?.role, true));
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
