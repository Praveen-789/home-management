import { Prisma } from "../../generated/prisma/client.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { createUploadTicket, imageStorage, isImageIn, pictureFolder, profileImageUrl } from "../lib/cloudinary.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import { requireHouseholdMember, requirePictureManagement } from "./household-access.service.js";

// A household as the app lists it. The member's own role is added next to these fields.
const householdFields = { id: true, name: true, createdAt: true, pictureUrl: true } as const;

export const createHousehold = async (name: string, userId: string) => {
  try {
    // Nested writes are atomic: a failed membership also rolls back the household.
    return await prisma.household.create({
      data: {
        name: name.trim(),
        createdBy: { connect: { id: userId } },
        members: {
          create: {
            user: { connect: { id: userId } },
            role: "OWNER",
          },
        },
      },
      include: { members: true },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError("You already have a household with this name", 409);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new AppError("Authenticated user no longer exists", 401);
    }

    throw error;
  }
};

export async function listHouseholds(userId: string) {
  const memberships = await prisma.householdMember.findMany({
    where: { userId },
    select: {
      role: true,
      household: {
        select: householdFields,
      },
    },
    orderBy: [{ household: { createdAt: "desc" } }, { householdId: "asc" }],
  });

  return memberships.map((membership) => ({ ...membership.household, role: membership.role }));
}

const pictureMessages: TransactionMessages = {
  conflict: "Picture update conflicts with another",
  missing: "Household or member no longer exists",
  retriesExhausted: "Household changed concurrently; please retry",
};

// Authorizes one upload straight to Cloudinary, into the household's picture folder.
export async function requestPictureUpload(householdId: string, requesterId: string) {
  return withSerializableTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    requirePictureManagement(requester.role);
    return createUploadTicket(pictureFolder(householdId));
  }, pictureMessages);
}

// Points the household at an uploaded file, or at nothing when publicId is null. The file that was
// there before is deleted from Cloudinary only after the change is committed.
async function changePicture(householdId: string, requesterId: string, publicId: string | null) {
  const { household, previous } = await withSerializableTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    requirePictureManagement(requester.role);
    const current = await tx.household.findUnique({ where: { id: householdId }, select: { picturePublicId: true } });
    if (!current) throw new AppError("Household not found or access denied", 404);
    const updated = await tx.household.update({
      where: { id: householdId },
      data: { picturePublicId: publicId, pictureUrl: publicId ? profileImageUrl(publicId, "auto") : null },
      select: householdFields,
    });
    // The same shape the list returns, so the app can replace its copy of this household.
    return { household: { ...updated, role: requester.role }, previous: current.picturePublicId };
  }, pictureMessages);
  if (previous && previous !== publicId) void imageStorage.destroy([previous]);
  return household;
}

export async function setHouseholdPicture(householdId: string, requesterId: string, publicId: string) {
  // The folder holds the household's ID, so a file signed for another household is refused.
  if (!isImageIn(pictureFolder(householdId), publicId)) throw new AppError("Image does not belong to this household", 400);
  return changePicture(householdId, requesterId, publicId);
}

export const removeHouseholdPicture = (householdId: string, requesterId: string) =>
  changePicture(householdId, requesterId, null);
