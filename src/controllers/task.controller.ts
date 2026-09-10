import { TaskPriority, TaskStatus } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readId } from "../lib/controller.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { createTask, deleteTask, getTask, listTasks, updateTask, type TaskInput, type TaskListQuery, type TaskPatch } from "../services/task.service.js";

const STATUSES = Object.values(TaskStatus);
const PRIORITIES = Object.values(TaskPriority);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_PAGE = 100_000;

const readEnum = <Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value => {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as Value;
  throw new AppError(`${label} must be one of ${allowed.join(", ")}`, 400);
};

// Optional text: null clears it, and a blank string is treated the same way.
const readNullableText = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") throw new AppError(`${label} must be a string or null`, 400);
  return value.trim() || null;
};

const readNullableDate = (value: unknown, label: string): Date | null => {
  if (value === null) return null;
  const date = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new AppError(`${label} must be an ISO 8601 date string or null`, 400);
  return date;
};

const readNullableId = (value: unknown, label: string): string | null =>
  value === null ? null : readId(value, label);

// Reads only the recognized fields that are present, so unknown properties are
// ignored and absent ones are never sent to Prisma. Nothing here can set the
// household or creator; those come from the URL and the token.
const readPatch = (body: unknown): TaskPatch => {
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: TaskPatch = {};
  if (source["title"] !== undefined) patch.title = readId(source["title"], "Title");
  if (source["description"] !== undefined) patch.description = readNullableText(source["description"], "Description");
  if (source["status"] !== undefined) patch.status = readEnum(source["status"], STATUSES, "Status");
  if (source["priority"] !== undefined) patch.priority = readEnum(source["priority"], PRIORITIES, "Priority");
  if (source["dueDate"] !== undefined) patch.dueDate = readNullableDate(source["dueDate"], "Due date");
  if (source["assignedToId"] !== undefined) patch.assignedToId = readNullableId(source["assignedToId"], "Assignee user ID");
  return patch;
};

const readCreateInput = (body: unknown): TaskInput => {
  const patch = readPatch(body);
  if (patch.title === undefined) throw new AppError("Title is required", 400);
  return { ...patch, title: patch.title };
};

const readUpdateInput = (body: unknown): TaskPatch => {
  const patch = readPatch(body);
  if (Object.keys(patch).length === 0) {
    throw new AppError("Provide at least one of: title, description, status, priority, dueDate, assignedToId", 400);
  }
  return patch;
};

// Query-string numbers arrive as strings. Only plain digits are accepted, so
// "1.5", "-1", and a repeated parameter (which Express turns into an array)
// are rejected instead of being silently coerced.
const readInteger = (value: unknown, label: string, min: number, max: number, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= min && parsed <= max)) throw new AppError(`${label} must be an integer between ${min} and ${max}`, 400);
  return parsed;
};

const readListQuery = (query: Record<string, unknown>): TaskListQuery => {
  const listQuery: TaskListQuery = {
    page: readInteger(query["page"], "Page", 1, MAX_PAGE, 1),
    limit: readInteger(query["limit"], "Limit", 1, MAX_LIMIT, DEFAULT_LIMIT),
  };
  if (query["status"] !== undefined) listQuery.status = readEnum(query["status"], STATUSES, "Status");
  return listQuery;
};

const readTaskId = (req: AuthenticatedRequest) => readId(req.params["taskId"], "Task ID");

const handle = handleHouseholdRequest("Task operation failed");

export const list = handle(async (req, res, householdId, requesterId) => {
  const { tasks, pagination } = await listTasks(householdId, requesterId, readListQuery(req.query));
  return res.status(200).json({ message: "Tasks fetched successfully", tasks, pagination });
});

export const get = handle(async (req, res, householdId, requesterId) => {
  const task = await getTask(householdId, requesterId, readTaskId(req));
  return res.status(200).json({ message: "Task fetched successfully", task });
});

export const create = handle(async (req, res, householdId, requesterId) => {
  const task = await createTask(householdId, requesterId, readCreateInput(req.body));
  return res.status(201).json({ message: "Task created successfully", task });
});

export const update = handle(async (req, res, householdId, requesterId) => {
  const task = await updateTask(householdId, requesterId, readTaskId(req), readUpdateInput(req.body));
  return res.status(200).json({ message: "Task updated successfully", task });
});

export const remove = handle(async (req, res, householdId, requesterId) => {
  await deleteTask(householdId, requesterId, readTaskId(req));
  return res.status(200).json({ message: "Task deleted successfully" });
});
