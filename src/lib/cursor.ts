import { AppError } from "./errors.js";

// Where a list read in createdAt order stopped: the last row's time and ID. The ID tells apart rows
// made in the same millisecond. Pages continue from the last row rather than from a page number,
// so new rows arriving at the top never shift what the next page returns.
export type Cursor = { createdAt: Date; id: string };

// The app treats the cursor as an opaque string and only hands it back.
export const encodeCursor = ({ createdAt, id }: Cursor) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");

// Undefined means "start from the beginning". Anything the server could not have issued is a 400.
export function readCursor(value: unknown): Cursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 200) throw new AppError("Cursor is invalid", 400);
  const [at = "", id = "", ...rest] = Buffer.from(value, "base64url").toString("utf8").split("|");
  const createdAt = new Date(at);
  if (rest.length || !id || Number.isNaN(createdAt.getTime())) throw new AppError("Cursor is invalid", 400);
  return { createdAt, id };
}

// Rows after the cursor in a newest-first list, or in an oldest-first one.
export const olderThan = ({ createdAt, id }: Cursor) => ({
  OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
});
export const newerThan = ({ createdAt, id }: Cursor) => ({
  OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }],
});

// One page of a list read with `take: limit + 1`. The extra row is never returned; it only shows
// that more follow. nextCursor is null on the last page.
export function pageOf<Row extends Cursor, View>(rows: Row[], limit: number, view: (row: Row) => View) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items: items.map(view), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
