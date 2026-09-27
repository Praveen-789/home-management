import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { readId } from "../lib/controller.js";
import { AppError } from "../lib/errors.js";
import { getProfile, removeAvatar, requestAvatarUpload, setAvatar } from "../services/user.service.js";

type ProfileOperation = (req: AuthenticatedRequest, res: Response, userId: string) => Promise<unknown>;

// Every route here acts on the signed-in user, so the user ID only ever comes from the token.
const handle = (fallbackMessage: string, operation: ProfileOperation) =>
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.userId) throw new AppError("Authentication is required", 401);
      return await operation(req, res, req.userId);
    } catch (error) {
      if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message });
      console.error(error);
      return res.status(500).json({ message: fallbackMessage });
    }
  };

export const me = handle("Failed to fetch your profile", async (_req, res, userId) =>
  res.status(200).json({ message: "Profile fetched successfully", user: await getProfile(userId) }));

export const authorizeAvatarUpload = handle("Upload request failed", async (_req, res, userId) =>
  res.status(201).json({ message: "Upload authorized", upload: await requestAvatarUpload(userId) }));

export const updateAvatar = handle("Failed to update your picture", async (req, res, userId) => {
  const user = await setAvatar(userId, readId(req.body?.publicId, "Image public ID"));
  return res.status(200).json({ message: "Profile picture updated successfully", user });
});

export const deleteAvatar = handle("Failed to remove your picture", async (_req, res, userId) =>
  res.status(200).json({ message: "Profile picture removed successfully", user: await removeAvatar(userId) }));
