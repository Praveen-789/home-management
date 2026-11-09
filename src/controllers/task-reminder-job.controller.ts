import type { Request, Response } from "express";
import { processTaskReminderBatch } from "../services/task-reminder-processing.service.js";

export async function runTaskReminderJob(_req: Request, res: Response) {
  try {
    const result = await processTaskReminderBatch();
    return res.json({ message: "Task reminder batch processed", ...result });
  } catch {
    // Never log request headers, secrets or database errors containing connection details.
    console.error("Task reminder cron batch failed; pending work will retry on the next invocation");
    return res.status(500).json({ message: "Task reminder batch failed; retry on the next invocation" });
  }
}
