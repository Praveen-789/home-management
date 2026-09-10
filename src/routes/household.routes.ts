import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { create, list as listHouseholds } from "../controllers/household.controller.js";
import { add, list, remove, updateRole } from "../controllers/household-member.controller.js";
import taskRoutes from "./task.routes.js";

const router = Router();

router.post("/", authenticate, create);
router.get("/", authenticate, listHouseholds);
router.get("/:householdId/members", authenticate, list);
router.post("/:householdId/members", authenticate, add);
router.patch("/:householdId/members/:userId", authenticate, updateRole);
router.delete("/:householdId/members/:userId", authenticate, remove);
router.use("/:householdId/tasks", taskRoutes);

export default router;

