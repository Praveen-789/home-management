import { Router } from "express";
import { forgotPassword, login, register, resetPassword } from "../controllers/auth.controller.js";

import { googleSignIn, googleLink } from "../controllers/google-auth.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = Router();
router.post("/google", googleSignIn);
router.post("/google/link", authenticate, googleLink);

router.post("/register", register);
router.post("/login", login);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;