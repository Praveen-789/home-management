import { actorName, createNotification } from "./notification.service.js";
import { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import { requireHouseholdMember, requireManageableRole } from "./household-access.service.js";
import type { AssignableRole, MemberTarget } from "./household-member.service.js";
import { userSummary } from "../lib/user-select.js";

// Fields returned to the controller, for the invited user and for the household alike.
// User passwords are never selected.
const invitationSelect = {
  id: true,
  role: true,
  createdAt: true,
  household: { select: { id: true, name: true, pictureUrl: true } },
  invitedUser: userSummary,
  invitedBy: userSummary,
} satisfies Prisma.HouseholdInvitationSelect;

const invitationOrder = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.HouseholdInvitationOrderByWithRelationInput[];

// Nobody joins a household without agreeing to it: an owner or admin invites a
// registered user, and the membership is created only when that user accepts.
export async function inviteHouseholdMember(
  householdId: string,
  requesterId: string,
  target: MemberTarget,
  role: AssignableRole,
) {
  return withInvitationTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    requireManageableRole(requester.role, role);

    // Email is unique, so either lookup resolves to at most one user.
    const user = await tx.user.findUnique({
      where: "userId" in target ? { id: target.userId } : { email: target.email },
      select: { id: true },
    });
    if (!user) throw new AppError("User not found", 404);

    const invitedUserId = user.id;
    const existingMember = await tx.householdMember.findUnique({
      where: { userId_householdId: { userId: invitedUserId, householdId } },
      select: { id: true },
    });
    if (existingMember) throw new AppError("User is already a household member", 409);

    const pending = await tx.householdInvitation.findUnique({
      where: { householdId_invitedUserId: { householdId, invitedUserId } },
      select: { id: true },
    });
    if (pending) throw new AppError("User already has a pending invitation to this household", 409);

    const invitation = await tx.householdInvitation.create({
      data: { householdId, invitedUserId, invitedById: requesterId, role },
      select: invitationSelect,
    });

    // Saved with the invitation: a failed notification insert rolls both back.
    await createNotification({
      userId: invitedUserId,
      type: "HOUSEHOLD_INVITATION",
      title: "Household invitation",
      message: `${invitation.invitedBy.name} wants to add you to ${invitation.household.name} as ${role.toLowerCase()}.`,
      householdId,
      entityId: invitation.id,
    }, tx);

    return invitation;
  });
}

// Any member may see who has been invited; only managers may cancel.
export async function listHouseholdInvitations(householdId: string, requesterId: string) {
  return withInvitationTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    return tx.householdInvitation.findMany({
      where: { householdId },
      select: invitationSelect,
      orderBy: invitationOrder,
    });
  });
}

export async function cancelHouseholdInvitation(householdId: string, requesterId: string, invitationId: string) {
  return withInvitationTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const invitation = await tx.householdInvitation.findFirst({
      where: { id: invitationId, householdId },
      select: { id: true, role: true },
    });
    if (!invitation) throw new AppError("Invitation not found", 404);

    // The same matrix as inviting: an admin cannot cancel an owner's admin invitation.
    requireManageableRole(requester.role, invitation.role);
    await tx.householdInvitation.delete({ where: { id: invitation.id } });
  });
}

export async function listMyInvitations(userId: string) {
  return withInvitationTransaction((tx) =>
    tx.householdInvitation.findMany({
      where: { invitedUserId: userId },
      select: invitationSelect,
      orderBy: invitationOrder,
    }));
}

export async function acceptInvitation(userId: string, invitationId: string) {
  return withInvitationTransaction(async (tx) => {
    const invitation = await requireMyInvitation(tx, userId, invitationId);
    const { householdId } = invitation;

    // The inviter may have been demoted or removed since. Their invitation is honoured only
    // while they could still send it, so a removed admin leaves no open doors behind.
    const inviter = await tx.householdMember.findUnique({
      where: { userId_householdId: { userId: invitation.invitedById, householdId } },
      select: { role: true },
    });
    const stillValid = inviter?.role === "OWNER" || (inviter?.role === "ADMIN" && invitation.role === "MEMBER");
    if (!stillValid) throw new AppError("This invitation is no longer valid. You can decline it.", 409);

    const member = await tx.householdMember.create({
      data: { householdId, userId, role: invitation.role },
      select: { id: true, role: true, user: userSummary },
    });
    await tx.householdInvitation.delete({ where: { id: invitation.id } });

    await createNotification({
      userId: invitation.invitedById,
      type: "MEMBER_JOINED",
      title: "Invitation accepted",
      message: `${await actorName(tx, userId)} accepted your invitation to ${invitation.household.name}.`,
      householdId,
    }, tx);

    return { member, household: invitation.household };
  });
}

export async function declineInvitation(userId: string, invitationId: string) {
  return withInvitationTransaction(async (tx) => {
    const invitation = await requireMyInvitation(tx, userId, invitationId);
    const { householdId } = invitation;
    await tx.householdInvitation.delete({ where: { id: invitation.id } });

    // A former member must not receive new information about the household.
    const inviter = await tx.householdMember.findUnique({
      where: { userId_householdId: { userId: invitation.invitedById, householdId } },
      select: { id: true },
    });
    if (inviter) {
      await createNotification({
        userId: invitation.invitedById,
        type: "INVITATION_DECLINED",
        title: "Invitation declined",
        message: `${await actorName(tx, userId)} declined your invitation to ${invitation.household.name}.`,
        householdId,
      }, tx);
    }
  });
}

// Filtering by both IDs keeps another user's invitation indistinguishable from a missing one.
async function requireMyInvitation(tx: Prisma.TransactionClient, userId: string, invitationId: string) {
  const invitation = await tx.householdInvitation.findFirst({
    where: { id: invitationId, invitedUserId: userId },
    select: { id: true, householdId: true, invitedById: true, role: true, household: { select: { id: true, name: true } } },
  });
  if (!invitation) throw new AppError("Invitation not found", 404);
  return invitation;
}

const invitationMessages: TransactionMessages = {
  conflict: "User is already a member or already invited",
  missing: "Household, user, or invitation no longer exists",
  retriesExhausted: "Invitations changed concurrently; please retry",
};

const withInvitationTransaction = <Result>(
  operation: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> => withSerializableTransaction(operation, invitationMessages);
