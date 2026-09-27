import type { HouseholdRole, Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";

export const requireHouseholdMember = async (
  db: Prisma.TransactionClient,
  householdId: string,
  userId: string,
) => {
  const member = await db.householdMember.findUnique({
    where: { userId_householdId: { userId, householdId } },
    select: { id: true, role: true },
  });
  if (!member) throw new AppError("Household not found or access denied", 404);
  return member;
};

export const requireMemberManagement = (role: HouseholdRole) => {
  if (role === "MEMBER") throw new AppError("You cannot manage household members", 403);
};

// The picture represents the whole household, so it follows the same rule as managing members.
export const requirePictureManagement = (role: HouseholdRole) => {
  if (role === "MEMBER") throw new AppError("Only owners and admins can change the household picture", 403);
};

export const requireManageableRole = (actor: HouseholdRole, target: HouseholdRole) => {
  requireMemberManagement(actor);
  if (target === "OWNER") {
    throw new AppError("Ownership cannot be changed through member management", 403);
  }
  if (actor === "ADMIN" && target !== "MEMBER") {
    throw new AppError("Admins can only manage members with the MEMBER role", 403);
  }
};
