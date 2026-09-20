-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "householdId" TEXT,
ADD COLUMN "entityId" TEXT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE SET NULL ON UPDATE CASCADE;
