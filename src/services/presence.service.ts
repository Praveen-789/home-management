import prisma from "../lib/prisma.js";
import { PresenceRegistry } from "../lib/presence.js";
import { emitChatEvent } from "../lib/chat-events.js";

const pending = new Map<string, Promise<void>>();
const unsaved = new Map<string, Date>();
function enqueue(userId: string, operation: () => Promise<void>) {
  const previous = pending.get(userId) ?? Promise.resolve();
  const next = previous.then(operation).catch(() => {
    console.error("Chat presence update failed; retrying at the next checkpoint");
  });
  pending.set(userId, next);
  void next.then(() => { if (pending.get(userId) === next) pending.delete(userId); });
}

async function saveSeen(userId: string, at: Date) {
  const latest = unsaved.get(userId);
  if (!latest || latest < at) unsaved.set(userId, at);
  // Monotonic writes also protect against older checkpoints.
  await prisma.user.updateMany({
    where: { id: userId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: at } }] },
    data: { lastSeenAt: at },
  });
  if (unsaved.get(userId) === at) unsaved.delete(userId);
}

export const presence = new PresenceRegistry((userId, isOnline, at) => {
  enqueue(userId, async () => {
    await saveSeen(userId, at);
    // Lock current memberships until emission so removal cannot race delivery.
    await prisma.$transaction(async tx => {
      const members = await tx.$queryRaw<{ userId: string }[]>`
        SELECT DISTINCT "userId" FROM "HouseholdMember" WHERE "householdId" IN
          (SELECT "householdId" FROM "HouseholdMember" WHERE "userId" = ${userId})`;
      for (const member of members) {
        const shared = await tx.$queryRaw<{ id: string }[]>`
          SELECT recipient.id FROM "HouseholdMember" AS recipient
          JOIN "HouseholdMember" AS subject ON subject."householdId" = recipient."householdId"
          WHERE recipient."userId" = ${member.userId} AND subject."userId" = ${userId}
          FOR SHARE OF recipient, subject`;
        if (shared.length) emitChatEvent(member.userId, "chat:presence", {
          userId, isOnline, lastSeenAt: isOnline ? null : at.toISOString(), updatedAt: new Date().toISOString(),
        });
      }
    });
  });
});

export function startPresenceCheckpoint() {
  const timer = setInterval(() => {
    const at = new Date();
    const updates = new Map(unsaved);
    for (const userId of presence.onlineUsers()) updates.set(userId, at);
    for (const [userId, seenAt] of updates) enqueue(userId, () => saveSeen(userId, seenAt));
  }, 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    presence.close();
    await Promise.all(pending.values());
  };
}

export async function drainPresence() { await Promise.all(pending.values()); }
