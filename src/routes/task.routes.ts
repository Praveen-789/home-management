import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { addImage, create, get, list, remove, removeImage, update } from "../controllers/task.controller.js";

// mergeParams lets these handlers read :householdId from the parent router.
const router = Router({ mergeParams: true });

router.get("/", authenticate, list);
router.post("/", authenticate, create);
router.get("/:taskId", authenticate, get);
router.patch("/:taskId", authenticate, update);
router.delete("/:taskId", authenticate, remove);
router.post("/:taskId/images", authenticate, addImage);
router.delete("/:taskId/images/:imageId", authenticate, removeImage);

export default router;
