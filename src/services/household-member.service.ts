import { Prisma } from "../../generated/prisma/client.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import {
  requireHouseholdMember,
  requireManageableRole,
  requireMemberManagement,
} from "./household-access.service.js";

export type AssignableRole = "ADMIN" | "MEMBER";

// Fields returned to the controller. User passwords are never selected.
const memberSelect = {
  id: true,
  role: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} satisfies Prisma.HouseholdMemberSelect;

export async function listHouseholdMembers(
  householdId: string,
  requesterId: string,
) {
  return withMembershipTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);

    return tx.householdMember.findMany({
      where: { householdId },
      select: memberSelect,
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
    });
  });
}

export async function addHouseholdMember(
  householdId: string,
  requesterId: string,
  userId: string,
  role: AssignableRole,
) {
  return withMembershipTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    requireManageableRole(requester.role, role);

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    const existingMember = await tx.householdMember.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });

    if (existingMember) {
      throw new AppError("User is already a household member", 409);
    }

    return tx.householdMember.create({
      data: { householdId, userId, role },
      select: memberSelect,
    });
  });
}

export async function updateHouseholdMember(
  householdId: string,
  requesterId: string,
  userId: string,
  role: AssignableRole,
) {
  return withMembershipTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    requireMemberManagement(requester.role);

    const targetMember = await requireTargetMember(tx, householdId, userId);

    // Check permission for both the current role and the requested role.
    requireManageableRole(requester.role, targetMember.role);
    requireManageableRole(requester.role, role);

    return tx.householdMember.update({
      where: { userId_householdId: { userId, householdId } },
      data: { role },
      select: memberSelect,
    });
  });
}

export async function removeHouseholdMember(
  householdId: string,
  requesterId: string,
  userId: string,
) {
  return withMembershipTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    requireMemberManagement(requester.role);

    const targetMember = await requireTargetMember(tx, householdId, userId);
    requireManageableRole(requester.role, targetMember.role);

    if (requesterId === userId) {
      throw new AppError("Self-removal is not supported", 403);
    }

    await tx.householdMember.delete({
      where: { userId_householdId: { userId, householdId } },
    });
  });
}

async function requireTargetMember(
  tx: Prisma.TransactionClient,
  householdId: string,
  userId: string,
) {
  const member = await tx.householdMember.findUnique({
    where: { userId_householdId: { userId, householdId } },
    select: { id: true, role: true },
  });

  if (!member) {
    throw new AppError("Household member not found", 404);
  }

  return member;
}

// Shared transaction handling. Result preserves the return type of each operation.
async function withMembershipTransaction<Result>(
  operation: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
        throw error;
      }

      // A conflict retries the whole operation, including permission checks.
      if (error.code === "P2034") {
        continue;
      }

      if (error.code === "P2002") {
        throw new AppError("User is already a household member", 409);
      }

      if (error.code === "P2025" || error.code === "P2003") {
        throw new AppError("User or household member no longer exists", 404);
      }

      throw error;
    }
  }

  throw new AppError("Membership changed concurrently; please retry", 409);
}
