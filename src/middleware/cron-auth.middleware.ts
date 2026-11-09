import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Independent of user JWTs: only the scheduler should invoke internal jobs.
export function authenticateCron(req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env["TASK_REMINDER_CRON_SECRET"];
  if (!secret || secret.length < 32 || /\s/.test(secret)) {
    return res.status(503).json({ message: "Task reminder cron is not configured" });
  }
  const supplied = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!supplied || !timingSafeEqual(digest(supplied), digest(secret))) {
    return res.status(401).json({ message: "Invalid cron credentials" });
  }
  next();
}
