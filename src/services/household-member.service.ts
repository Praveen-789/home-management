import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import {
  requireHouseholdMember,
  requireManageableRole,
  requireMemberManagement,
} from "./household-access.service.js";

export type AssignableRole = "ADMIN" | "MEMBER";

// The user to add, identified by ID or by the email they registered with.
export type MemberTarget = { userId: string } | { email: string };

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
  target: MemberTarget,
  role: AssignableRole,
) {
  return withMembershipTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    requireManageableRole(requester.role, role);

    // Email is unique, so either lookup resolves to at most one user.
    const user = await tx.user.findUnique({
      where: "userId" in target ? { id: target.userId } : { email: target.email },
      select: { id: true },
    });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    const userId = user.id;
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
const membershipMessages: TransactionMessages = {
  conflict: "User is already a household member",
  missing: "User or household member no longer exists",
  retriesExhausted: "Membership changed concurrently; please retry",
};

const withMembershipTransaction = <Result>(
  operation: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> => withSerializableTransaction(operation, membershipMessages);
