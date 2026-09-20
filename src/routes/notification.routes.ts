import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { list, unreadCount, read, readAll, remove } from "../controllers/notification.controller.js";

const router = Router();
router.use(authenticate);

router.get("/", list);
router.get("/unread-count", unreadCount);
router.patch("/read-all", readAll);
router.patch("/:id/read", read);
router.delete("/:id", remove);

export default router;
