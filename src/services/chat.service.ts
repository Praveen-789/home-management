import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { chatTransaction } from "../lib/chat-transaction.js";

export const messageSelect = {
  id: true, conversationId: true, senderId: true, clientMessageId: true,
  sequence: true, text: true, deletedAt: true, createdAt: true,
  sender: { select: { id: true, name: true } },
} satisfies Prisma.MessageSelect;

export const DELETE_FOR_EVERYONE_WINDOW_MS = 15 * 60_000;
// One request deletes at most this many messages. It bounds the transaction and the size of the
// event sent to every member's devices.
export const MAX_DELETE_BATCH = 50;

export function directKey(first: string, second: string) {
  return JSON.stringify([first, second].sort());
}

// A membership deletion must wait for authorized operations already in flight.
// These locks also protect live delivery from racing with member removal.
export async function lockMembership(tx: Prisma.TransactionClient, householdId: string, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "HouseholdMember" WHERE "householdId" = ${householdId}
      AND "userId" = ${userId} FOR SHARE`;
  if (!rows.length) throw new AppError("Conversation not found or access denied", 404);
}

export async function requireConversation(tx: Prisma.TransactionClient, conversationId: string, userId: string) {
  const conversation = await tx.conversation.findUnique({
    where: { id: conversationId }, include: { participants: true },
  });
  if (!conversation) throw new AppError("Conversation not found or access denied", 404);
  await lockMembership(tx, conversation.householdId, userId);
  if (conversation.type === "DIRECT" && !conversation.participants.some(p => p.userId === userId)) {
    throw new AppError("Conversation not found or access denied", 404);
  }
  return conversation;
}

export function ensureHouseholdConversation(householdId: string, userId: string) {
  return chatTransaction(async tx => {
    await lockMembership(tx, householdId, userId);
    return tx.conversation.upsert({
      where: { householdId_key: { householdId, key: "HOUSEHOLD" } }, update: {},
      create: { householdId, key: "HOUSEHOLD", type: "HOUSEHOLD" },
    });
  });
}

export function ensureDirectConversation(householdId: string, userId: string, recipientId: string) {
  if (userId === recipientId) throw new AppError("Choose another household member", 400);
  return chatTransaction(async tx => {
    for (const id of [userId, recipientId].sort()) await lockMembership(tx, householdId, id);
    const key = directKey(userId, recipientId);
    return tx.conversation.upsert({
      where: { householdId_key: { householdId, key } }, update: {},
      create: {
        householdId, type: "DIRECT", key,
        participants: { create: [{ userId }, { userId: recipientId }] },
      },
    });
  });
}

export async function conversationSummary(tx: Prisma.TransactionClient, conversationId: string, userId: string) {
  const conversation = await requireConversation(tx, conversationId, userId);
  const state = conversation.participants.find(p => p.userId === userId);
  const latestMessage = await tx.message.findFirst({
    where: { conversationId, sequence: { gt: state?.clearedSequence ?? 0 }, hiddenFor: { none: { userId } } },
    orderBy: { sequence: "desc" }, select: messageSelect,
  });
  // Clearing a chat also reads it, so the read position is never behind the cleared one.
  const unreadCount = await tx.message.count({ where: {
    conversationId, senderId: { not: userId }, deletedAt: null,
    sequence: { gt: state?.lastReadSequence ?? 0 }, hiddenFor: { none: { userId } },
  } });
  const members = await tx.householdMember.findMany({
    where: { householdId: conversation.householdId, ...(conversation.type === "DIRECT" ? {
      userId: { in: conversation.participants.map(p => p.userId) },
    } : {}) }, select: { user: { select: { id: true, name: true } } },
  });
  return {
    id: conversation.id, householdId: conversation.householdId, type: conversation.type,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    participants: members.map(m => m.user),
    canSend: conversation.type === "HOUSEHOLD" || members.length === 2,
    latestMessage, unreadCount, lastReadSequence: state?.lastReadSequence ?? 0, muted: state?.muted ?? false,
  };
}

export function getConversation(conversationId: string, userId: string) {
  return chatTransaction(tx => conversationSummary(tx, conversationId, userId));
}

export function listConversations(householdId: string, userId: string, page: number, limit: number) {
  return chatTransaction(async tx => {
    await lockMembership(tx, householdId, userId);
    const where: Prisma.ConversationWhereInput = { householdId, OR: [
      { type: "HOUSEHOLD" }, { type: "DIRECT", participants: { some: { userId } } },
    ] };
    const rows = await tx.conversation.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit });
    const conversations = [];
    for (const row of rows) conversations.push(await conversationSummary(tx, row.id, userId));
    const total = await tx.conversation.count({ where });
    return { conversations, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  });
}

export type MessageQuery = { before?: number; after?: number; limit: number };
export function getMessages(conversationId: string, userId: string, query: MessageQuery) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const ascending = query.after !== undefined;
    // "Clear chat" hides everything at or below the caller's marker, whichever page is asked for.
    const cleared = conversation.participants.find(p => p.userId === userId)?.clearedSequence ?? 0;
    const rows = await tx.message.findMany({
      where: {
        conversationId,
        hiddenFor: { none: { userId } },
        sequence: { ...(query.before !== undefined ? { lt: query.before } : {}), gt: Math.max(cleared, query.after ?? 0) },
      },
      orderBy: { sequence: ascending ? "asc" : "desc" }, take: query.limit + 1, select: messageSelect,
    });
    const hasMore = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    return {
      messages: ascending ? selected : selected.reverse(), hasMore,
      nextBefore: !ascending && hasMore ? selected[0]?.sequence : null,
      nextAfter: ascending && hasMore ? selected.at(-1)?.sequence : null,
      latestSequence: conversation.sequence,
    };
  });
}

// Reconciles deletion-only changes for message rows already held by a client.
// This keeps backgrounded devices correct without polling or re-downloading history.
export function reconcileMessages(conversationId: string, userId: string, messageIds: string[]) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const cleared = conversation.participants.find(p => p.userId === userId)?.clearedSequence ?? 0;
    // Hidden means deleted for the caller, or swept away by their "Clear chat".
    const hidden = await tx.message.findMany({
      where: { id: { in: messageIds }, conversationId, OR: [{ hiddenFor: { some: { userId } } }, { sequence: { lte: cleared } }] },
      select: { id: true },
    });
    const hiddenMessageIds = hidden.map(row => row.id);
    const deletedMessages = await tx.message.findMany({
      where: {
        id: { in: messageIds.filter(id => !hiddenMessageIds.includes(id)) },
        conversationId, deletedAt: { not: null },
      },
      select: messageSelect,
    });
    return { hiddenMessageIds, deletedMessages };
  });
}

export function chatNotificationId(conversationId: string, userId: string) {
  return `chat:${conversationId}:${userId}`;
}

// The inbox alert only points at unread messages, so it is removed once none remain rather than
// kept as read history. The next message's upsert recreates it under the same id.
function clearChatNotification(tx: Prisma.TransactionClient, conversationId: string, userId: string) {
  return tx.notification.deleteMany({ where: { id: chatNotificationId(conversationId, userId), userId } });
}

export function sendMessage(conversationId: string, userId: string, clientMessageId: string, text: string) {
  if (!text.trim() || text.length > 4000) throw new AppError("Message text must contain 1 to 4000 characters", 400);
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const existing = await tx.message.findUnique({
      where: { conversationId_senderId_clientMessageId: { conversationId, senderId: userId, clientMessageId } }, select: messageSelect,
    });
    if (existing) {
      if (existing.text !== text.trim()) throw new AppError("Client message ID was already used for different text", 409);
      return { message: existing, created: false };
    }
    // Database-backed limit survives reconnects and server restarts.
    const recentCount = await tx.message.count({ where: { senderId: userId, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recentCount >= 60) throw new AppError("Too many messages; try again shortly", 429);
    const members = await tx.$queryRaw<{ userId: string }[]>`
      SELECT "userId" FROM "HouseholdMember" WHERE "householdId" = ${conversation.householdId}
      ORDER BY "userId" FOR SHARE`;
    const recipients = members.filter(m => conversation.type === "HOUSEHOLD" || conversation.participants.some(p => p.userId === m.userId));
    if (conversation.type === "DIRECT" && recipients.length !== 2) throw new AppError("Both participants must still belong to the household", 409);
    // Updating a counter inside this transaction gives committed messages a
    // stable, gap-free per-conversation order, including concurrent sends.
    const { sequence } = await tx.conversation.update({ where: { id: conversationId }, data: { sequence: { increment: 1 } }, select: { sequence: true } });
    const message = await tx.message.create({ data: {
      conversationId, senderId: userId, clientMessageId, sequence, text: text.trim(),
    }, select: messageSelect });
    const deliveries: Prisma.ChatDeliveryCreateManyInput[] = [];
    for (const recipient of recipients) {
      const recipientId = recipient.userId;
      deliveries.push({ key: `${message.id}:live:${recipientId}`, kind: "LIVE", messageId: message.id, userId: recipientId });
      const state = conversation.participants.find(p => p.userId === recipientId);
      if (recipientId === userId || state?.muted) continue;
      // Group chat alerts in the existing notification inbox. No message text
      // is copied into alerts, so leaving a household cannot expose old content.
      const notification = { type: "CHAT_MESSAGE", title: "New chat messages", message: "You have unread chat messages", householdId: conversation.householdId, entityId: conversationId, isRead: false };
      await tx.notification.upsert({
        where: { id: chatNotificationId(conversationId, recipientId) },
        create: { id: chatNotificationId(conversationId, recipientId), userId: recipientId, ...notification },
        update: { ...notification, createdAt: new Date() },
      });
      const devices = await tx.deviceToken.findMany({ where: { userId: recipientId }, select: { id: true } });
      for (const device of devices) deliveries.push({
        key: `${message.id}:push:${device.id}`, kind: "PUSH", messageId: message.id,
        userId: recipientId, deviceTokenId: device.id, availableAt: new Date(Date.now() + 5000),
      });
    }
    await tx.chatDelivery.createMany({ data: deliveries });
    return { message, created: true };
  });
}

export type DeleteMessageScope = "me" | "everyone";

// Deletes one message or a batch through the same path. The batch is all or nothing: every check
// runs before the first write, and a failure rolls the transaction back, so a caller never has to
// explain "7 of 10 deleted". Unread counts are worked out once per person, not once per message.
export function deleteMessages(conversationId: string, messageIds: string[], userId: string, scope: DeleteMessageScope) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const messages = await tx.message.findMany({
      where: { id: { in: messageIds }, conversationId }, orderBy: { sequence: "asc" }, select: messageSelect,
    });
    if (messages.length !== messageIds.length) throw new AppError("Message not found", 404);

    if (scope === "me") {
      // Repeating the request is harmless: a message already hidden is skipped.
      await tx.messageDeletion.createMany({ data: messageIds.map(messageId => ({ messageId, userId })), skipDuplicates: true });
      // Prevent a queued live or push job from restoring/alerting a message the
      // user has just hidden. Already-submitted provider notifications cannot be recalled.
      await tx.chatDelivery.updateMany({
        where: { messageId: { in: messageIds }, userId, ticketId: null, completedAt: null, failedAt: null },
        data: { completedAt: new Date(), lastError: "DeletedForUser" },
      });
      const summary = await conversationSummary(tx, conversationId, userId);
      if (!summary.unreadCount) await clearChatNotification(tx, conversationId, userId);
      return {
        deletion: { conversationId, scope, messageIds, messages: [] },
        events: [{ userId, conversation: summary }],
      };
    }

    if (messages.some(message => message.senderId !== userId)) throw new AppError("Only the sender can delete a message for everyone", 403);
    // A message that is already a tombstone stays one, however old it is.
    const remaining = messages.filter(message => !message.deletedAt);
    if (remaining.some(message => Date.now() - message.createdAt.getTime() > DELETE_FOR_EVERYONE_WINDOW_MS)) {
      throw new AppError("Messages can only be deleted for everyone within 15 minutes", 409);
    }
    let deletedMessages = messages;
    if (remaining.length) {
      const remainingIds = remaining.map(message => message.id);
      await tx.message.updateMany({ where: { id: { in: remainingIds } }, data: { text: "", deletedAt: new Date(), deletedById: userId } });
      await tx.chatDelivery.updateMany({
        where: { messageId: { in: remainingIds }, kind: "PUSH", ticketId: null, completedAt: null, failedAt: null },
        data: { completedAt: new Date(), lastError: "DeletedBeforePush" },
      });
      deletedMessages = await tx.message.findMany({ where: { id: { in: messageIds } }, orderBy: { sequence: "asc" }, select: messageSelect });
    }

    const members = await tx.householdMember.findMany({
      where: { householdId: conversation.householdId }, select: { userId: true },
    });
    const recipientIds = members.map(member => member.userId).filter(id =>
      conversation.type === "HOUSEHOLD" || conversation.participants.some(participant => participant.userId === id));
    const events = [];
    for (const recipientId of recipientIds) {
      const summary = await conversationSummary(tx, conversationId, recipientId);
      if (!summary.unreadCount) await clearChatNotification(tx, conversationId, recipientId);
      events.push({ userId: recipientId, conversation: summary });
    }
    return {
      deletion: { conversationId, scope, messageIds, messages: deletedMessages },
      events,
    };
  });
}

// "Clear chat": moves only the caller's marker to the newest message, so their history empties
// while everyone else keeps theirs. One number does the work, however long the chat is. Nothing is
// removed from the Message table, and messages sent afterwards appear as usual.
export function clearConversation(conversationId: string, userId: string) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const current = conversation.participants.find(p => p.userId === userId)?.lastReadSequence ?? 0;
    // The conversation's sequence only grows, so the marker only moves forward. Cleared messages
    // also count as read, which keeps the read position from ever falling behind the marker.
    const clearedSequence = conversation.sequence;
    const lastReadSequence = Math.max(current, clearedSequence);
    await tx.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId, lastReadSequence, clearedSequence }, update: { lastReadSequence, clearedSequence },
    });
    // A queued live or push job must not bring a cleared message back.
    await tx.chatDelivery.updateMany({
      where: { userId, message: { conversationId, sequence: { lte: clearedSequence } }, ticketId: null, completedAt: null, failedAt: null },
      data: { completedAt: new Date(), lastError: "ClearedForUser" },
    });
    const summary = await conversationSummary(tx, conversationId, userId);
    if (!summary.unreadCount) await clearChatNotification(tx, conversationId, userId);
    return { conversationId, clearedSequence, conversation: summary };
  });
}

export function markConversationRead(conversationId: string, userId: string, sequence: number) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    if (sequence > conversation.sequence) throw new AppError("Read position is beyond the last message", 400);
    const current = conversation.participants.find(p => p.userId === userId)?.lastReadSequence ?? 0;
    const lastReadSequence = Math.max(current, sequence);
    await tx.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId, lastReadSequence }, update: { lastReadSequence },
    });
    const unreadCount = await tx.message.count({ where: {
      conversationId, senderId: { not: userId }, deletedAt: null,
      sequence: { gt: lastReadSequence }, hiddenFor: { none: { userId } },
    } });
    if (!unreadCount) await clearChatNotification(tx, conversationId, userId);
    return { conversationId, lastReadSequence, unreadCount };
  });
}

export function setConversationMuted(conversationId: string, userId: string, muted: boolean) {
  return chatTransaction(async tx => {
    await requireConversation(tx, conversationId, userId);
    await tx.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId, muted }, update: { muted },
    });
    return { conversationId, muted };
  });
}
