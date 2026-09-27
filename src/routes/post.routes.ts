import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
  addComment,
  authorizeUpload,
  create,
  get,
  like,
  list,
  listComments,
  remove,
  removeComment,
  unlike,
} from "../controllers/post.controller.js";

// mergeParams lets these handlers read :householdId from the parent router.
const router = Router({ mergeParams: true });

router.get("/", authenticate, list);
router.post("/", authenticate, create);
// Signs one photo upload into the household's posts folder; the photo is sent with the new post.
router.post("/uploads", authenticate, authorizeUpload);
router.get("/:postId", authenticate, get);
router.delete("/:postId", authenticate, remove);
// PUT and DELETE rather than a toggle, so repeating either request gives the same result.
router.put("/:postId/like", authenticate, like);
router.delete("/:postId/like", authenticate, unlike);
router.get("/:postId/comments", authenticate, listComments);
router.post("/:postId/comments", authenticate, addComment);
router.delete("/:postId/comments/:commentId", authenticate, removeComment);

export default router;
