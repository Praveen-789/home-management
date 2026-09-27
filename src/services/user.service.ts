import { avatarFolder, createUploadTicket, imageStorage, isImageIn, profileImageUrl } from "../lib/cloudinary.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import { userFields } from "../lib/user-select.js";

const profileMessages: TransactionMessages = {
  conflict: "Profile update conflicts with another",
  missing: "Account no longer exists",
  retriesExhausted: "Profile changed concurrently; please retry",
};

// The signed-in user as the app shows them. The app calls this to refresh its saved session.
export async function getProfile(userId: string) {
  return withSerializableTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: userFields });
    // A valid token for a deleted account is an authentication problem, not a missing page.
    if (!user) throw new AppError("Account no longer exists", 401);
    return user;
  }, profileMessages);
}

// Authorizes one upload straight to Cloudinary, into the user's own folder.
export async function requestAvatarUpload(userId: string) {
  await getProfile(userId);
  return createUploadTicket(avatarFolder(userId));
}

// Points the profile at an uploaded file, or at nothing when publicId is null. The file that was
// there before is deleted from Cloudinary only after the change is committed.
async function changeAvatar(userId: string, publicId: string | null) {
  const { user, previous } = await withSerializableTransaction(async (tx) => {
    const current = await tx.user.findUnique({ where: { id: userId }, select: { avatarPublicId: true } });
    if (!current) throw new AppError("Account no longer exists", 401);
    const user = await tx.user.update({
      where: { id: userId },
      data: { avatarPublicId: publicId, avatarUrl: publicId ? profileImageUrl(publicId, "face") : null },
      select: userFields,
    });
    return { user, previous: current.avatarPublicId };
  }, profileMessages);
  if (previous && previous !== publicId) void imageStorage.destroy([previous]);
  return user;
}

export async function setAvatar(userId: string, publicId: string) {
  // The folder holds the user's ID, so nobody can adopt a file that was signed for someone else.
  if (!isImageIn(avatarFolder(userId), publicId)) throw new AppError("Image does not belong to this account", 400);
  return changeAvatar(userId, publicId);
}

export const removeAvatar = (userId: string) => changeAvatar(userId, null);
