import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readId } from "../lib/controller.js";
import { listHouseholdMembers, removeHouseholdMember, updateHouseholdMember, type AssignableRole } from "../services/household-member.service.js";

export const readRole = (value: unknown, defaultMember = false): AssignableRole => {
  if (value === undefined && defaultMember) return "MEMBER";
  if (value !== "ADMIN" && value !== "MEMBER") throw new AppError("Role must be ADMIN or MEMBER", 400);
  return value;
};

const handle = handleHouseholdRequest("Household member operation failed");

export const list = handle(async (_req, res, householdId, requesterId) => {
  const members = await listHouseholdMembers(householdId, requesterId);
  return res.status(200).json({ message: "Household members fetched successfully", members });
});

export const updateRole = handle(async (req, res, householdId, requesterId) => {
  const member = await updateHouseholdMember(householdId, requesterId, readId(req.params["userId"], "User ID"), readRole(req.body?.role));
  return res.status(200).json({ message: "Household member role updated successfully", member });
});

export const remove = handle(async (req, res, householdId, requesterId) => {
  await removeHouseholdMember(householdId, requesterId, readId(req.params["userId"], "User ID"));
  return res.status(200).json({ message: "Household member removed successfully" });
});
