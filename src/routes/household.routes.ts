import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { create, list as listHouseholds } from "../controllers/household.controller.js";
import { add, list, remove, updateRole } from "../controllers/household-member.controller.js";
import taskRoutes from "./task.routes.js";
import expenseRoutes from "./expense.routes.js";
import { authorizeUpload } from "../controllers/image.controller.js";

const router = Router();

router.post("/", authenticate, create);
router.get("/", authenticate, listHouseholds);
router.get("/:householdId/members", authenticate, list);
router.post("/:householdId/members", authenticate, add);
router.patch("/:householdId/members/:userId", authenticate, updateRole);
router.delete("/:householdId/members/:userId", authenticate, remove);
// Signs one direct-to-Cloudinary upload for a member; the file is attached to a task or expense afterwards.
router.post("/:householdId/uploads", authenticate, authorizeUpload);
router.use("/:householdId/tasks", taskRoutes);
router.use("/:householdId/expenses", expenseRoutes);

export default router;

