-- "Clear chat" marker. Zero hides nothing, so existing rows keep their full history.
ALTER TABLE "ConversationParticipant" ADD COLUMN "clearedSequence" INTEGER NOT NULL DEFAULT 0;
