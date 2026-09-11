import type { Prisma } from "../../generated/prisma/client.js";
import { createUploadTicket, imageUrls, isHouseholdImage, type ImageFormat } from "../lib/cloudinary.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import { requireHouseholdMember } from "./household-access.service.js";

export const MAX_IMAGES = 5;

// What the app reports after Cloudinary accepted an upload. The public ID is the one the server
// signed; the rest is what Cloudinary said about the stored file.
export type ImageInput = { publicId: string; width: number; height: number; bytes: number; format: ImageFormat };

const userSummary = { select: { id: true, name: true, email: true } } as const;

export const imageSelect = {
  id: true,
  publicId: true,
  width: true,
  height: true,
  bytes: true,
  format: true,
  createdAt: true,
  uploadedBy: userSummary,
} satisfies Prisma.ImageSelect;

// Embedded in the task and expense selects, oldest first so the order matches upload order.
export const imagesSelect = { select: imageSelect, orderBy: { createdAt: "asc" } } as const;

export type ImageRow = Prisma.ImageGetPayload<{ select: typeof imageSelect }>;

// The API shape: the public ID is replaced by the delivery URLs derived from it.
export const toImageView = ({ publicId, ...image }: ImageRow) => ({ ...image, ...imageUrls(publicId) });

export const withImages = <Row extends { images: ImageRow[] }>({ images, ...row }: Row) => ({
  ...row,
  images: images.map(toImageView),
});

// Which parent an image hangs off. Exactly one, which the database also enforces.
export type ImageParent = { taskId: string } | { expenseId: string };

const uploadMessages: TransactionMessages = {
  conflict: "Upload request conflicts with another",
  missing: "Household or member no longer exists",
  retriesExhausted: "Upload requests changed concurrently; please retry",
};

// Authorizes one upload straight to Cloudinary for a member of the household.
export async function requestUpload(householdId: string, requesterId: string) {
  return withSerializableTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    return createUploadTicket(householdId);
  }, uploadMessages);
}

// Records an uploaded file against its parent. The caller has already checked that the requester
// may change the parent. The public ID must be one this server signed for the household.
export async function attachImage(
  tx: Prisma.TransactionClient,
  householdId: string,
  requesterId: string,
  parent: ImageParent,
  input: ImageInput,
): Promise<void> {
  if (!isHouseholdImage(householdId, input.publicId)) {
    throw new AppError("Image does not belong to this household", 400);
  }
  if (await tx.image.findUnique({ where: { publicId: input.publicId }, select: { id: true } })) {
    throw new AppError("This image is already attached", 409);
  }
  if ((await tx.image.count({ where: parent })) >= MAX_IMAGES) {
    throw new AppError(`At most ${MAX_IMAGES} images can be attached`, 400);
  }
  await tx.image.create({ data: { ...input, ...parent, householdId, uploadedById: requesterId } });
}

// Removes an image row and returns its public ID so the caller can delete the file after commit.
export async function detachImage(tx: Prisma.TransactionClient, parent: ImageParent, imageId: string): Promise<string> {
  const image = await tx.image.findFirst({ where: { id: imageId, ...parent }, select: { id: true, publicId: true } });
  if (!image) {
    throw new AppError("Image not found", 404);
  }
  await tx.image.delete({ where: { id: image.id } });
  return image.publicId;
}

// The public IDs a parent's images occupy, collected before the parent is deleted and its rows cascade.
export async function imagePublicIds(tx: Prisma.TransactionClient, parent: ImageParent): Promise<string[]> {
  const images = await tx.image.findMany({ where: parent, select: { publicId: true } });
  return images.map((image) => image.publicId);
}
