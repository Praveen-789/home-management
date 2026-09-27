-- Chat photos: an image may now belong to a message as well as to a task or an expense.
ALTER TABLE "Image" ADD COLUMN "messageId" TEXT;

CREATE INDEX "Image_messageId_idx" ON "Image"("messageId");

ALTER TABLE "Image" ADD CONSTRAINT "Image_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Still exactly one parent: a task, an expense or a message.
ALTER TABLE "Image" DROP CONSTRAINT "Image_single_parent_check";
ALTER TABLE "Image" ADD CONSTRAINT "Image_single_parent_check" CHECK (
  ("taskId" IS NOT NULL)::int + ("expenseId" IS NOT NULL)::int + ("messageId" IS NOT NULL)::int = 1
);

-- A photo's caption may be empty, but text is never only whitespace. Whether an empty message
-- carries a photo is checked by the service, since a check constraint cannot look at another table.
ALTER TABLE "Message" DROP CONSTRAINT "Message_text_check";
ALTER TABLE "Message" ADD CONSTRAINT "Message_text_check" CHECK (
  ("deletedAt" IS NULL AND "deletedById" IS NULL AND ("text" = '' OR length(btrim("text")) BETWEEN 1 AND 4000))
  OR
  ("deletedAt" IS NOT NULL AND "deletedById" = "senderId" AND "text" = '')
);
