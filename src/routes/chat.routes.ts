import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import * as chat from "../controllers/chat.controller.js";

export const householdChatRoutes = Router({ mergeParams: true });
householdChatRoutes.use(authenticate);
householdChatRoutes.get("/", chat.list);
householdChatRoutes.post("/household", chat.household);
householdChatRoutes.post("/direct", chat.direct);

export const conversationRoutes = Router();
conversationRoutes.use(authenticate);
conversationRoutes.get("/:conversationId", chat.detail);
conversationRoutes.get("/:conversationId/messages", chat.messages);
conversationRoutes.post("/:conversationId/messages/reconcile", chat.reconcileMessages);
conversationRoutes.post("/:conversationId/messages", chat.send);
conversationRoutes.post("/:conversationId/messages/delete", chat.removeMessages);
conversationRoutes.post("/:conversationId/clear", chat.clear);
conversationRoutes.patch("/:conversationId/read", chat.read);
conversationRoutes.patch("/:conversationId/preferences", chat.mute);

export const deviceRoutes = Router();
deviceRoutes.use(authenticate);
deviceRoutes.post("/", chat.registerDevice);
deviceRoutes.delete("/:deviceId", chat.unregisterDevice);
