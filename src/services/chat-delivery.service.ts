import { randomUUID } from "node:crypto";
import type { ChatDelivery, Prisma } from "../../generated/prisma/client.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";
import { emitChatEvent } from "../lib/chat-events.js";
import { getExpoReceipt, PushError, sendExpoPush } from "../lib/expo-push.js";
import { conversationSummary, messagePreview, messageSelect, requireConversation, toMessageView } from "./chat.service.js";

const MAX_ATTEMPTS = 8;
const PUSH_MAX_AGE = 60 * 60_000;
const RECEIPT_DELAY = 15 * 60_000;

export async function claimDelivery(pushEnabled: boolean): Promise<ChatDelivery | undefined> {
  const leaseId = randomUUID();
  const now = new Date();
  const jobs = await prisma.$queryRaw<ChatDelivery[]>`
    WITH candidate AS (
      SELECT id FROM "ChatDelivery"
      WHERE "completedAt" IS NULL AND "failedAt" IS NULL AND "availableAt" <= ${now}
        AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now})
        AND (kind = 'LIVE' OR ${pushEnabled})
      ORDER BY "availableAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE "ChatDelivery" AS job SET "leaseId" = ${leaseId},
        "leaseUntil" = ${new Date(Date.now() + 60_000)}, attempts = attempts + 1
      FROM candidate WHERE job.id = candidate.id RETURNING job.*`;
  return jobs[0];
}

async function updateJob(job: ChatDelivery, data: Prisma.ChatDeliveryUpdateManyMutationInput) {
  // A stale worker cannot overwrite a job reclaimed after its lease expired.
  await prisma.chatDelivery.updateMany({ where: { id: job.id, leaseId: job.leaseId }, data: { ...data, leaseId: null, leaseUntil: null } });
}

export async function processDelivery(job: ChatDelivery) {
  try {
    if (job.ticketId) {
      // Poll existing tickets even when the user has since read/muted the chat.
      const delivered = await getExpoReceipt(job.ticketId);
      if (delivered) { await updateJob(job, { completedAt: new Date(), lastError: null }); return; }
      if (Date.now() - (job.ticketAt?.getTime() ?? job.createdAt.getTime()) > 24 * 60 * 60_000) {
        throw new PushError("ReceiptExpired", false);
      }
      await updateJob(job, { availableAt: new Date(Date.now() + RECEIPT_DELAY), attempts: 0 });
      return;
    }
    if (job.kind === "PUSH" && Date.now() - job.createdAt.getTime() > PUSH_MAX_AGE) {
      await updateJob(job, { completedAt: new Date(), lastError: "ExpiredBeforeSend" });
      return;
    }
    const target = await prisma.$transaction(async tx => {
      const message = await tx.message.findUnique({ where: { id: job.messageId }, select: messageSelect });
      if (!message) return null;
      const conversation = await requireConversation(tx, message.conversationId, job.userId);
      const state = conversation.participants.find(p => p.userId === job.userId);
      const hidden = await tx.messageDeletion.findUnique({
        where: { messageId_userId: { messageId: message.id, userId: job.userId } }, select: { messageId: true },
      });
      // Hidden by "Delete for me", or swept away by the user's "Clear chat".
      if (hidden || message.sequence <= (state?.clearedSequence ?? 0)) return null;
      if (job.kind === "LIVE") {
        const summary = await conversationSummary(tx, conversation.id, job.userId);
        // Emission is synchronous while a membership row lock is held. Removing
        // the member cannot commit between the authorization check and emit.
        // A crash can replay this event; clients deduplicate by message.id.
        emitChatEvent(job.userId, "chat:message", {
          message: toMessageView(message), unreadCount: summary.unreadCount, lastReadSequence: summary.lastReadSequence,
          muted: summary.muted, alert: message.senderId !== job.userId && !summary.muted && summary.lastReadSequence < message.sequence,
        });
        return null;
      }
      if (message.deletedAt) return null;
      if (message.senderId === job.userId || state?.muted || (state?.lastReadSequence ?? 0) >= message.sequence) return null;
      if (!job.deviceTokenId) return null;
      const device = await tx.deviceToken.findFirst({ where: { id: job.deviceTokenId, userId: job.userId } });
      return device ? {
        token: device.token, platform: device.platform,
        chat: { conversationId: message.conversationId, messageId: message.id, sequence: message.sequence, recipientId: job.userId },
        senderName: message.sender.name,
        messageText: messagePreview(message),
      } : null;
    });
    if (!target) { await updateJob(job, { completedAt: new Date(), lastError: null }); return; }
    // External HTTP is deliberately outside the DB transaction. The operating
    // system controls whether the message preview is visible on the lock screen.
    const ticketId = await sendExpoPush(target.token, target.chat, target.senderName, target.messageText, target.platform);
    await updateJob(job, { ticketId, ticketAt: new Date(), availableAt: new Date(Date.now() + RECEIPT_DELAY), attempts: 0, lastError: null });
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) {
      await updateJob(job, { completedAt: new Date(), lastError: "AccessRevoked" });
      return;
    }
    if (error instanceof PushError && error.code === "DeviceNotRegistered") {
      await prisma.deviceToken.deleteMany({ where: { id: job.deviceTokenId ?? "", userId: job.userId } });
      await updateJob(job, { completedAt: new Date(), lastError: "DeviceNotRegistered" });
      return;
    }
    const failed = job.attempts >= MAX_ATTEMPTS || (error instanceof PushError && !error.retryable);
    await updateJob(job, {
      ...(failed ? { failedAt: new Date() } : { availableAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** job.attempts)) }),
      lastError: error instanceof PushError ? error.code.slice(0, 100) : "DeliveryFailed",
    });
  }
}

// Embedded worker: start only with the actual HTTP server, never on app import.
export function startChatDeliveryWorker() {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let lastCleanup = 0;
  const tick = async () => {
    try {
      for (let i = 0; i < 50 && !stopped; i++) {
        const job = await claimDelivery(process.env["EXPO_PUSH_ENABLED"] === "true");
        if (!job) break;
        await processDelivery(job);
      }
      if (Date.now() - lastCleanup > 60 * 60_000) {
        await prisma.chatDelivery.deleteMany({ where: { OR: [
          { completedAt: { lt: new Date(Date.now() - 7 * 86400_000) } },
          { failedAt: { lt: new Date(Date.now() - 30 * 86400_000) } },
          { kind: "PUSH", ticketId: null, createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } },
        ] } });
        lastCleanup = Date.now();
      }
    } catch {
      console.error("Chat delivery worker could not access its queue; retrying shortly");
    } finally {
      if (!stopped) { timer = setTimeout(run, 1000); timer.unref(); }
    }
  };
  const run = () => { active = tick(); };
  run();
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active; };
}
