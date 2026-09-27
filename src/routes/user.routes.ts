import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { authorizeAvatarUpload, deleteAvatar, me, updateAvatar } from "../controllers/user.controller.js";

const router = Router();

// "me" is always the signed-in user, so no route here can name another person.
router.get("/me", authenticate, me);
// A profile picture takes two steps: sign an upload, then point the profile at the uploaded file.
router.post("/me/avatar/uploads", authenticate, authorizeAvatarUpload);
router.put("/me/avatar", authenticate, updateAvatar);
router.delete("/me/avatar", authenticate, deleteAvatar);

export default router;
