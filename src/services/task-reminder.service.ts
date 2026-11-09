import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction } from "../lib/transaction.js";
import { requireHouseholdMember } from "./household-access.service.js";
import { readReminderInput } from "../lib/reminder-time.js";

const select = {
  id: true, taskId: true, repeat: true, timeZone: true, localTime: true,
  nextRunAt: true, enabled: true, createdAt: true, updatedAt: true,
} satisfies Prisma.TaskReminderSelect;

async function access(tx: Prisma.TransactionClient, householdId: string, userId: string, taskId: string) {
  const member = await requireHouseholdMember(tx, householdId, userId);
  const task = await tx.task.findFirst({ where: { id: taskId, householdId }, select: { status: true } });
  if (!task) throw new AppError("Task not found", 404);
  return { member, task };
}

const transact = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => withSerializableTransaction(fn, {
  conflict: "Reminder changed concurrently; please retry", missing: "Task or membership no longer exists",
  retriesExhausted: "Reminder changed concurrently; please retry",
});

export function getTaskReminder(householdId: string, userId: string, taskId: string) {
  return transact(async tx => {
    await access(tx, householdId, userId, taskId);
    return tx.taskReminder.findUnique({ where: { taskId_userId: { taskId, userId } }, select });
  });
}

export function saveTaskReminder(householdId: string, userId: string, taskId: string, body: unknown) {
  const input = readReminderInput(body);
  return transact(async tx => {
    const { member, task } = await access(tx, householdId, userId, taskId);
    if (task.status === "DONE") throw new AppError("Completed tasks cannot have reminders", 400);
    return tx.taskReminder.upsert({
      where: { taskId_userId: { taskId, userId } },
      create: { ...input, taskId, userId, membershipId: member.id },
      update: { ...input, enabled: true, version: { increment: 1 } }, select,
    });
  });
}

export function deleteTaskReminder(householdId: string, userId: string, taskId: string) {
  return transact(async tx => {
    await access(tx, householdId, userId, taskId);
    await tx.taskReminder.deleteMany({ where: { taskId, userId } });
  });
}
