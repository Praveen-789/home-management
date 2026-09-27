-- Profile pictures for users and households. Every column stays NULL until someone sets a
-- picture, so existing rows need no backfill.
ALTER TABLE "User" ADD COLUMN "avatarPublicId" TEXT, ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "Household" ADD COLUMN "picturePublicId" TEXT, ADD COLUMN "pictureUrl" TEXT;
