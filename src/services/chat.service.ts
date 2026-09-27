import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { chatTransaction } from "../lib/chat-transaction.js";
import { chatFolder, createUploadTicket, imageStorage, isImageIn } from "../lib/cloudinary.js";
import { chatUserSummary } from "../lib/user-select.js";
import { toImageView, type ImageInput } from "./image.service.js";

// A chat photo. Its sender uploaded it, so no separate uploader is listed.
const messageImageSelect = {
  id: true, publicId: true, width: true, height: true, bytes: true, format: true, createdAt: true,
} satisfies Prisma.ImageSelect;

export const messageSelect = {
  id: true, conversationId: true, senderId: true, clientMessageId: true,
  sequence: true, text: true, editedAt: true, deletedAt: true, createdAt: true,
  sender: chatUserSummary,
  images: { select: messageImageSelect, orderBy: { createdAt: "asc" } },
} satisfies Prisma.MessageSelect;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

// The API shape of a message: each photo carries its delivery URLs instead of its public ID.
export const toMessageView = ({ images, ...message }: MessageRow) => ({
  ...message, images: images.map(image => toImageView(image)),
});

// What an alert shows for a message: its text, or a camera and the caption for a photo.
export function messagePreview(message: { text: string; images: unknown[] }) {
  if (!message.images.length) return message.text;
  return message.text ? `📷 ${message.text}` : "📷 Photo";
}

export const MAX_MESSAGE_TEXT = 4000;
// Requests and responses already carry a list of photos, so raising this changes no API shape.
export const MAX_MESSAGE_IMAGES = 1;

export const DELETE_FOR_EVERYONE_WINDOW_MS = 15 * 60_000;
export const EDIT_WINDOW_MS = 15 * 60_000;
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

type AccessibleConversation = Awaited<ReturnType<typeof requireConversation>>;

// Everyone who can currently see the conversation: the household for the shared chat, the pair
// for a private one. joinedAt lets a receipt ignore people who arrived after a message was sent.
function conversationMembers(tx: Prisma.TransactionClient, conversation: AccessibleConversation) {
  return tx.householdMember.findMany({
    where: { householdId: conversation.householdId, ...(conversation.type === "DIRECT" ? {
      userId: { in: conversation.participants.map(p => p.userId) },
    } : {}) }, select: { userId: true, joinedAt: true, user: chatUserSummary },
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
  const members = await conversationMembers(tx, conversation);
  return {
    id: conversation.id, householdId: conversation.householdId, type: conversation.type,
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    participants: members.map(m => m.user),
    // How far everyone else has received and read. Two numbers per person are enough to tick
    // every message in the chat, so no per-message data travels with the list.
    receipts: members.filter(m => m.userId !== userId).map(m => {
      const position = conversation.participants.find(p => p.userId === m.userId);
      return {
        userId: m.userId, joinedAt: m.joinedAt,
        deliveredSequence: position?.deliveredSequence ?? 0, readSequence: position?.lastReadSequence ?? 0,
      };
    }),
    canSend: conversation.type === "HOUSEHOLD" || members.length === 2,
    latestMessage: latestMessage ? toMessageView(latestMessage) : null,
    unreadCount, lastReadSequence: state?.lastReadSequence ?? 0, muted: state?.muted ?? false,
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
      messages: (ascending ? selected : selected.reverse()).map(toMessageView), hasMore,
      nextBefore: !ascending && hasMore ? selected[0]?.sequence : null,
      nextAfter: ascending && hasMore ? selected.at(-1)?.sequence : null,
      latestSequence: conversation.sequence,
    };
  });
}

// Reconciles deletions and edits for message rows already held by a client.
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
    const visibleIds = messageIds.filter(id => !hiddenMessageIds.includes(id));
    const deletedMessages = await tx.message.findMany({
      where: { id: { in: visibleIds }, conversationId, deletedAt: { not: null } },
      select: messageSelect,
    });
    // Every edited message comes back, not only recent edits. The client keeps whichever copy was
    // edited last, so an edit missed while it was offline is caught up here.
    const editedMessages = await tx.message.findMany({
      where: { id: { in: visibleIds }, conversationId, deletedAt: null, editedAt: { not: null } },
      select: messageSelect,
    });
    return { hiddenMessageIds, deletedMessages: deletedMessages.map(toMessageView), editedMessages: editedMessages.map(toMessageView) };
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

// Authorizes one photo upload straight to Cloudinary, into this conversation's folder. A private
// chat whose other person has left can no longer be sent to, so no upload is signed for it.
export function requestMessageUpload(conversationId: string, userId: string) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    if (conversation.type === "DIRECT" && (await conversationMembers(tx, conversation)).length !== 2) {
      throw new AppError("Both participants must still belong to the household", 409);
    }
    return createUploadTicket(chatFolder(conversation.householdId, conversation.id));
  });
}

const samePhotos = (first: string[], second: string[]) => [...first].sort().join("\n") === [...second].sort().join("\n");

// A message is text, a photo with an optional caption, or both. Photos were uploaded beforehand
// with a ticket from requestMessageUpload; `images` is what Cloudinary reported for them.
export function sendMessage(conversationId: string, userId: string, clientMessageId: string, text: string, images: ImageInput[] = []) {
  if (text.length > MAX_MESSAGE_TEXT) throw new AppError(`Message text must be at most ${MAX_MESSAGE_TEXT} characters`, 400);
  if (!text.trim() && !images.length) throw new AppError("Message must contain text or a photo", 400);
  if (images.length > MAX_MESSAGE_IMAGES) throw new AppError(`A message can carry at most ${MAX_MESSAGE_IMAGES} photo`, 400);
  const publicIds = images.map(image => image.publicId);
  if (new Set(publicIds).size !== publicIds.length) throw new AppError("The same photo was sent twice", 400);
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const existing = await tx.message.findUnique({
      where: { conversationId_senderId_clientMessageId: { conversationId, senderId: userId, clientMessageId } }, select: messageSelect,
    });
    if (existing) {
      if (existing.text !== text.trim() || !samePhotos(existing.images.map(image => image.publicId), publicIds)) {
        throw new AppError("Client message ID was already used for a different message", 409);
      }
      return { message: toMessageView(existing), created: false };
    }
    const folder = chatFolder(conversation.householdId, conversationId);
    if (publicIds.some(publicId => !isImageIn(folder, publicId))) throw new AppError("Photo was not uploaded for this conversation", 400);
    if (publicIds.length && await tx.image.count({ where: { publicId: { in: publicIds } } })) {
      throw new AppError("This photo was already sent", 409);
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
      images: { create: images.map(image => ({ ...image, householdId: conversation.householdId, uploadedById: userId })) },
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
    return { message: toMessageView(message), created: true };
  });
}

// Changes the text of the caller's own message, or the caption of their photo; the photo itself
// stays. Only the sender may, within 15 minutes, and not once it is deleted. Sending the text it
// already has changes nothing and tells nobody, so a retry after a lost response is harmless.
// `recipients` are the people whose screens show the message. Anyone who hid it or cleared it away
// is left out, so they are not handed words they chose to remove.
export function editMessage(conversationId: string, messageId: string, userId: string, text: string) {
  if (text.length > MAX_MESSAGE_TEXT) throw new AppError(`Message text must be at most ${MAX_MESSAGE_TEXT} characters`, 400);
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const message = await tx.message.findFirst({ where: { id: messageId, conversationId }, select: messageSelect });
    const hiddenFor = new Set((await tx.messageDeletion.findMany({ where: { messageId }, select: { userId: true } })).map(row => row.userId));
    const clearedFor = (id: string) => conversation.participants.find(p => p.userId === id)?.clearedSequence ?? 0;
    // A message gone from the caller's own screen leaves nothing there to edit.
    if (!message || hiddenFor.has(userId) || message.sequence <= clearedFor(userId)) throw new AppError("Message not found", 404);
    if (message.senderId !== userId) throw new AppError("Only the sender can edit a message", 403);
    if (message.deletedAt) throw new AppError("This message was deleted", 409);
    const trimmed = text.trim();
    if (!trimmed && !message.images.length) throw new AppError("Message must contain text or a photo", 400);
    if (trimmed === message.text) return { message: toMessageView(message), recipients: [] as string[] };
    if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) throw new AppError("Messages can only be edited within 15 minutes", 409);
    // A push still waiting in the outbox reads the message when it goes out, so it carries the new text.
    const edited = await tx.message.update({ where: { id: message.id }, data: { text: trimmed, editedAt: new Date() }, select: messageSelect });
    const members = await conversationMembers(tx, conversation);
    return {
      message: toMessageView(edited),
      recipients: members.map(member => member.userId).filter(id => !hiddenFor.has(id) && message.sequence > clearedFor(id)),
    };
  });
}

export type DeleteMessageScope = "me" | "everyone";

// Deletes one message or a batch through the same path. The batch is all or nothing: every check
// runs before the first write, and a failure rolls the transaction back, so a caller never has to
// explain "7 of 10 deleted". Unread counts are worked out once per person, not once per message.
// Deleting for everyone also deletes the photos; their files leave Cloudinary after the commit.
export async function deleteMessages(conversationId: string, messageIds: string[], userId: string, scope: DeleteMessageScope) {
  const { removedPhotos, ...result } = await chatTransaction(async tx => {
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
      // Everyone else still sees the message, so its photos stay.
      return {
        deletion: { conversationId, scope, messageIds, messages: [] },
        events: [{ userId, conversation: summary }],
        removedPhotos: [],
      };
    }

    if (messages.some(message => message.senderId !== userId)) throw new AppError("Only the sender can delete a message for everyone", 403);
    // A message that is already a tombstone stays one, however old it is.
    const remaining = messages.filter(message => !message.deletedAt);
    if (remaining.some(message => Date.now() - message.createdAt.getTime() > DELETE_FOR_EVERYONE_WINDOW_MS)) {
      throw new AppError("Messages can only be deleted for everyone within 15 minutes", 409);
    }
    let deletedMessages = messages;
    let removedPhotos: string[] = [];
    if (remaining.length) {
      const remainingIds = remaining.map(message => message.id);
      removedPhotos = remaining.flatMap(message => message.images.map(image => image.publicId));
      await tx.image.deleteMany({ where: { messageId: { in: remainingIds } } });
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
      deletion: { conversationId, scope, messageIds, messages: deletedMessages.map(toMessageView) },
      events,
      removedPhotos,
    };
  });
  if (removedPhotos.length) void imageStorage.destroy(removedPhotos);
  return result;
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
    // No receipt is logged here: the messages were swept away, not opened, so their senders see
    // them as read without a time instead of a time that would not be true.
    await tx.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId, lastReadSequence, deliveredSequence: lastReadSequence, clearedSequence },
      update: { lastReadSequence, deliveredSequence: lastReadSequence, clearedSequence },
    });
    // A queued live or push job must not bring a cleared message back.
    await tx.chatDelivery.updateMany({
      where: { userId, message: { conversationId, sequence: { lte: clearedSequence } }, ticketId: null, completedAt: null, failedAt: null },
      data: { completedAt: new Date(), lastError: "ClearedForUser" },
    });
    const summary = await conversationSummary(tx, conversationId, userId);
    if (!summary.unreadCount) await clearChatNotification(tx, conversationId, userId);
    const receipt = lastReadSequence > current
      ? await receiptChange(tx, conversation, userId, lastReadSequence, lastReadSequence) : null;
    return { conversationId, clearedSequence, conversation: summary, receipt };
  });
}

// What the other members are told when a position moves: whose, and both new positions.
export type ReceiptChange = {
  recipients: string[];
  event: { conversationId: string; userId: string; deliveredSequence: number; readSequence: number };
};

async function receiptChange(
  tx: Prisma.TransactionClient, conversation: AccessibleConversation, userId: string, deliveredSequence: number, readSequence: number,
): Promise<ReceiptChange> {
  const members = await conversationMembers(tx, conversation);
  return {
    recipients: members.map(m => m.userId).filter(id => id !== userId),
    event: { conversationId: conversation.id, userId, deliveredSequence, readSequence },
  };
}

// Moves a user's delivered and read positions forward, never back, and logs each move. A read
// also counts as a delivery. `receipt` is null when nothing moved, so nobody is told about a
// change that did not happen and a phone that repeats itself stays quiet.
async function advancePositions(
  tx: Prisma.TransactionClient, conversation: AccessibleConversation, userId: string, target: { delivered: number; read: number },
) {
  const state = conversation.participants.find(p => p.userId === userId);
  const current = { delivered: state?.deliveredSequence ?? 0, read: state?.lastReadSequence ?? 0 };
  const lastReadSequence = Math.max(current.read, target.read);
  const deliveredSequence = Math.max(current.delivered, target.delivered, lastReadSequence);
  const moves: Prisma.ChatReceiptCreateManyInput[] = [];
  if (deliveredSequence > current.delivered) moves.push({ conversationId: conversation.id, userId, kind: "DELIVERED", sequence: deliveredSequence });
  if (lastReadSequence > current.read) moves.push({ conversationId: conversation.id, userId, kind: "READ", sequence: lastReadSequence });
  if (moves.length) {
    await tx.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId: conversation.id, userId } },
      create: { conversationId: conversation.id, userId, lastReadSequence, deliveredSequence }, update: { lastReadSequence, deliveredSequence },
    });
    await tx.chatReceipt.createMany({ data: moves, skipDuplicates: true });
  }
  return {
    lastReadSequence, deliveredSequence,
    receipt: moves.length ? await receiptChange(tx, conversation, userId, deliveredSequence, lastReadSequence) : null,
  };
}

// A phone reports that messages up to `sequence` have reached it: over the socket, through a
// sync, or from the background task that shows a notification while the app is closed.
export function markConversationDelivered(conversationId: string, userId: string, sequence: number) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    if (sequence > conversation.sequence) throw new AppError("Delivered position is beyond the last message", 400);
    const { deliveredSequence, receipt } = await advancePositions(tx, conversation, userId, { delivered: sequence, read: 0 });
    return { conversationId, deliveredSequence, receipt };
  });
}

// "Message info": who a message reached, who read it, and when. Only its sender may ask. The time
// someone read message N is their earliest READ move that reached N, because positions only grow.
export function getMessageReceipts(conversationId: string, messageId: string, userId: string) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    const message = await tx.message.findFirst({
      where: { id: messageId, conversationId }, select: { senderId: true, sequence: true, createdAt: true, deletedAt: true },
    });
    if (!message) throw new AppError("Message not found", 404);
    if (message.senderId !== userId) throw new AppError("Only the sender can see who has read a message", 403);
    if (message.deletedAt) throw new AppError("This message was deleted", 409);
    const movedAt = async (memberId: string, kind: "DELIVERED" | "READ") => (await tx.chatReceipt.findFirst({
      where: { conversationId, userId: memberId, kind, sequence: { gte: message.sequence } },
      orderBy: { sequence: "asc" }, select: { createdAt: true },
    }))?.createdAt ?? null;
    const receipts = [];
    for (const member of await conversationMembers(tx, conversation)) {
      if (member.userId === userId) continue;
      const position = conversation.participants.find(p => p.userId === member.userId);
      const delivered = (position?.deliveredSequence ?? 0) >= message.sequence;
      const read = (position?.lastReadSequence ?? 0) >= message.sequence;
      // Someone who joined afterwards is not kept waiting on the list. They appear once the
      // message has actually reached them, since new members can read earlier history.
      if (!delivered && member.joinedAt > message.createdAt) continue;
      receipts.push({
        user: member.user, delivered, read,
        // Null with delivered or read true means it happened, but before times were recorded or
        // through Clear chat, so there is no honest time to show.
        deliveredAt: delivered ? await movedAt(member.userId, "DELIVERED") : null,
        readAt: read ? await movedAt(member.userId, "READ") : null,
      });
    }
    // Readers first, then people it reached, then people still waiting.
    receipts.sort((a, b) => Number(b.read) - Number(a.read) || Number(b.delivered) - Number(a.delivered) || a.user.name.localeCompare(b.user.name));
    return { messageId, receipts };
  });
}

export function markConversationRead(conversationId: string, userId: string, sequence: number) {
  return chatTransaction(async tx => {
    const conversation = await requireConversation(tx, conversationId, userId);
    if (sequence > conversation.sequence) throw new AppError("Read position is beyond the last message", 400);
    const { lastReadSequence, receipt } = await advancePositions(tx, conversation, userId, { delivered: 0, read: sequence });
    const unreadCount = await tx.message.count({ where: {
      conversationId, senderId: { not: userId }, deletedAt: null,
      sequence: { gt: lastReadSequence }, hiddenFor: { none: { userId } },
    } });
    if (!unreadCount) await clearChatNotification(tx, conversationId, userId);
    return { conversationId, lastReadSequence, unreadCount, receipt };
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
