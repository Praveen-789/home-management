export class PushError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean) { super(code); }
}

type ExpoResult = { status?: string; id?: string; details?: { error?: string } };

export function pushPreview(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  return characters.length <= limit
    ? normalized
    : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

async function post(path: string, payload: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
      method: "POST", headers: {
        "Content-Type": "application/json",
        ...(process.env["EXPO_ACCESS_TOKEN"] ? { Authorization: `Bearer ${process.env["EXPO_ACCESS_TOKEN"]}` } : {}),
      }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new PushError("NetworkError", true); }
  if (!response.ok) throw new PushError(`ExpoHTTP${response.status}`, response.status === 429 || response.status >= 500);
  try { return await response.json(); } catch { throw new PushError("InvalidExpoResponse", true); }
}

function check(result: ExpoResult | undefined) {
  if (!result || !["ok", "error"].includes(result.status ?? "")) throw new PushError("InvalidExpoResponse", true);
  if (result.status === "error") {
    const code = result.details?.error ?? "ExpoRejected";
    throw new PushError(code, code === "MessageRateExceeded");
  }
}

// What the phone needs to act on a chat alert without opening the app. `sequence` lets
// "Mark as read" move the read cursor. `recipientId` lets the phone refuse to reply as anyone else.
export type ChatPush = { conversationId: string; messageId: string; sequence: number; recipientId: string };

export async function sendExpoPush(
  token: string,
  chat: ChatPush,
  title = "HomeHub",
  body = "You have a new chat message",
  platform = "android",
): Promise<string> {
  const response = await post("send", {
    to: token,
    priority: "high",
    ttl: 3600,
    ...(platform === "android" ? {
      // No top-level title/body: Firebase must deliver data to the app, not render a plain alert.
      data: { type: "CHAT_MESSAGE", ...chat, delivery: "chat_local_v1",
        previewTitle: pushPreview(title, 60) || "HomeHub", previewBody: pushPreview(body) },
    } : {
      title: pushPreview(title, 60) || "HomeHub", body: pushPreview(body), sound: "default",
      categoryId: "chat_message", data: { type: "CHAT_MESSAGE", ...chat },
    }),
  }) as { data?: ExpoResult | ExpoResult[] };
  const result = Array.isArray(response.data) ? response.data[0] : response.data;
  check(result);
  if (typeof result?.id !== "string") throw new PushError("MissingTicket", true);
  return result.id;
}

export async function getExpoReceipt(ticketId: string): Promise<boolean> {
  const response = await post("getReceipts", { ids: [ticketId] }) as { data?: Record<string, ExpoResult> };
  if (!response.data || typeof response.data !== "object") throw new PushError("InvalidExpoResponse", true);
  const result = response.data[ticketId];
  if (!result) return false;
  check(result);
  return true;
}
