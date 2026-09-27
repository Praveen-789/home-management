import bcrypt from "bcrypt";
import { verifyGoogleToken } from "../lib/google-auth.js";
import { signToken } from "../lib/jwt.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction } from "../lib/transaction.js";
import { userFields } from "../lib/user-select.js";

const publicUser = userFields;
const transactionMessages = {
  conflict: "Account changed or already exists; please retry or sign in to your existing account",
  missing: "Account no longer exists",
  retriesExhausted: "Account changed concurrently; please retry",
};

export async function signInWithGoogle(idToken: unknown) {
  const googleUser = await verifyGoogleToken(idToken);

  const result = await withSerializableTransaction(async (tx) => {
    // Google's stable subject identifies the account, even if its email changes.
    const linkedUser = await tx.user.findUnique({
      where: { googleId: googleUser.googleId }, select: publicUser,
    });
    if (linkedUser) return { user: linkedUser, isNewUser: false };

    // Existing local accounts are case-sensitive. Check all case variants here
    // to avoid silently making a second account or taking over an existing one.
    const emailOwner = await tx.user.findFirst({
      where: { email: { equals: googleUser.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (emailOwner) {
      throw new AppError("Sign in to your existing account first, then link Google", 409);
    }

    const user = await tx.user.create({
      data: { name: googleUser.name, email: googleUser.email, googleId: googleUser.googleId },
      select: publicUser,
    });
    return { user, isNewUser: true };
  }, transactionMessages);

  return { ...result, token: signToken({ userId: result.user.id, email: result.user.email }) };
}

export async function linkGoogleAccount(userId: string, idToken: unknown, password: unknown) {
  // Linking adds another way to sign in, so require the current local password
  // as well as the HomeHub token. A stolen old session alone is insufficient.
  if (typeof password !== "string" || !password || password.length > 72) {
    throw new AppError("Current password is required", 400);
  }
  const googleUser = await verifyGoogleToken(idToken);

  return withSerializableTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError("Account no longer exists", 401);
    if (!user.password || !(await bcrypt.compare(password, user.password))) {
      throw new AppError("Invalid current password", 401);
    }
    if (user.email.trim().toLowerCase() !== googleUser.email) {
      throw new AppError("Google email must match your HomeHub email", 409);
    }
    if (user.googleId && user.googleId !== googleUser.googleId) {
      throw new AppError("A different Google account is already linked", 409);
    }
    const googleOwner = await tx.user.findUnique({
      where: { googleId: googleUser.googleId }, select: { id: true },
    });
    if (googleOwner && googleOwner.id !== userId) {
      throw new AppError("Google account is already linked to another user", 409);
    }

    // Preserve the user ID, password, and all existing household data.
    return tx.user.update({
      where: { id: userId }, data: { googleId: googleUser.googleId }, select: publicUser,
    });
  }, transactionMessages);
}
