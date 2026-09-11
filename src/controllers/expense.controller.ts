import { ExpenseCategory } from "../../generated/prisma/client.js";
import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readDate, readEnum, readId, readNullableId, readNullableText, readPagination } from "../lib/controller.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { readImageId, readImageInput } from "./image.controller.js";
import {
  addExpenseImage,
  createExpense,
  deleteExpense,
  getExpense,
  listExpenses,
  removeExpenseImage,
  summarizeExpenses,
  updateExpense,
  type ExpenseFilter,
  type ExpenseInput,
  type ExpenseListQuery,
  type ExpensePatch,
} from "../services/expense.service.js";

const CATEGORIES = Object.values(ExpenseCategory);

// Money is validated as text so nothing passes through a float. Up to ten
// digits before the point and two after is what the numeric(12, 2) column holds.
const AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;

const readAmount = (value: unknown): string => {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !AMOUNT_PATTERN.test(text) || Number(text) === 0) {
    throw new AppError("Amount must be a positive number below 10000000000 with at most 2 decimal places", 400);
  }
  // Normalize to two places: "1250" becomes "1250.00" and "0012.5" becomes "12.50".
  const [whole = "0", fraction = ""] = text.split(".");
  return `${Number(whole)}.${fraction.padEnd(2, "0")}`;
};

// Reads only the recognized fields that are present, so unknown properties are
// ignored and absent ones are never sent to Prisma. Nothing here can set the
// household or recorder; those come from the URL and the token.
const readPatch = (body: unknown): ExpensePatch => {
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: ExpensePatch = {};
  if (source["amount"] !== undefined) patch.amount = readAmount(source["amount"]);
  if (source["description"] !== undefined) patch.description = readNullableText(source["description"], "Description");
  if (source["category"] !== undefined) patch.category = readEnum(source["category"], CATEGORIES, "Category");
  if (source["paidById"] !== undefined) patch.paidById = readId(source["paidById"], "Payer user ID");
  if (source["taskId"] !== undefined) patch.taskId = readNullableId(source["taskId"], "Task ID");
  return patch;
};

const readCreateInput = (body: unknown): ExpenseInput => {
  const patch = readPatch(body);
  if (patch.amount === undefined) throw new AppError("Amount is required", 400);
  return { ...patch, amount: patch.amount };
};

const readUpdateInput = (body: unknown): ExpensePatch => {
  const patch = readPatch(body);
  if (Object.keys(patch).length === 0) {
    throw new AppError("Provide at least one of: amount, description, category, paidById, taskId", 400);
  }
  return patch;
};

// Filters shared by the list and the summary. Paging is read separately.
const readFilter = (query: Record<string, unknown>): ExpenseFilter => {
  const filter: ExpenseFilter = {};
  if (query["category"] !== undefined) filter.category = readEnum(query["category"], CATEGORIES, "Category");
  if (query["paidById"] !== undefined) filter.paidById = readId(query["paidById"], "Payer user ID");
  if (query["taskId"] !== undefined) filter.taskId = readId(query["taskId"], "Task ID");
  if (query["from"] !== undefined) filter.from = readDate(query["from"], "From");
  if (query["to"] !== undefined) filter.to = readDate(query["to"], "To");
  if (filter.from && filter.to && filter.from > filter.to) throw new AppError("From must not be after to", 400);
  return filter;
};

const readListQuery = (query: Record<string, unknown>): ExpenseListQuery => ({
  ...readFilter(query),
  ...readPagination(query),
});

const readExpenseId = (req: AuthenticatedRequest) => readId(req.params["expenseId"], "Expense ID");

const handle = handleHouseholdRequest("Expense operation failed");

export const list = handle(async (req, res, householdId, requesterId) => {
  const { expenses, pagination } = await listExpenses(householdId, requesterId, readListQuery(req.query));
  return res.status(200).json({ message: "Expenses fetched successfully", expenses, pagination });
});

export const summary = handle(async (req, res, householdId, requesterId) => {
  const summary = await summarizeExpenses(householdId, requesterId, readFilter(req.query));
  return res.status(200).json({ message: "Expense summary fetched successfully", summary });
});

export const get = handle(async (req, res, householdId, requesterId) => {
  const expense = await getExpense(householdId, requesterId, readExpenseId(req));
  return res.status(200).json({ message: "Expense fetched successfully", expense });
});

export const create = handle(async (req, res, householdId, requesterId) => {
  const expense = await createExpense(householdId, requesterId, readCreateInput(req.body));
  return res.status(201).json({ message: "Expense created successfully", expense });
});

export const update = handle(async (req, res, householdId, requesterId) => {
  const expense = await updateExpense(householdId, requesterId, readExpenseId(req), readUpdateInput(req.body));
  return res.status(200).json({ message: "Expense updated successfully", expense });
});

export const remove = handle(async (req, res, householdId, requesterId) => {
  await deleteExpense(householdId, requesterId, readExpenseId(req));
  return res.status(200).json({ message: "Expense deleted successfully" });
});

export const addImage = handle(async (req, res, householdId, requesterId) => {
  const expense = await addExpenseImage(householdId, requesterId, readExpenseId(req), readImageInput(req.body));
  return res.status(201).json({ message: "Image added successfully", expense });
});

export const removeImage = handle(async (req, res, householdId, requesterId) => {
  const expense = await removeExpenseImage(householdId, requesterId, readExpenseId(req), readImageId(req));
  return res.status(200).json({ message: "Image removed successfully", expense });
});
