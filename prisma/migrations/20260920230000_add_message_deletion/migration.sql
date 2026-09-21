ALTER TABLE "Message"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deletedById" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Message" DROP CONSTRAINT "Message_text_check";
ALTER TABLE "Message" ADD CONSTRAINT "Message_text_check" CHECK (
  ("deletedAt" IS NULL AND "deletedById" IS NULL AND length(btrim("text")) BETWEEN 1 AND 4000)
  OR
  ("deletedAt" IS NOT NULL AND "deletedById" = "senderId" AND "text" = '')
);

ALTER TABLE "Message" ADD CONSTRAINT "Message_deletedById_fkey"
  FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MessageDeletion" (
  "messageId" TEXT NOT NULL REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageDeletion_pkey" PRIMARY KEY ("messageId", "userId")
);

CREATE INDEX "MessageDeletion_userId_createdAt_idx" ON "MessageDeletion"("userId", "createdAt");
