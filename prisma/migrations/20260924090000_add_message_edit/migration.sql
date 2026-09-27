-- When the sender last changed a message's text. Existing messages were never edited.
ALTER TABLE "Message" ADD COLUMN "editedAt" TIMESTAMP(3);
