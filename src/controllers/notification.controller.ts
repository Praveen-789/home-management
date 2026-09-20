import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { AppError } from "../lib/errors.js";
import { readId, readPagination } from "../lib/controller.js";
import * as notificationService from "../services/notification.service.js";

// Authentication middleware sets userId from the token, never from the body.
function getUserId(req: AuthenticatedRequest): string {
  if (!req.userId) throw new AppError("Authentication is required", 401);
  return req.userId;
}

function sendError(res: Response, error: unknown) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(error);
  return res.status(500).json({ message: "Notification operation failed" });
}

export async function list(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = getUserId(req);
    const query: notificationService.NotificationQuery = readPagination(req.query);
    const unread = req.query["unread"];
    if (unread !== undefined) {
      if (unread !== "true" && unread !== "false") {
        throw new AppError("Unread must be true or false", 400);
      }
      query.unread = unread === "true";
    }
    const result = await notificationService.getNotifications(userId, query);
    return res.status(200).json({ message: "Notifications fetched successfully", ...result });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function unreadCount(req: AuthenticatedRequest, res: Response) {
  try {
    const count = await notificationService.getUnreadCount(getUserId(req));
    return res.status(200).json({ unreadCount: count });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function read(req: AuthenticatedRequest, res: Response) {
  try {
    await notificationService.markAsRead(getUserId(req), readId(req.params["id"], "Notification ID"));
    return res.status(200).json({ message: "Notification marked as read" });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function readAll(req: AuthenticatedRequest, res: Response) {
  try {
    const updatedCount = await notificationService.markAllAsRead(getUserId(req));
    return res.status(200).json({ message: "Notifications marked as read", updatedCount });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function remove(req: AuthenticatedRequest, res: Response) {
  try {
    await notificationService.deleteNotification(getUserId(req), readId(req.params["id"], "Notification ID"));
    return res.status(200).json({ message: "Notification deleted successfully" });
  } catch (error) {
    return sendError(res, error);
  }
}
