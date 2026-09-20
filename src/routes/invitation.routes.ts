import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { accept, decline, listMine } from "../controllers/household-invitation.controller.js";

// The signed-in user's own pending invitations. The household's side of the same
// invitations lives under /api/households/:householdId/invitations.
const router = Router();
router.use(authenticate);

router.get("/", listMine);
router.post("/:id/accept", accept);
router.post("/:id/decline", decline);

export default router;
