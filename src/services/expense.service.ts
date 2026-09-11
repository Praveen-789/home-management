import type { ExpenseCategory, HouseholdRole, Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { withSerializableTransaction, type TransactionMessages } from "../lib/transaction.js";
import { requireHouseholdMember } from "./household-access.service.js";
import { attachImage, detachImage, imagePublicIds, imagesSelect, toImageView, type ImageInput, type ImageRow } from "./image.service.js";
import { imageStorage } from "../lib/cloudinary.js";

// Fields a client may set. amount is a validated decimal string such as "1250.00",
// so no value passes through a float. Nullable fields accept null to clear them.
export type ExpenseInput = {
  amount: string;
  description?: string | null;
  category?: ExpenseCategory;
  paidById?: string;
  taskId?: string | null;
};

// A PATCH carries only the fields the client sent.
export type ExpensePatch = Partial<ExpenseInput>;

// Filters shared by the list and summary endpoints. from and to bound createdAt.
export type ExpenseFilter = {
  category?: ExpenseCategory;
  paidById?: string;
  taskId?: string;
  from?: Date;
  to?: Date;
};

// Filter and paging for the list endpoint. page is 1-based.
export type ExpenseListQuery = ExpenseFilter & { page: number; limit: number };

const userSummary = { select: { id: true, name: true, email: true } } as const;

// Fields returned to the controller. User passwords are never selected.
const expenseSelect = {
  id: true,
  householdId: true,
  amount: true,
  description: true,
  category: true,
  createdAt: true,
  updatedAt: true,
  paidBy: userSummary,
  createdBy: userSummary,
  task: { select: { id: true, title: true, status: true } },
  images: imagesSelect,
} satisfies Prisma.ExpenseSelect;

// Newest first; the ID tiebreak keeps pages stable.
const expenseOrder = [{ createdAt: "desc" }, { id: "asc" }] satisfies Prisma.ExpenseOrderByWithRelationInput[];

const expenseMessages: TransactionMessages = {
  conflict: "Expense conflicts with an existing expense",
  missing: "Household, member, task, or expense no longer exists",
  retriesExhausted: "Expenses changed concurrently; please retry",
};

const withExpenseTransaction = <Result>(
  operation: (tx: Prisma.TransactionClient) => Promise<Result>,
): Promise<Result> => withSerializableTransaction(operation, expenseMessages);

// Postgres returns numeric columns as Decimal. The API always sends two places,
// so 1250 and 1250.5 leave as "1250.00" and "1250.50" rather than as floats.
const money = (value: Prisma.Decimal | null) => (value ? value.toFixed(2) : "0.00");

// Images lose their public ID in favour of the delivery URLs derived from it.
const serialize = <Row extends { amount: Prisma.Decimal; images: ImageRow[] }>({ amount, images, ...expense }: Row) => ({
  ...expense,
  amount: money(amount),
  images: images.map(toImageView),
});

// One filter drives the page, the total, and the summary so they always agree.
const expenseWhere = (householdId: string, filter: ExpenseFilter): Prisma.ExpenseWhereInput => {
  const where: Prisma.ExpenseWhereInput = { householdId };
  if (filter.category) where.category = filter.category;
  if (filter.paidById) where.paidById = filter.paidById;
  if (filter.taskId) where.taskId = filter.taskId;
  if (filter.from || filter.to) {
    where.createdAt = { ...(filter.from && { gte: filter.from }), ...(filter.to && { lte: filter.to }) };
  }
  return where;
};

export async function listExpenses(householdId: string, requesterId: string, query: ExpenseListQuery) {
  return withExpenseTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    const where = expenseWhere(householdId, query);

    const expenses = await tx.expense.findMany({
      where,
      select: expenseSelect,
      orderBy: expenseOrder,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const total = await tx.expense.count({ where });

    return {
      expenses: expenses.map(serialize),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  });
}

// Totals for the same filters the list accepts, grouped by category and by payer.
// Sums are computed by Postgres on the numeric column, never in JavaScript.
export async function summarizeExpenses(householdId: string, requesterId: string, filter: ExpenseFilter) {
  return withExpenseTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);
    const where = expenseWhere(householdId, filter);

    const overall = await tx.expense.aggregate({ where, _sum: { amount: true }, _count: { _all: true } });
    const byCategory = await tx.expense.groupBy({
      by: ["category"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: "desc" } },
    });
    const byPayer = await tx.expense.groupBy({
      by: ["paidById"],
      where,
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: "desc" } },
    });
    const users = byPayer.length
      ? await tx.user.findMany({ where: { id: { in: byPayer.map((group) => group.paidById) } }, select: userSummary.select })
      : [];
    const payers = new Map(users.map((user) => [user.id, user]));

    return {
      total: money(overall._sum.amount),
      count: overall._count._all,
      byCategory: byCategory.map((group) => ({
        category: group.category,
        total: money(group._sum.amount),
        count: group._count._all,
      })),
      // Every payer still exists: the foreign key blocks deleting a user who paid for anything.
      byPayer: byPayer.map((group) => ({
        paidBy: payers.get(group.paidById) ?? null,
        total: money(group._sum.amount),
        count: group._count._all,
      })),
    };
  });
}

export async function getExpense(householdId: string, requesterId: string, expenseId: string) {
  return withExpenseTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);

    const expense = await tx.expense.findFirst({
      where: { id: expenseId, householdId },
      select: expenseSelect,
    });

    if (!expense) {
      throw new AppError("Expense not found", 404);
    }

    return serialize(expense);
  });
}

export async function createExpense(householdId: string, requesterId: string, input: ExpenseInput) {
  return withExpenseTransaction(async (tx) => {
    await requireHouseholdMember(tx, householdId, requesterId);

    // The requester paid unless the body names another member. The requester
    // was just verified as a member, so only a different payer needs a lookup.
    const paidById = input.paidById ?? requesterId;
    if (paidById !== requesterId) {
      await requirePayer(tx, householdId, paidById);
    }
    if (input.taskId) {
      await requireHouseholdTask(tx, householdId, input.taskId);
    }

    // The household comes from the URL and the recorder from the token, never the body.
    const expense = await tx.expense.create({
      data: { ...input, paidById, householdId, createdById: requesterId },
      select: expenseSelect,
    });
    return serialize(expense);
  });
}

export async function updateExpense(
  householdId: string,
  requesterId: string,
  expenseId: string,
  patch: ExpensePatch,
) {
  return withExpenseTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const expense = await requireExpense(tx, householdId, expenseId);
    requireExpenseManagement(requester.role, requesterId, expense);

    if (patch.paidById && patch.paidById !== requesterId) {
      await requirePayer(tx, householdId, patch.paidById);
    }
    if (patch.taskId) {
      await requireHouseholdTask(tx, householdId, patch.taskId);
    }

    const updated = await tx.expense.update({
      where: { id: expense.id, householdId },
      data: patch,
      select: expenseSelect,
    });
    return serialize(updated);
  });
}

export async function deleteExpense(householdId: string, requesterId: string, expenseId: string) {
  const publicIds = await withExpenseTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const expense = await requireExpense(tx, householdId, expenseId);
    requireExpenseManagement(requester.role, requesterId, expense);

    // Collected before the delete cascades the image rows away.
    const publicIds = await imagePublicIds(tx, { expenseId: expense.id });
    await tx.expense.delete({ where: { id: expense.id, householdId } });
    return publicIds;
  });
  if (publicIds.length > 0) void imageStorage.destroy(publicIds);
}

// Receipts may be added and removed by whoever may edit the expense. It is returned with its images.
export async function addExpenseImage(householdId: string, requesterId: string, expenseId: string, input: ImageInput) {
  return withExpenseTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const expense = await requireExpense(tx, householdId, expenseId);
    requireExpenseManagement(requester.role, requesterId, expense);

    await attachImage(tx, householdId, requesterId, { expenseId: expense.id }, input);
    return loadExpense(tx, householdId, expense.id);
  });
}

export async function removeExpenseImage(householdId: string, requesterId: string, expenseId: string, imageId: string) {
  const { expense, publicId } = await withExpenseTransaction(async (tx) => {
    const requester = await requireHouseholdMember(tx, householdId, requesterId);
    const expense = await requireExpense(tx, householdId, expenseId);
    requireExpenseManagement(requester.role, requesterId, expense);

    const publicId = await detachImage(tx, { expenseId: expense.id }, imageId);
    return { expense: await loadExpense(tx, householdId, expense.id), publicId };
  });
  void imageStorage.destroy([publicId]);
  return expense;
}

// The expense as the API returns it, fetched again after its images changed.
async function loadExpense(tx: Prisma.TransactionClient, householdId: string, expenseId: string) {
  const expense = await tx.expense.findFirst({ where: { id: expenseId, householdId }, select: expenseSelect });
  if (!expense) {
    throw new AppError("Expense not found", 404);
  }
  return serialize(expense);
}

// The columns permission decisions depend on.
type ExpenseOwnership = { id: string; createdById: string; paidById: string };

// OWNER and ADMIN manage every expense. A MEMBER manages the expenses they
// recorded or paid for, since either person may need to correct it.
const canManageExpense = (role: HouseholdRole, requesterId: string, expense: ExpenseOwnership) =>
  role !== "MEMBER" || expense.createdById === requesterId || expense.paidById === requesterId;

const requireExpenseManagement = (role: HouseholdRole, requesterId: string, expense: ExpenseOwnership) => {
  if (!canManageExpense(role, requesterId, expense)) {
    throw new AppError("You can only manage expenses you recorded or paid", 403);
  }
};

async function requireExpense(tx: Prisma.TransactionClient, householdId: string, expenseId: string) {
  const expense = await tx.expense.findFirst({
    where: { id: expenseId, householdId },
    select: { id: true, createdById: true, paidById: true },
  });

  if (!expense) {
    throw new AppError("Expense not found", 404);
  }

  return expense;
}

// Only a member of the household can be recorded as the payer.
async function requirePayer(tx: Prisma.TransactionClient, householdId: string, userId: string) {
  const member = await tx.householdMember.findUnique({
    where: { userId_householdId: { userId, householdId } },
    select: { id: true },
  });

  if (!member) {
    throw new AppError("Payer must be a member of this household", 400);
  }
}

// An expense can only be linked to a task in the same household.
async function requireHouseholdTask(tx: Prisma.TransactionClient, householdId: string, taskId: string) {
  const task = await tx.task.findFirst({
    where: { id: taskId, householdId },
    select: { id: true },
  });

  if (!task) {
    throw new AppError("Task must belong to this household", 400);
  }
}
