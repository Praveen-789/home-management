import app from "./app.js";
import { createServer } from "node:http";
import prisma from "./lib/prisma.js";
import { attachRealtime } from "./lib/realtime.js";
import { startChatDeliveryWorker } from "./services/chat-delivery.service.js";

const PORT = Number(process.env["PORT"] || 3000);
const server = createServer(app);
const io = attachRealtime(server);
let stopWorker: (() => Promise<void>) | undefined;

server.listen(PORT, () => {
  stopWorker = startChatDeliveryWorker();
  console.log(`Server running on http://localhost:${PORT}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await stopWorker?.();
  await new Promise<void>(resolve => io.close(() => resolve()));
  await prisma.$disconnect();
  clearTimeout(deadline);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
