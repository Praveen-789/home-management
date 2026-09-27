-- Household posts: text, photos or both, with likes and a flat list of comments.
CREATE TABLE "Post" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PostLike" (
    "postId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostLike_pkey" PRIMARY KEY ("postId","userId")
);

CREATE TABLE "PostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostComment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Post_householdId_createdAt_id_idx" ON "Post"("householdId", "createdAt", "id");
CREATE INDEX "Post_authorId_idx" ON "Post"("authorId");
CREATE INDEX "PostLike_userId_idx" ON "PostLike"("userId");
CREATE INDEX "PostComment_postId_createdAt_id_idx" ON "PostComment"("postId", "createdAt", "id");
CREATE INDEX "PostComment_authorId_idx" ON "PostComment"("authorId");

ALTER TABLE "Post" ADD CONSTRAINT "Post_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostLike" ADD CONSTRAINT "PostLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A photo-only post has empty text, but text is never only whitespace. Whether an empty post carries
-- a photo is checked by the service, since a check constraint cannot look at another table.
ALTER TABLE "Post" ADD CONSTRAINT "Post_text_check" CHECK ("text" = '' OR length(btrim("text")) BETWEEN 1 AND 4000);
ALTER TABLE "PostComment" ADD CONSTRAINT "PostComment_text_check" CHECK (length(btrim("text")) BETWEEN 1 AND 1000);

-- An image may now belong to a post as well.
ALTER TABLE "Image" ADD COLUMN "postId" TEXT;

CREATE INDEX "Image_postId_idx" ON "Image"("postId");

ALTER TABLE "Image" ADD CONSTRAINT "Image_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Still exactly one parent: a task, an expense, a message or a post.
ALTER TABLE "Image" DROP CONSTRAINT "Image_single_parent_check";
ALTER TABLE "Image" ADD CONSTRAINT "Image_single_parent_check" CHECK (
  ("taskId" IS NOT NULL)::int + ("expenseId" IS NOT NULL)::int + ("messageId" IS NOT NULL)::int + ("postId" IS NOT NULL)::int = 1
);
