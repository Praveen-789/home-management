import { TaskPriority, TaskStatus } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readEnum, readId, readNullableDate, readNullableId, readNullableText, readPagination } from "../lib/controller.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { addTaskImage, createTask, deleteTask, getTask, listTasks, removeTaskImage, updateTask, type TaskInput, type TaskListQuery, type TaskPatch } from "../services/task.service.js";
import { readImageId, readImageInput } from "./image.controller.js";

const STATUSES = Object.values(TaskStatus);
const PRIORITIES = Object.values(TaskPriority);

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

const readListQuery = (query: Record<string, unknown>): TaskListQuery => {
  const listQuery: TaskListQuery = readPagination(query);
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

export const addImage = handle(async (req, res, householdId, requesterId) => {
  const task = await addTaskImage(householdId, requesterId, readTaskId(req), readImageInput(req.body));
  return res.status(201).json({ message: "Image added successfully", task });
});

export const removeImage = handle(async (req, res, householdId, requesterId) => {
  const task = await removeTaskImage(householdId, requesterId, readTaskId(req), readImageId(req));
  return res.status(200).json({ message: "Image removed successfully", task });
});
