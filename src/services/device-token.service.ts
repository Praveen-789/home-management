import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { chatTransaction } from "../lib/chat-transaction.js";

export function validateExpoToken(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(value)) {
    throw new AppError("A valid Expo push token is required", 400);
  }
  return value;
}

export function registerDevice(userId: string, token: string, platform: string) {
  return chatTransaction(async tx => {
    const existing = await tx.deviceToken.findUnique({ where: { token } });
    // A shared phone may log in as a different user. Drop old pending jobs and
    // create a new registration so previous-account alerts cannot follow it.
    if (existing && existing.userId !== userId) await tx.deviceToken.delete({ where: { id: existing.id } });
    if ((!existing || existing.userId !== userId) && await tx.deviceToken.count({ where: { userId } }) >= 20) {
      throw new AppError("Too many registered devices; remove an old device first", 409);
    }
    return tx.deviceToken.upsert({
      where: { token }, update: { platform }, create: { userId, token, platform },
      select: { id: true, platform: true, updatedAt: true },
    });
  });
}

export async function unregisterDevice(userId: string, deviceId: string) {
  await prisma.deviceToken.deleteMany({ where: { id: deviceId, userId } });
}
