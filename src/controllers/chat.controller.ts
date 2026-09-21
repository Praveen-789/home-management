import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { readId, readInteger, readPagination } from "../lib/controller.js";
import { AppError } from "../lib/errors.js";
import { emitChatEvent } from "../lib/chat-events.js";
import * as chat from "../services/chat.service.js";
import * as devices from "../services/device-token.service.js";

const handle = (operation: (req: AuthenticatedRequest, res: Response, userId: string) => Promise<unknown>) =>
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.userId) throw new AppError("Authentication is required", 401);
      return await operation(req, res, req.userId);
    } catch (error) {
      if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message });
      // Do not log request bodies, message contents, or push tokens.
      console.error("Chat operation failed", error instanceof Error ? error.name : "UnknownError");
      return res.status(500).json({ message: "Chat operation failed" });
    }
  };

const conversationId = (req: AuthenticatedRequest) => readId(req.params["conversationId"], "Conversation ID");
const householdId = (req: AuthenticatedRequest) => readId(req.params["householdId"], "Household ID");

export const household = handle(async (req, res, userId) => {
  const conversation = await chat.ensureHouseholdConversation(householdId(req), userId);
  return res.json({ conversation: await chat.getConversation(conversation.id, userId) });
});

export const direct = handle(async (req, res, userId) => {
  const recipientId = readId(req.body?.recipientId, "Recipient ID");
  if (recipientId.length > 128) throw new AppError("Invalid recipient ID", 400);
  const conversation = await chat.ensureDirectConversation(householdId(req), userId, recipientId);
  return res.json({ conversation: await chat.getConversation(conversation.id, userId) });
});

export const list = handle(async (req, res, userId) => {
  const { page, limit } = readPagination(req.query);
  // Also initializes chat for existing households, without a data backfill.
  await chat.ensureHouseholdConversation(householdId(req), userId);
  return res.json(await chat.listConversations(householdId(req), userId, page, limit));
});

export const detail = handle(async (req, res, userId) => res.json({ conversation: await chat.getConversation(conversationId(req), userId) }));

export const messages = handle(async (req, res, userId) => {
  const { before, after } = req.query;
  if (before !== undefined && after !== undefined) throw new AppError("Use either before or after, not both", 400);
  const query: chat.MessageQuery = { limit: readInteger(req.query["limit"], "Limit", 1, 100, 30) };
  if (before !== undefined) query.before = readInteger(before, "Before", 1, 2147483647, 1);
  if (after !== undefined) query.after = readInteger(after, "After", 0, 2147483647, 0);
  return res.json(await chat.getMessages(conversationId(req), userId, query));
});

// A list of message IDs from the request body, with repeats removed. The cap is checked on what
// was sent, before repeats are removed, so a padded list cannot slip past it.
function readMessageIds(req: AuthenticatedRequest, max: number): string[] {
  const values: unknown = req.body?.messageIds;
  if (!Array.isArray(values) || values.length < 1 || values.length > max) {
    throw new AppError(`Message IDs must contain 1 to ${max} IDs`, 400);
  }
  const messageIds = [...new Set<string>(values.map(value => readId(value, "Message ID")))];
  if (messageIds.some(id => id.length > 128)) throw new AppError("Invalid message ID", 400);
  return messageIds;
}

export const reconcileMessages = handle(async (req, res, userId) =>
  res.json(await chat.reconcileMessages(conversationId(req), userId, readMessageIds(req, 100))));

export const send = handle(async (req, res, userId) => {
  const clientMessageId = readId(req.body?.clientMessageId, "Client message ID");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientMessageId)) throw new AppError("Client message ID must contain 8 to 128 letters, digits, underscores or hyphens", 400);
  if (typeof req.body?.text !== "string") throw new AppError("Message text is required", 400);
  const result = await chat.sendMessage(conversationId(req), userId, clientMessageId, req.body.text);
  return res.status(result.created ? 201 : 200).json(result);
});

// One message or many: a single delete is a list of one. Each affected person gets one event for
// the whole batch, carrying their own unread count.
export const removeMessages = handle(async (req, res, userId) => {
  const scope: unknown = req.body?.scope;
  if (scope !== "me" && scope !== "everyone") throw new AppError("Scope must be me or everyone", 400);
  const result = await chat.deleteMessages(conversationId(req), readMessageIds(req, chat.MAX_DELETE_BATCH), userId, scope);
  for (const event of result.events) emitChatEvent(event.userId, "chat:messages-deleted", {
    ...result.deletion,
    conversation: event.conversation,
  });
  const own = result.events.find(event => event.userId === userId);
  return res.json({ deletion: result.deletion, conversation: own?.conversation });
});

// Only the caller's own devices hear about it: nobody else's chat changes.
export const clear = handle(async (req, res, userId) => {
  const result = await chat.clearConversation(conversationId(req), userId);
  emitChatEvent(userId, "chat:cleared", result);
  return res.json(result);
});

export const read = handle(async (req, res, userId) => {
  const sequence = req.body?.sequence;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 2147483647) throw new AppError("Sequence must be a non-negative integer", 400);
  const result = await chat.markConversationRead(conversationId(req), userId, sequence);
  emitChatEvent(userId, "chat:read", result);
  return res.json(result);
});

export const mute = handle(async (req, res, userId) => {
  const muted = req.body?.muted;
  if (typeof muted !== "boolean") throw new AppError("Muted must be a boolean", 400);
  const result = await chat.setConversationMuted(conversationId(req), userId, muted);
  emitChatEvent(userId, "chat:preferences", result);
  return res.json(result);
});

export const registerDevice = handle(async (req, res, userId) => {
  const token = devices.validateExpoToken(req.body?.token);
  const platform = req.body?.platform;
  if (platform !== "android" && platform !== "ios") throw new AppError("Platform must be android or ios", 400);
  return res.json({ device: await devices.registerDevice(userId, token, platform) });
});

export const unregisterDevice = handle(async (req, res, userId) => {
  await devices.unregisterDevice(userId, readId(req.params["deviceId"], "Device ID"));
  return res.status(204).send();
});
