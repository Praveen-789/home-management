import type { Request, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { AppError } from "../lib/errors.js";
import { signInWithGoogle, linkGoogleAccount } from "../services/google-auth.service.js";

function sendError(res: Response, error: unknown) {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  // Authentication errors may contain sensitive details; do not log request tokens.
  return res.status(500).json({ message: "Google authentication failed" });
}

export async function googleSignIn(req: Request, res: Response) {
  try {
    const result = await signInWithGoogle(req.body?.idToken);
    return res.status(result.isNewUser ? 201 : 200).json({
      message: result.isNewUser ? "Account created successfully" : "Login successful",
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function googleLink(req: AuthenticatedRequest, res: Response) {
  try {
    if (!req.userId) throw new AppError("Authentication is required", 401);
    const user = await linkGoogleAccount(req.userId, req.body?.idToken, req.body?.password);
    return res.status(200).json({ message: "Google account linked successfully", user });
  } catch (error) {
    return sendError(res, error);
  }
}
