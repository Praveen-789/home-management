import type { HouseholdRole, Prisma, TaskPriority, TaskStatus } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import { requireHouseholdMember } from "./household-access.service.js";
import { attachImage, detachImage, imagePublicIds, imagesSelect, withImages, type ImageInput } from "./image.service.js";
import { imageStorage } from "../lib/cloudinary.js";

// Fields a client may set. Nullable fields accept null to clear them.
export type TaskInput = {
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
  assignedToId?: string | null;
};

// A PATCH carries only the fields the client sent.
export type TaskPatch = Partial<TaskInput>;

// Filter and paging for the list endpoint. page is 1-based.
export type TaskListQuery = {
  status?: TaskStatus;
  page: number;
  limit: number;
};

const userSummary = { select: { id: true, name: true, email: true } } as const;

// Fields returned to the controller. User passwords are never selected.
const taskSelect = {
  id: true,
  householdId: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  dueDate: true,
  createdAt: true,
  updatedAt: true,
  createdBy: userSummary,
  assignedTo: userSummary,
  images: imagesSelect,
} satisfies Prisma.TaskSelect;

// Dated tasks first, soonest due first; undated tasks follow, newest first.
const taskOrder = [
  { dueDate: { sort: "asc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "asc" },
] satisfies Prisma.TaskOrderByWithRelationInput[];

const taskMessages: TransactionMessages = {
  conflict: "Task conflicts with an existing task",
  missing: "Household, member, or task no longer exists",
  retriesExhausted: "Tasks changed concurrently; please retry",
};

const withTaskTransaction = <Result>(
  operation: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> => withSerializableTransaction(operation, taskMessages);

export async function listTasks(householdId: string, requesterId: string, query: TaskListQuery) {
  return withTaskTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);

    // One filter drives both the page and the total so they always agree.
    const where: Prisma.TaskWhereInput = { householdId };
    if (query.status) where.status = query.status;

    const tasks = await tx.task.findMany({
      where,
      select: taskSelect,
      orderBy: taskOrder,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const total = await tx.task.count({ where });
    

    return {
      tasks: tasks.map(withImages),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  });
}

export async function getTask(householdId: string, requesterId: string, taskId: string) {
  return withTaskTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);

    const task = await tx.task.findFirst({
      where: { id: taskId, householdId },
      select: taskSelect,
    });

    if (!task) {
      throw new AppError("Task not found", 404);
    }

    return withImages(task);
  });
}

export async function createTask(householdId: string, requesterId: string, input: TaskInput) {
  return withTaskTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);

    if (input.assignedToId) {
      await requireAssignee(tx, householdId, input.assignedToId);
    }

    // The household comes from the URL and the creator from the token, never the body.
    const task = await tx.task.create({
      data: { ...input, householdId, createdById: requesterId },
      select: taskSelect,
    });
    return withImages(task);
  });
}

export async function updateTask(
  householdId: string,
  requesterId: string,
  taskId: string,
  patch: TaskPatch,
) {
  return withTaskTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const task = await requireTask(tx, householdId, taskId);
    requireTaskEdit(requester.role, requesterId, task, patch);

    if (patch.assignedToId) {
      await requireAssignee(tx, householdId, patch.assignedToId);
    }

    const updated = await tx.task.update({
      where: { id: task.id, householdId },
      data: patch,
      select: taskSelect,
    });
    return withImages(updated);
  });
}

export async function deleteTask(householdId: string, requesterId: string, taskId: string) {
  const publicIds = await withTaskTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const task = await requireTask(tx, householdId, taskId);
    requireTaskManagement(requester.role, requesterId, task);

    // Collected before the delete cascades the image rows away.
    const publicIds = await imagePublicIds(tx, { taskId: task.id });
    await tx.task.delete({ where: { id: task.id, householdId } });
    return publicIds;
  });
  if (publicIds.length > 0) void imageStorage.destroy(publicIds);
}

// Photos may be added and removed by anyone who may change the task's status: managers and the
// assignee, since either may want to show the work. The task is returned with its images.
export async function addTaskImage(householdId: string, requesterId: string, taskId: string, input: ImageInput) {
  return withTaskTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const task = await requireTask(tx, householdId, taskId);
    requireTaskImageAccess(requester.role, requesterId, task);

    await attachImage(tx, householdId, requesterId, { taskId: task.id }, input);
    return loadTask(tx, householdId, task.id);
  });
}

export async function removeTaskImage(householdId: string, requesterId: string, taskId: string, imageId: string) {
  const { task, publicId } = await withTaskTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const task = await requireTask(tx, householdId, taskId);
    requireTaskImageAccess(requester.role, requesterId, task);

    const publicId = await detachImage(tx, { taskId: task.id }, imageId);
    return { task: await loadTask(tx, householdId, task.id), publicId };
  });
  void imageStorage.destroy([publicId]);
  return task;
}

// The task as the API returns it, fetched again after its images changed.
async function loadTask(tx: Prisma.TransactionClient, householdId: string, taskId: string) {
  const task = await tx.task.findFirst({ where: { id: taskId, householdId }, select: taskSelect });
  if (!task) {
    throw new AppError("Task not found", 404);
  }
  return withImages(task);
}

// The columns permission decisions depend on.
type TaskOwnership = { id: string; createdById: string; assignedToId: string | null };

// OWNER and ADMIN manage every task; a MEMBER manages only the tasks they created.
const canManageTask = (role: HouseholdRole, requesterId: string, task: TaskOwnership) =>
  role !== "MEMBER" || task.createdById === requesterId;

const requireTaskManagement = (role: HouseholdRole, requesterId: string, task: TaskOwnership) => {
  if (!canManageTask(role, requesterId, task)) {
    throw new AppError("You can only manage tasks you created", 403);
  }
};

// Managers may change anything. The assignee may change only the status, so they
// can mark their own chore done without being able to rewrite or reassign it.
const requireTaskEdit = (
  role: HouseholdRole,
  requesterId: string,
  task: TaskOwnership,
  patch: TaskPatch,
) => {
  if (canManageTask(role, requesterId, task)) return;

  const isAssignee = task.assignedToId === requesterId;
  const statusOnly = Object.keys(patch).every((field) => field === "status");
  if (isAssignee && statusOnly) return;

  throw new AppError(
    isAssignee
      ? "Assignees can only update the task status"
      : "You can only update tasks you created or are assigned to",
    403,
  );
};

// Managers and the assignee may attach and remove photos, the same people who may change the status.
const requireTaskImageAccess = (role: HouseholdRole, requesterId: string, task: TaskOwnership) => {
  if (canManageTask(role, requesterId, task) || task.assignedToId === requesterId) return;
  throw new AppError("You can only manage images on tasks you created or are assigned to", 403);
};

async function requireTask(tx: Prisma.TransactionClient, householdId: string, taskId: string) {
  const task = await tx.task.findFirst({
    where: { id: taskId, householdId },
    select: { id: true, createdById: true, assignedToId: true },
  });

  if (!task) {
    throw new AppError("Task not found", 404);
  }

  return task;
}

// A task can only be assigned to someone who belongs to the same household.
async function requireAssignee(tx: Prisma.TransactionClient, householdId: string, userId: string) {
  const member = await tx.householdMember.findUnique({
    where: { userId_householdId: { userId, householdId } },
    select: { id: true },
  });

  if (!member) {
    throw new AppError("Assignee must be a member of this household", 400);
  }
}
