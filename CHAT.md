# HomeHub chat backend

Text chat supports one shared conversation per household and one private conversation per pair of users **within that household**. Messages are stored in PostgreSQL. Socket.IO provides live updates; a PostgreSQL outbox drives live delivery and optional Expo push delivery.

## Run locally

```sh
npm install
npx prisma migrate deploy
npx prisma generate
npm run dev
```

The server uses the existing `DATABASE_URL`, `JWT_SECRET`, and `WEB_ORIGINS` settings. `PORT` defaults to 3000. `DATABASE_SCHEMA` defaults to `public`; tests use a generated isolated schema.

Push is disabled by default. Text chat, history, unread counts, and in-app notification records work without an Expo account or Firebase private key in this backend.

When the mobile app and Expo credentials are ready, configure:

```dotenv
EXPO_PUSH_ENABLED=true
# Only required if enhanced push security is enabled in the Expo project:
EXPO_ACCESS_TOKEN=your-expo-access-token
```

The Firebase service-account private key belongs in Expo/EAS credentials. Do not put it in this repository. The backend sends Expo push tokens to Expo's fixed HTTPS API; it does not use the Firebase private key directly.

## Access rules

- Every operation requires a bearer JWT and current membership in the conversation's household.
- For a private conversation, the caller must also be one of its two original participants. Owners/admins have no special access to private chats.
- Direct conversation creation requires two distinct current household members. Concurrent creation and reversed participant order return the same conversation.
- A removed member loses access to history and future delivery. Previously downloaded content cannot be recalled.
- The remaining private-chat participant retains access to their history but cannot send until both participants are members again.
- New household members can read earlier household chat history. On rejoining, a user's existing private conversations and read/mute preferences are retained.
- There is no end-to-end encryption, edit API, typing indicator, or image upload in this phase.

## REST API

All paths below start at `/api`. Bodies are JSON. The sender/user identity always comes from JWT; ownership fields in request bodies are ignored.

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| GET | `/households/:householdId/conversations` | `page=1&limit=20` (max 100) | Accessible conversation summaries; lazily creates household chat |
| POST | `/households/:householdId/conversations/household` | None | Find/create shared chat; `{ conversation }` |
| POST | `/households/:householdId/conversations/direct` | `{ "recipientId": "USER_ID" }` | Find/create private chat; `{ conversation }` |
| GET | `/conversations/:conversationId` | None | `{ conversation }` summary |
| GET | `/conversations/:conversationId/messages` | `limit=30`, optional `before` or `after` sequence | Messages and recovery cursors |
| POST | `/conversations/:conversationId/messages/reconcile` | `{ "messageIds": ["ID", ...] }` (max 100) | Personal hidden IDs (deleted for me, or swept by Clear chat) and deleted-for-everyone tombstones for cached rows |
| POST | `/conversations/:conversationId/messages` | `{ "clientMessageId": "UUID", "text": "Hello" }` | `{ message, created }`; 201 for new, 200 for retry |
| POST | `/conversations/:conversationId/messages/delete` | `{ "messageIds": ["ID", ...], "scope": "me" \| "everyone" }` (1 to 50 IDs) | `{ deletion: { conversationId, scope, messageIds, messages }, conversation }`. Hides for caller, or replaces with tombstones for everyone. One message is a list of one |
| POST | `/conversations/:conversationId/clear` | None | `{ conversationId, clearedSequence, conversation }`. "Clear chat": empties the caller's history only |
| PATCH | `/conversations/:conversationId/read` | `{ "sequence": 12 }` | `{ conversationId, lastReadSequence, unreadCount }` |
| PATCH | `/conversations/:conversationId/preferences` | `{ "muted": true }` | `{ conversationId, muted }` |
| POST | `/devices` | `{ "token": "ExpoPushToken[...]", "platform": "android" }` | `{ device: { id, platform, updatedAt } }` |
| DELETE | `/devices/:deviceId` | None | 204; only removes the caller's registration |

Conversation summaries contain `id`, `householdId`, `type` (`HOUSEHOLD` / `DIRECT`), `createdAt`, `updatedAt`, current `participants` (IDs and names only), `canSend`, `latestMessage`, `unreadCount`, `lastReadSequence`, and `muted`. Private chats with a removed peer have `canSend: false`. Conversation-list pagination is by most recent activity and can move as new messages arrive.

Message shape:

```json
{
  "id": "SERVER_MESSAGE_ID",
  "conversationId": "CONVERSATION_ID",
  "senderId": "USER_ID",
  "clientMessageId": "APP_GENERATED_UUID",
  "sequence": 12,
  "text": "Hello",
  "deletedAt": null,
  "createdAt": "2026-09-20T12:00:00.000Z",
  "sender": { "id": "USER_ID", "name": "Praveen" }
}
```

Text must be nonblank and at most 4,000 JavaScript string characters before trimming. `clientMessageId` must have 8–128 letters, digits, underscores or hyphens; a UUID works. Keep the same ID across retries. Reusing it for different text gives 409. IDs are scoped to sender and conversation. Sending is limited to 60 new messages per user per minute across conversations; retries of saved messages still succeed. The limit is database-backed. At most 20 push tokens can be registered per user.

Deleting takes a list, so one endpoint serves a single message and a WhatsApp-style multi-select. The batch is **all or nothing**: every ID must belong to the conversation (else 404), and for `everyone` every message must be the caller's (else 403) and inside the window (else 409); any failure leaves all of them untouched. Repeated IDs are collapsed, and more than 50 is a 400. `messages` in the response holds the tombstones for `everyone`, ordered by sequence, and is empty for `me`. Unread counts are computed once per person for the whole batch. There is no single-message DELETE route.

**Clear chat** stores one number, `ConversationParticipant.clearedSequence`, set to the conversation's latest sequence. Every read for that user (history pages, latest-message preview, unread count, reconcile, queued live/push jobs) ignores messages at or below it, so their chat is empty while everyone else's is unchanged. No `Message` row is touched, and messages sent afterwards appear normally. Clearing also marks the chat read, which removes its inbox alert. The marker only moves forward and cannot be undone.

`scope=me` can be used by any member who can currently access the message and hides it only for that user on all their devices. `scope=everyone` is available only to the sender during the first 15 minutes. It permanently clears the stored text but retains the row, sender, sequence and `deletedAt`, allowing every client to render `This message was deleted.` Repeating either deletion is safe. A previously delivered push cannot be recalled; push jobs that have not yet been submitted are cancelled.

On reconnect or foregrounding, clients should call `messages/reconcile` in chunks for message IDs already cached on that device. This recovers deletion events missed while its socket was disconnected without downloading all message history or starting a polling loop.

### History, recovery and read progress

Messages always return oldest-to-newest **within the returned page**.

- Initial load: `GET .../messages?limit=30` returns the newest 30 messages.
- Older page: use the returned `nextBefore` as `before`.
- Reconnect: `GET .../messages?after=LAST_CONTIGUOUS_SEQUENCE&limit=100` returns the next page in sequence order. Continue with `nextAfter` while `hasMore` is true.
- `before` and `after` cannot be combined. `after=0` starts from the beginning.
- Responses include `messages`, `hasMore`, `nextBefore`, `nextAfter`, and `latestSequence`.

Sequence numbers are allocated within the message transaction and are unique per conversation. Use them to sort, spot gaps, and recover; do not treat a randomly received higher sequence or the `latestSequence` snapshot as proof that all previous messages were received. Merge responses/events by message ID and reconcile optimistic messages by `clientMessageId` plus sender ID.

Report read progress only after messages were actually shown to the user. The read cursor cannot exceed the conversation's last message and never moves backward. Unread counts exclude the caller's own messages. Sending does not automatically mark older incoming messages read.

### Device registration

Create Android notification channel `chat` in the app before requesting its Expo token. Register the token after login, and re-register on token changes. Save the returned device ID and DELETE it **before logout** while authentication is still available. Then disconnect the socket and clear cached private content.

Registering an existing token under another signed-in user transfers it to that user, gives it a new device registration ID, and deletes queued deliveries belonging to the previous registration. Users cannot delete other users' device IDs. The API accepts `android` and `ios`; web push is outside this implementation.

## Socket contract

Connect `socket.io-client` to the **server origin**, not `/api`, with:

```js
const socket = io(SERVER_ORIGIN, { auth: { token: jwt } });
```

The backend joins only an authenticated user room. There are no client-controlled join/subscribe events and no socket-based send endpoint. REST remains the single message write path. All devices of an authorized user receive live updates, including the sender's other devices.

| Event | Payload | Client action |
| --- | --- | --- |
| `chat:message` | `{ message, unreadCount, lastReadSequence, muted, alert }` | Merge/sort message; refresh conversation summary as needed |
| `chat:messages-deleted` | `{ conversationId, scope, messageIds, messages, conversation }` | One event per batch. Remove the listed rows for `me`, or replace them with the tombstones in `messages` for `everyone` |
| `chat:cleared` | `{ conversationId, clearedSequence, conversation }` | Sent to the caller's own devices only. Drop cached messages at or below `clearedSequence` |
| `chat:read` | `{ conversationId, lastReadSequence, unreadCount }` | Synchronize read progress across own devices |
| `chat:preferences` | `{ conversationId, muted }` | Synchronize own mute preference |
| `connect_error` | Error with generic auth message | Refresh/reacquire authentication before reconnecting |

Only show a banner when `alert` is true and that conversation is not currently being viewed. Socket connection does not mean a message has been read. Read/preference events are best effort; refresh summaries on reconnect or app resume. Fetch missing messages after every reconnect, even if the socket reconnects automatically. If a token expires, the server disconnects the socket; the app must supply a fresh JWT and reconnect explicitly.

The outbox checks current conversation permissions for each recipient. Membership row locks cover the synchronous live emit, so member removal cannot commit between the access check and emission. Packets already emitted before removal cannot be recalled. Push alerts contain the sender name and a message preview; the device operating system controls whether previews appear on its lock screen.

## Alerts and worker behavior

- Sending saves the message, grouped notification records, and delivery jobs in one transaction. Database failures roll back all of them.
- Each unmuted recipient has one `CHAT_MESSAGE` notification per conversation in the existing `/api/notifications` inbox. `entityId` points to the conversation. New messages update that row rather than creating one row per message.
- Chat read progress **deletes** that inbox alert when there are no unread messages; it is a pointer to unread messages, not read history. The next message recreates it under the same id. Marking or deleting an inbox notification does **not** mark chat messages read.
- Muted conversations still receive live messages and accumulate unread messages, but new inbox alerts and push jobs are suppressed. Existing inbox alerts are not deleted by muting.
- An embedded worker starts with `src/server.ts`, polls every second, and claims jobs with PostgreSQL `SKIP LOCKED` and 60-second leases.
- Push is delayed by five seconds and skipped if the recipient already read the message, muted the conversation, left the household, or unregistered the device. Socket connectivity alone does not suppress push.
- PUSH jobs are left pending while `EXPO_PUSH_ENABLED` is off. Unsent alerts older than one hour are discarded when processed, so enabling push later does not send an old backlog.
- Expo tickets are persisted and receipts checked after 15 minutes, then periodically for up to 24 hours. Invalid device tokens are removed. Temporary failures use exponential backoff, with eight attempts; permanent failures remain in the queue with `failedAt` and a sanitized `lastError`.
- Completed jobs are retained seven days; failed jobs thirty days. Inspect pending/failed rows operationally. After fixing credentials, failed jobs can be reviewed and explicitly retried by an operator; there is no public retry endpoint.
- Push alerts use the sender name as the title and a whitespace-normalized message preview of at most 160 Unicode characters as the body. Conversation/message IDs remain in the data payload for navigation. Access is checked immediately before submission and again when loading the chat. Provider-accepted alerts cannot be recalled after removal, logout, or mute.
- Every chat push carries `categoryId: "chat_message"`, which the app registers with **Reply** and **Mark as read** buttons. The data payload is `{ type: "CHAT_MESSAGE", conversationId, messageId, sequence, recipientId }`. A reply from the alert is an ordinary `POST /conversations/:id/messages`, and both buttons finish with the ordinary `PATCH /conversations/:id/read`, so no endpoint is special to notifications. `sequence` is what Mark as read sends. `recipientId` is the user the alert was addressed to; the app acts only when it matches the signed-in user. The server still authorizes every request by its token, so the field is a client-side safety check and not a permission.

Delivery is **at least once for retryable jobs**, not exactly once: a process crash after emitting or submitting to Expo but before recording success can cause duplicates. Live message IDs and client reconciliation handle duplicate events. Push providers may also duplicate or fail to display alerts; Expo receipt success means handoff to the platform, not proof that the user saw or read it. A REST response confirms durable storage, not recipient delivery.

This first version runs the HTTP server, Socket.IO, and worker in **one process/replica**. Before adding replicas or separating workers, introduce a shared Socket.IO adapter/event transport; otherwise a worker can claim a live job whose recipient is connected to a different process. Push is one alert per unread message/device; only the database notification inbox is grouped.

Existing task/expense notifications continue using their current flow. Their push delivery is not wired by this chat implementation. Images can be added later with a message-attachment table and an authorized upload/download flow.

## Verification

```sh
npm run typecheck
npm test
npm run test:chat:integration
```

The integration test uses `DATABASE_URL` to create a random `chat_test_<uuid>` schema, applies all migrations there, runs the real REST/socket/services, and removes only that generated schema. The test account needs schema creation permission. Expo requests are mocked: no real notifications are sent. Application tables and existing data are not reset. Phone delivery still needs a rebuilt mobile app, token-registration code, Expo project/credentials, and a real-device test.

References: [Socket.IO authentication](https://socket.io/docs/v4/middlewares/), [Expo sending and receipts](https://docs.expo.dev/push-notifications/sending-notifications/).


## Android action notification delivery

Android pushes now send high-priority data-only messages with delivery=chat_local_v1, previewTitle, previewBody and the existing chat identifiers. The updated app creates the visible notification with its registered Reply and Mark as read category. iOS keeps its alert payload. Install the updated app (including native expo-task-manager) before deploying this backend change; old Android clients cannot render this payload. Background execution is subject to Android restrictions. Reading a chat clears matching local alerts and saves the read position to suppress delayed deliveries.
