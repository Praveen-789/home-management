import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { authorizePictureUpload, create, deletePicture, list as listHouseholds, updatePicture } from "../controllers/household.controller.js";
import { list, remove, updateRole } from "../controllers/household-member.controller.js";
import { cancel as cancelInvitation, invite, listForHousehold as listInvitations } from "../controllers/household-invitation.controller.js";
import taskRoutes from "./task.routes.js";
import expenseRoutes from "./expense.routes.js";
import postRoutes from "./post.routes.js";
import { authorizeUpload } from "../controllers/image.controller.js";

const router = Router();

router.post("/", authenticate, create);
router.get("/", authenticate, listHouseholds);
router.get("/:householdId/members", authenticate, list);
router.patch("/:householdId/members/:userId", authenticate, updateRole);
router.delete("/:householdId/members/:userId", authenticate, remove);
// People join by invitation only: a membership is created when the invited user accepts.
router.get("/:householdId/invitations", authenticate, listInvitations);
router.post("/:householdId/invitations", authenticate, invite);
router.delete("/:householdId/invitations/:invitationId", authenticate, cancelInvitation);
// Signs one direct-to-Cloudinary upload for a member; the file is attached to a task or expense afterwards.
router.post("/:householdId/uploads", authenticate, authorizeUpload);
// The household's own picture, for owners and admins: sign an upload, then point the household at it.
router.post("/:householdId/picture/uploads", authenticate, authorizePictureUpload);
router.put("/:householdId/picture", authenticate, updatePicture);
router.delete("/:householdId/picture", authenticate, deletePicture);
router.use("/:householdId/tasks", taskRoutes);
router.use("/:householdId/expenses", expenseRoutes);
router.use("/:householdId/posts", postRoutes);

export default router;

