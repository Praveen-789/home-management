import { randomUUID } from "node:crypto";
import type { TaskReminder, TaskReminderDelivery, Prisma } from "../../generated/prisma/client.js";
import prisma from "../lib/prisma.js";
import { nextDailyRun } from "../lib/reminder-time.js";
import { getExpoReceipt, PushError, sendTaskReminderPush } from "../lib/expo-push.js";
import { createNotification } from "./notification.service.js";

// Lock the due schedule until notification, push jobs and nextRunAt all commit.
// Concurrent workers skip locked rows; a crash rolls the whole occurrence back.
export function processDueReminder(now = new Date()): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<TaskReminder[]>`
      SELECT * FROM "TaskReminder" WHERE enabled = true AND "nextRunAt" <= ${now}
      ORDER BY "nextRunAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    const reminder = rows[0];
    if (!reminder) return false;
    // Lock task before checking status, so a completed task cannot be scheduled concurrently.
    const tasks = await tx.$queryRaw<{ id: string; householdId: string; title: string; status: string }[]>`
      SELECT id, "householdId", title, status FROM "Task" WHERE id = ${reminder.taskId} FOR SHARE`;
    const task = tasks[0];
    if (!task || task.status === "DONE") {
      await tx.taskReminder.update({ where: { id: reminder.id }, data: { enabled: false, nextRunAt: null } });
      return true;
    }
    const member = await tx.householdMember.findFirst({
      where: { id: reminder.membershipId, userId: reminder.userId, householdId: task.householdId }, select: { id: true },
    });
    if (!member) {
      await tx.taskReminder.delete({ where: { id: reminder.id } });
      return true;
    }
    // At most one catch-up alert; missed daily occurrences are never replayed in bulk.
    const notification = await createNotification({
      userId: reminder.userId, type: "TASK_REMINDER", title: "Task reminder",
      message: `Reminder: ${task.title}`, householdId: task.householdId, entityId: task.id,
    }, tx);
    const devices = await tx.deviceToken.findMany({ where: { userId: reminder.userId }, select: { id: true } });
    if (devices.length) await tx.taskReminderDelivery.createMany({ data: devices.map(device => ({
      reminderId: reminder.id, version: reminder.version, scheduledAt: reminder.nextRunAt!,
      notificationId: notification.id, deviceTokenId: device.id,
    })) });
    await tx.taskReminder.update({ where: { id: reminder.id }, data: reminder.repeat === "DAILY" ? {
      nextRunAt: nextDailyRun(reminder.localTime!, reminder.timeZone, now),
    } : { enabled: false, nextRunAt: null } });
    return true;
  });
}

export async function claimReminderDelivery(now = new Date()): Promise<TaskReminderDelivery | undefined> {
  const leaseId = randomUUID();
  const jobs = await prisma.$queryRaw<TaskReminderDelivery[]>`
    WITH candidate AS (
      SELECT id FROM "TaskReminderDelivery"
      WHERE "completedAt" IS NULL AND "failedAt" IS NULL AND "availableAt" <= ${now}
        AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now})
      ORDER BY "availableAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE "TaskReminderDelivery" AS job SET "leaseId" = ${leaseId},
      "leaseUntil" = ${new Date(now.getTime() + 60_000)}, attempts = attempts + 1
      FROM candidate WHERE job.id = candidate.id RETURNING job.*`;
  return jobs[0];
}

async function updateJob(job: TaskReminderDelivery, data: Prisma.TaskReminderDeliveryUpdateManyMutationInput) {
  await prisma.taskReminderDelivery.updateMany({
    where: { id: job.id, leaseId: job.leaseId }, data: { ...data, leaseId: null, leaseUntil: null },
  });
}

export async function processReminderDelivery(job: TaskReminderDelivery) {
  try {
    if (job.ticketId) {
      if (await getExpoReceipt(job.ticketId)) {
        await updateJob(job, { completedAt: new Date(), lastError: null });
      } else if (Date.now() - (job.ticketAt?.getTime() ?? job.createdAt.getTime()) > 86400_000) {
        throw new PushError("ReceiptExpired", false);
      } else {
        await updateJob(job, { attempts: 0, availableAt: new Date(Date.now() + 15 * 60_000) });
      }
      return;
    }
    const target = await prisma.taskReminderDelivery.findUnique({ where: { id: job.id }, include: {
      reminder: { include: { task: true, membership: true } }, deviceToken: true,
    } });
    const reminder = target?.reminder;
    const task = reminder?.task;
    if (!target || !reminder || !task || reminder.version !== job.version || task.status === "DONE" ||
      reminder.membership.userId !== reminder.userId || reminder.membership.householdId !== task.householdId ||
      target.deviceToken.userId !== reminder.userId || Date.now() - job.createdAt.getTime() > 3600_000) {
      await updateJob(job, { completedAt: new Date(), lastError: "CancelledOrExpired" });
      return;
    }
    const ticketId = await sendTaskReminderPush(target.deviceToken.token, {
      householdId: task.householdId, taskId: task.id, notificationId: job.notificationId, recipientId: reminder.userId,
    }, task.title);
    await updateJob(job, { ticketId, ticketAt: new Date(), attempts: 0,
      availableAt: new Date(Date.now() + 15 * 60_000), lastError: null });
  } catch (error) {
    if (error instanceof PushError && error.code === "DeviceNotRegistered") {
      await prisma.deviceToken.deleteMany({ where: { id: job.deviceTokenId } });
      return;
    }
    const failed = job.attempts >= 8 || (error instanceof PushError && !error.retryable);
    await updateJob(job, {
      ...(failed ? { failedAt: new Date() } : { availableAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** job.attempts)) }),
      lastError: error instanceof PushError ? error.code.slice(0, 100) : "DeliveryFailed",
    });
  }
}

const MAX_REMINDERS = 100;
const MAX_DELIVERIES = 50;
const RUN_BUDGET_MS = 20_000;

// Invoked by Supabase Cron through the protected HTTP endpoint. Nothing is
// scheduled on import or server startup. A later invocation resumes the backlog.
export async function processTaskReminderBatch() {
  const startedAt = Date.now();
  const pushEnabled = process.env["EXPO_PUSH_ENABLED"] === "true";
  let remindersProcessed = 0;
  let deliveriesProcessed = 0;
  let schedulesDone = false;
  let deliveriesDone = !pushEnabled;
  const withinBudget = () => Date.now() - startedAt < RUN_BUDGET_MS;

  // Alternate scheduling and delivery so a schedule backlog cannot consume the
  // entire request without sending already-queued pushes or checking receipts.
  while (withinBudget() && (!schedulesDone || !deliveriesDone)) {
    if (!schedulesDone) {
      if (await processDueReminder()) {
        remindersProcessed++;
        // A later schedule can enqueue pushes after an earlier empty queue check.
        if (pushEnabled && deliveriesProcessed < MAX_DELIVERIES) deliveriesDone = false;
      } else schedulesDone = true;
      if (remindersProcessed >= MAX_REMINDERS) schedulesDone = true;
    }
    if (!deliveriesDone && withinBudget()) {
      const job = await claimReminderDelivery();
      if (job) { await processReminderDelivery(job); deliveriesProcessed++; }
      else deliveriesDone = true;
      if (deliveriesProcessed >= MAX_DELIVERIES) deliveriesDone = true;
    }
  }

  await prisma.taskReminderDelivery.deleteMany({ where: { OR: [
    { completedAt: { lt: new Date(Date.now() - 7 * 86400_000) } },
    { failedAt: { lt: new Date(Date.now() - 30 * 86400_000) } },
    { ticketId: null, completedAt: null, failedAt: null, createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } },
  ] } });
  return {
    remindersProcessed, deliveriesProcessed, pushEnabled,
    // Indicates that another invocation may have more work; not an exact backlog count.
    batchLimitReached: remindersProcessed >= MAX_REMINDERS || deliveriesProcessed >= MAX_DELIVERIES || !withinBudget(),
  };
}
