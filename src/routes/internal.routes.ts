import { Router } from "express";
import { authenticateCron } from "../middleware/cron-auth.middleware.js";
import { runTaskReminderJob } from "../controllers/task-reminder-job.controller.js";

const router = Router();
router.post("/task-reminders/run", authenticateCron, runTaskReminderJob);
export default router;
