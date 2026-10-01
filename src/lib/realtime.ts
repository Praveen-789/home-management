import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { verifyToken } from "./jwt.js";
import prisma from "./prisma.js";
import { chatEvents, emitChatEvent } from "./chat-events.js";
import { webOrigins } from "./web-origins.js";
import { typingAudience } from "../services/chat.service.js";
import { presence, startPresenceCheckpoint } from "../services/presence.service.js";

// The phone reports typing at most every 3 seconds. Anything faster is dropped before it costs a
// database read.
const TYPING_MIN_GAP_MS = 1000;

export function attachRealtime(server: HttpServer) {
  const stopPresence = startPresenceCheckpoint();
  const io = new Server(server, {
    cors: { origin: webOrigins }, maxHttpBufferSize: 16_384,
    // No connection recovery: restored subscriptions could outlive permissions.
  });
  io.use(async (socket, next) => {
    try {
      const token: unknown = socket.handshake.auth["token"];
      if (typeof token !== "string") throw new Error("Missing token");
      const user = verifyToken(token);
      const decoded = jwt.decode(token);
      if (!decoded || typeof decoded === "string" || typeof decoded.exp !== "number") throw new Error("Missing expiry");
      if (!await prisma.user.findUnique({ where: { id: user.userId }, select: { id: true } })) throw new Error("Missing user");
      socket.data["userId"] = user.userId;
      socket.data["expiresAt"] = decoded.exp * 1000;
      next();
    } catch { next(new Error("Invalid or expired token")); }
  });
  io.on("connection", socket => {
    const expiresAt = socket.data["expiresAt"] as number;
    if (expiresAt <= Date.now()) { socket.disconnect(true); return; }
    // Only identity rooms; clients cannot subscribe to arbitrary conversations.
    // Membership and private-chat access are checked when delivering each job.
    void socket.join(`user:${socket.data["userId"]}`);
    const userId = socket.data["userId"] as string;
    presence.connect(userId, socket.id);
    const timer = setInterval(() => {
      if (expiresAt <= Date.now()) socket.disconnect(true);
    }, 1000);
    timer.unref();
    socket.on("disconnect", () => { clearInterval(timer); presence.disconnect(userId, socket.id); });
    // Mobile clients report background/foreground without losing live delivery.
    socket.on("chat:activity", (payload: unknown) => {
      if (expiresAt <= Date.now() || !payload || typeof payload !== "object") return;
      const active = (payload as { active?: unknown }).active;
      if (active === true) presence.connect(userId, socket.id);
      else if (active === false) presence.disconnect(userId, socket.id);
    });
    // Typing reports are also accepted from a phone. Access is checked on every report, since the
    // client is not trusted to name only conversations it belongs to; a refusal or bad payload is ignored.
    let lastTyping = 0;
    socket.on("chat:typing", (payload: unknown) => {
      const conversationId = payload && typeof payload === "object" ? (payload as { conversationId?: unknown }).conversationId : undefined;
      if (typeof conversationId !== "string" || conversationId.length > 64) return;
      if (Date.now() - lastTyping < TYPING_MIN_GAP_MS || expiresAt <= Date.now()) return;
      lastTyping = Date.now();
      const userId = socket.data["userId"] as string;
      typingAudience(conversationId, userId).then(({ name, recipients }) => {
        for (const id of recipients) emitChatEvent(id, "chat:typing", { conversationId, userId, name });
      }, () => {});
    });
  });
  const deliver = (userId: string, event: string, payload: unknown) => {
    const room = io.sockets.adapter.rooms.get(`user:${userId}`);
    if (!room) return;
    for (const id of room) {
      const socket = io.sockets.sockets.get(id);
      if (!socket) continue;
      if (socket.data["expiresAt"] <= Date.now()) { socket.disconnect(true); continue; }
      socket.emit(event, payload);
    }
  };
  chatEvents.on("delivery", deliver);
  server.once("close", () => { void stopPresence(); });
  server.once("close", () => chatEvents.off("delivery", deliver));
  return io;
}
