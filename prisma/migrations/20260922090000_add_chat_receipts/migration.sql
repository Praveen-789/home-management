-- Delivered and read receipts for chat.
CREATE TYPE "ChatReceiptKind" AS ENUM ('DELIVERED', 'READ');

-- A message that was read must have arrived, so existing read positions seed the new column.
ALTER TABLE "ConversationParticipant" ADD COLUMN "deliveredSequence" INTEGER NOT NULL DEFAULT 0;
UPDATE "ConversationParticipant" SET "deliveredSequence" = "lastReadSequence";

-- The log starts empty. Reads from before this migration have no known time, so the app shows
-- them as read without one instead of inventing a time.
CREATE TABLE "ChatReceipt" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" "ChatReceiptKind" NOT NULL,
  "sequence" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChatReceipt_conversationId_kind_userId_sequence_key" ON "ChatReceipt"("conversationId", "kind", "userId", "sequence");
ALTER TABLE "ChatReceipt" ADD CONSTRAINT "ChatReceipt_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatReceipt" ADD CONSTRAINT "ChatReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
