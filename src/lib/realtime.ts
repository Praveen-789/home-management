import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { verifyToken } from "./jwt.js";
import prisma from "./prisma.js";
import { chatEvents } from "./chat-events.js";
import { webOrigins } from "./web-origins.js";

export function attachRealtime(server: HttpServer) {
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
    const timer = setInterval(() => {
      if (expiresAt <= Date.now()) socket.disconnect(true);
    }, 1000);
    timer.unref();
    socket.on("disconnect", () => clearInterval(timer));
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
  server.once("close", () => chatEvents.off("delivery", deliver));
  return io;
}
