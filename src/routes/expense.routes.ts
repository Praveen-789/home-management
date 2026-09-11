import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { addImage, create, get, list, remove, removeImage, summary, update } from "../controllers/expense.controller.js";

// mergeParams lets these handlers read :householdId from the parent router.
const router = Router({ mergeParams: true });

router.get("/", authenticate, list);
// Declared before /:expenseId so "summary" is never read as an expense ID.
router.get("/summary", authenticate, summary);
router.post("/", authenticate, create);
router.get("/:expenseId", authenticate, get);
router.patch("/:expenseId", authenticate, update);
router.delete("/:expenseId", authenticate, remove);
router.post("/:expenseId/images", authenticate, addImage);
router.delete("/:expenseId/images/:imageId", authenticate, removeImage);

export default router;
