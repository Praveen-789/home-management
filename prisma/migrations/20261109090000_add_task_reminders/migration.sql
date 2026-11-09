-- CreateTable
CREATE TABLE "TaskReminder" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "repeat" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "localTime" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskReminderDelivery" (
    "id" TEXT NOT NULL,
    "reminderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "notificationId" TEXT NOT NULL,
    "deviceTokenId" TEXT NOT NULL,
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

    CONSTRAINT "TaskReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskReminder_enabled_nextRunAt_idx" ON "TaskReminder"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskReminder_taskId_userId_key" ON "TaskReminder"("taskId", "userId");

-- CreateIndex
CREATE INDEX "TaskReminderDelivery_completedAt_failedAt_availableAt_idx" ON "TaskReminderDelivery"("completedAt", "failedAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskReminderDelivery_reminderId_version_scheduledAt_deviceT_key" ON "TaskReminderDelivery"("reminderId", "version", "scheduledAt", "deviceTokenId");

-- AddForeignKey
ALTER TABLE "TaskReminder" ADD CONSTRAINT "TaskReminder_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminder" ADD CONSTRAINT "TaskReminder_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "HouseholdMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminderDelivery" ADD CONSTRAINT "TaskReminderDelivery_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "TaskReminder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminderDelivery" ADD CONSTRAINT "TaskReminderDelivery_deviceTokenId_fkey" FOREIGN KEY ("deviceTokenId") REFERENCES "DeviceToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
