import { handleHouseholdRequest, readId } from "../lib/controller.js";
import { deleteTaskReminder, getTaskReminder, saveTaskReminder } from "../services/task-reminder.service.js";

const handle = handleHouseholdRequest("Reminder operation failed");
export const getReminder = handle(async (req, res, householdId, userId) => {
  const reminder = await getTaskReminder(householdId, userId, readId(req.params["taskId"], "Task ID"));
  return res.json({ reminder });
});
export const putReminder = handle(async (req, res, householdId, userId) => {
  const reminder = await saveTaskReminder(householdId, userId, readId(req.params["taskId"], "Task ID"), req.body);
  return res.json({ message: "Reminder saved", reminder });
});
export const removeReminder = handle(async (req, res, householdId, userId) => {
  await deleteTaskReminder(householdId, userId, readId(req.params["taskId"], "Task ID"));
  return res.json({ message: "Reminder removed" });
});
