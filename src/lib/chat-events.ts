import { EventEmitter } from "node:events";

// API and outbox worker run in the same process for the initial single-server
// deployment. A shared Socket.IO adapter is required before adding replicas.
export const chatEvents = new EventEmitter();
export function emitChatEvent(userId: string, event: string, payload: unknown) {
  chatEvents.emit("delivery", userId, event, payload);
}
