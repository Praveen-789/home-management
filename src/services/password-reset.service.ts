import bcrypt from "bcrypt";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { AppError } from "../lib/errors.js";
import { mailer } from "../lib/mailer.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";

export const CODE_LENGTH = 6;
export const CODE_TTL_MINUTES = 15;
// A six-digit code is guessable, so each one allows only a few wrong tries before it dies.
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MIN_PASSWORD_LENGTH = 8;
// bcrypt ignores anything past 72 bytes, so longer passwords would silently lose their tail.
export const MAX_PASSWORD_LENGTH = 72;

// One message for every way a code can be wrong, so the response never says which check failed.
export const INVALID_CODE = "Invalid or expired code";

const messages: TransactionMessages = {
  conflict: "Password reset conflicts with another request",
  missing: "Account no longer exists",
  retriesExhausted: "Password reset changed concurrently; please retry",
};

// Six digits from the CSPRNG, zero-padded so 000123 is as likely as any other.
export const generateCode = (): string => String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");

export const hashCode = (code: string): string => createHash("sha256").update(code).digest("hex");

const hashesMatch = (stored: string, candidate: string): boolean => {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(candidate, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const resetEmail = (name: string, code: string): string =>
  `Hi ${name},\n\nYour HomeHub password reset code is:\n\n${code}\n\n` +
  `Enter it in the app within ${CODE_TTL_MINUTES} minutes. If you did not ask to reset your password, ` +
  `you can ignore this email and your password will stay as it is.`;

// What happened, for logs and tests. The HTTP response is the same in every case so that the
// endpoint cannot be used to find out which addresses are registered.
export type ResetRequestOutcome = "sent" | "unknown-email" | "cooldown";

// Issues a fresh code for the account behind `email`, replacing any earlier one, and emails it.
export async function requestPasswordReset(email: string, now = new Date()): Promise<ResetRequestOutcome> {
  const prepared = await withSerializableTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, select: { id: true, name: true, password: true } });
    if (!user || !user.password) return null;

    const latest = await tx.passwordReset.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (latest && now.getTime() - latest.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) return "cooldown";

    // One live code per account: a new request retires whatever came before it.
    const code = generateCode();
    await tx.passwordReset.deleteMany({ where: { userId: user.id } });
    await tx.passwordReset.create({
      data: { userId: user.id, codeHash: hashCode(code), expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000) },
    });
    return { user, code };
  }, messages);

  if (prepared === null) return "unknown-email";
  if (prepared === "cooldown") return "cooldown";

  try {
    await mailer.send({ to: email, subject: "Your HomeHub password reset code", text: resetEmail(prepared.user.name, prepared.code) });
  } catch (error) {
    console.error("Could not send the password reset email", error);
    // Retire the unsent code so the person can ask again straight away instead of waiting out the cooldown.
    await withSerializableTransaction((tx) => tx.passwordReset.deleteMany({ where: { userId: prepared.user.id } }), messages).catch(() => {});
    throw new AppError("Could not send the email. Please try again later.", 503);
  }
  return "sent";
}

// Sets a new password when the code is the live one for the account. A wrong code counts against
// the code's attempts; that count must survive, so the transaction reports the outcome rather than
// throwing, and the error is raised only after it has committed.
export async function resetPassword(email: string, code: string, password: string, now = new Date()): Promise<void> {
  // Hashed before looking anything up so a wrong email costs the same time as a wrong code.
  const passwordHash = await bcrypt.hash(password, 10);

  const outcome = await withSerializableTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, select: { id: true, password: true } });
    if (!user || !user.password) return "invalid";

    const reset = await tx.passwordReset.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, codeHash: true, expiresAt: true, attempts: true },
    });
    if (!reset || reset.expiresAt.getTime() <= now.getTime() || reset.attempts >= MAX_ATTEMPTS) return "invalid";

    if (!hashesMatch(reset.codeHash, hashCode(code))) {
      await tx.passwordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
      return "wrong";
    }

    await tx.user.update({ where: { id: user.id }, data: { password: passwordHash } });
    await tx.passwordReset.update({ where: { id: reset.id }, data: { usedAt: now } });
    return "ok";
  }, messages);

  if (outcome !== "ok") {
    throw new AppError(INVALID_CODE, 400);
  }
}
