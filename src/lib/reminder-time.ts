import { AppError } from "./errors.js";

export type ReminderInput = {
  repeat: "ONCE" | "DAILY";
  timeZone: string;
  localTime: string | null;
  nextRunAt: Date;
};

// Calendar calculations use the saved zone, never the server's local timezone.
// Missing DST times are skipped; repeated DST times use the first occurrence.
export function nextDailyRun(localTime: string, timeZone: string, after: Date): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = (date: Date) => {
    const values = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
    return { year: Number(values["year"]), month: Number(values["month"]), day: Number(values["day"]),
      hour: Number(values["hour"]), minute: Number(values["minute"]), second: Number(values["second"]) };
  };
  const wallEpoch = (p: ReturnType<typeof parts>) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const today = parts(after);
  const [hour, minute] = localTime.split(":").map(Number);
  // Collect both offsets around a transition, including half-hour DST changes.
  const offsets = new Set<number>();
  for (let h = -36; h <= 72; h += 6) {
    const instant = new Date(Math.floor(after.getTime() / 1000) * 1000 + h * 3600_000);
    offsets.add(wallEpoch(parts(instant)) - instant.getTime());
  }
  for (let day = 0; day < 4; day++) {
    const desired = Date.UTC(today.year, today.month - 1, today.day + day, hour!, minute!);
    const matches = [...offsets].map(offset => new Date(desired - offset))
      .filter(date => wallEpoch(parts(date)) === desired).sort((a, b) => a.getTime() - b.getTime());
    // Deliberately do not send a second time on a fall-back day.
    if (matches[0] && matches[0] > after) return matches[0];
  }
  throw new Error("Could not calculate the next daily reminder");
}

export function readReminderInput(body: unknown, now = new Date()): ReminderInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Reminder settings are required", 400);
  const input = body as Record<string, unknown>;
  if (input["repeat"] !== "ONCE" && input["repeat"] !== "DAILY") throw new AppError("Repeat must be ONCE or DAILY", 400);
  const timeZone = input["timeZone"];
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new AppError("Time zone is required", 400);
  try { new Intl.DateTimeFormat("en", { timeZone }).format(now); }
  catch { throw new AppError("Time zone must be a valid IANA time zone", 400); }
  if (input["repeat"] === "DAILY") {
    const localTime = input["localTime"];
    if (typeof localTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
      throw new AppError("Local time must use HH:mm (24-hour format)", 400);
    }
    if (input["remindAt"] !== undefined) throw new AppError("Daily reminders use localTime, not remindAt", 400);
    return { repeat: "DAILY", timeZone, localTime, nextRunAt: nextDailyRun(localTime, timeZone, now) };
  }
  const remindAt = input["remindAt"];
  if (typeof remindAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(remindAt)) {
    throw new AppError("Remind at must be an ISO date-time with a timezone offset", 400);
  }
  const nextRunAt = new Date(remindAt);
  const calendarDate = new Date(`${remindAt.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== remindAt.slice(0, 10) ||
    Number(remindAt.slice(11, 13)) > 23) {
    throw new AppError("Remind at must contain a valid calendar date and time", 400);
  }
  if (!Number.isFinite(nextRunAt.getTime()) || nextRunAt <= now) throw new AppError("Reminder must be in the future", 400);
  if (input["localTime"] !== undefined) throw new AppError("One-time reminders use remindAt, not localTime", 400);
  return { repeat: "ONCE", timeZone, localTime: null, nextRunAt };
}
