import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { create, get, list, remove, update } from "../controllers/task.controller.js";

// mergeParams lets these handlers read :householdId from the parent router.
const router = Router({ mergeParams: true });

router.get("/", authenticate, list);
router.post("/", authenticate, create);
router.get("/:taskId", authenticate, get);
router.patch("/:taskId", authenticate, update);
router.delete("/:taskId", authenticate, remove);

export default router;
