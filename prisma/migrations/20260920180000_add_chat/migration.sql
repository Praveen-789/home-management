CREATE TYPE "ConversationType" AS ENUM ('HOUSEHOLD', 'DIRECT');
CREATE TYPE "ChatDeliveryKind" AS ENUM ('LIVE', 'PUSH');

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "householdId" TEXT NOT NULL REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "type" "ConversationType" NOT NULL,
  "key" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0 CHECK ("sequence" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_type_key_check" CHECK (
    ("type" = 'HOUSEHOLD' AND "key" = 'HOUSEHOLD') OR
    ("type" = 'DIRECT' AND "key" <> 'HOUSEHOLD')
  )
);
CREATE UNIQUE INDEX "Conversation_householdId_key_key" ON "Conversation"("householdId", "key");
CREATE INDEX "Conversation_householdId_updatedAt_id_idx" ON "Conversation"("householdId", "updatedAt", "id");

CREATE TABLE "ConversationParticipant" (
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "lastReadSequence" INTEGER NOT NULL DEFAULT 0 CHECK ("lastReadSequence" >= 0),
  "muted" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("conversationId", "userId")
);
CREATE INDEX "ConversationParticipant_userId_idx" ON "ConversationParticipant"("userId");

CREATE TABLE "Message" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "senderId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "clientMessageId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL CHECK ("sequence" > 0),
  "text" TEXT NOT NULL CHECK (length(btrim("text")) BETWEEN 1 AND 4000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Message_conversationId_sequence_key" ON "Message"("conversationId", "sequence");
CREATE UNIQUE INDEX "Message_conversationId_senderId_clientMessageId_key" ON "Message"("conversationId", "senderId", "clientMessageId");
CREATE INDEX "Message_senderId_createdAt_idx" ON "Message"("senderId", "createdAt");

CREATE TABLE "DeviceToken" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "token" TEXT NOT NULL,
  "platform" TEXT NOT NULL CHECK ("platform" IN ('android', 'ios')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "DeviceToken_token_key" ON "DeviceToken"("token");
CREATE INDEX "DeviceToken_userId_idx" ON "DeviceToken"("userId");

CREATE TABLE "ChatDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "kind" "ChatDeliveryKind" NOT NULL,
  "messageId" TEXT NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "deviceTokenId" TEXT REFERENCES "DeviceToken"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "ticketId" TEXT,
  "ticketAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatDelivery_kind_device_check" CHECK (
    ("kind" = 'LIVE' AND "deviceTokenId" IS NULL) OR
    ("kind" = 'PUSH' AND "deviceTokenId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ChatDelivery_key_key" ON "ChatDelivery"("key");
CREATE INDEX "ChatDelivery_completedAt_failedAt_kind_availableAt_idx" ON "ChatDelivery"("completedAt", "failedAt", "kind", "availableAt");
