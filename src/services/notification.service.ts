import { Prisma } from "../../generated/prisma/client.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";

// Keep the database column as text while the event list is still evolving.
export const NOTIFICATION_TYPES = [
  "TASK_ASSIGNED", "TASK_COMPLETED", "EXPENSE_ADDED", "EXPENSE_UPDATED",
  "HOUSEHOLD_INVITATION", "INVITATION_DECLINED", "MEMBER_JOINED", "MEMBER_REMOVED",
  "CHAT_MESSAGE",
] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

export type CreateNotificationInput = {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  // Where tapping the notification should lead. entityId is the task or
  // expense ID implied by the type; omit it for household-level events.
  householdId?: string;
  entityId?: string;
};

// Internal service: the calling service chooses the recipient and message.
// Pass its transaction as the second argument to save both records together.
export async function createNotification(
  input: CreateNotificationInput,
  db: Prisma.TransactionClient = prisma,
) {
  const userId = requiredText(input.userId, "Recipient user ID");
  const type = requiredText(input.type, "Notification type");
  if (!NOTIFICATION_TYPES.includes(type as NotificationType)) {
    throw new AppError("Invalid notification type", 400);
  }
  const title = requiredText(input.title, "Notification title");
  const message = requiredText(input.message, "Notification message");
  const target: { householdId?: string; entityId?: string } = {};
  if (input.householdId !== undefined) target.householdId = requiredText(input.householdId, "Household ID");
  if (input.entityId !== undefined) target.entityId = requiredText(input.entityId, "Entity ID");

  try {
    // PostgreSQL checks that userId references an existing user.
    // The schema supplies id, isRead = false, and createdAt automatically.
    const notification = await db.notification.create({
      data: { userId, type, title, message, ...target },
    });

    return notification;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw new AppError("Notification recipient not found", 404);
    }

    // Let the caller handle other failures, including transaction retries.
    throw error;
  }
}

// The display name of whoever caused an event, for the message text. Call it
// only when a notification is really being sent, so other requests pay nothing.
export async function actorName(db: Prisma.TransactionClient, userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name.trim() || "Someone";
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`${label} is required`, 400);
  }

  return value.trim();
}

export type NotificationQuery = {
  page: number;
  limit: number;
  unread?: boolean;
};

export async function getNotifications(userId: string, query: NotificationQuery) {
  const where: Prisma.NotificationWhereInput = { userId };
  if (query.unread !== undefined) where.isRead = !query.unread;

  // Both reads use the same database snapshot, so the total matches the page.
  return prisma.$transaction(async (tx) => {
    const notifications = await tx.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const total = await tx.notification.count({ where });
    return {
      notifications,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }, { isolationLevel: "RepeatableRead" });
}

export async function getUnreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

export async function markAsRead(userId: string, notificationId: string) {
  // Filtering by both IDs prevents changing another user's notification.
  // updateMany also succeeds when the notification is already read.
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true },
  });
  if (result?.count === 0) throw new AppError("Notification not found", 404);
}

export async function markAllAsRead(userId: string) {
  const result = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
  return result.count;
}

export async function deleteNotification(userId: string, notificationId: string) {
  const result = await prisma.notification.deleteMany({
    where: { id: notificationId, userId },
  });
  // Missing and someone else's notifications intentionally give the same error.
  if (result.count === 0) throw new AppError("Notification not found", 404);
}
