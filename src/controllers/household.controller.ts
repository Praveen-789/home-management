import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import {
  createHousehold, listHouseholds, removeHouseholdPicture, requestPictureUpload, setHouseholdPicture,
} from "../services/household.service.js";
import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readId } from "../lib/controller.js";

export const create = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.userId) {
    return res.status(401).json({ message: "Authentication is required" });
  }

  const name: unknown = req.body?.name;

  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ message: "Household name is required" });
  }

  try {
    const household = await createHousehold(name.trim(), req.userId);

    return res.status(201).json({
      message: "Household created successfully",
      household,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ message: error.message });
    }

    console.error(error);
    return res.status(500).json({ message: "Failed to create household" });
  }
};

export const list = async (req: AuthenticatedRequest, res: Response) => {
  if (!req.userId) {
    return res.status(401).json({ message: "Authentication is required" });
  }

  try {
    const households = await listHouseholds(req.userId);
    return res.status(200).json({
      message: "Households fetched successfully",
      households,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Failed to fetch households" });
  }
};

const handlePicture = handleHouseholdRequest("Failed to update the household picture");

export const authorizePictureUpload = handlePicture(async (_req, res, householdId, requesterId) => {
  const upload = await requestPictureUpload(householdId, requesterId);
  return res.status(201).json({ message: "Upload authorized", upload });
});

export const updatePicture = handlePicture(async (req, res, householdId, requesterId) => {
  const household = await setHouseholdPicture(householdId, requesterId, readId(req.body?.publicId, "Image public ID"));
  return res.status(200).json({ message: "Household picture updated successfully", household });
});

export const deletePicture = handlePicture(async (_req, res, householdId, requesterId) => {
  const household = await removeHouseholdPicture(householdId, requesterId);
  return res.status(200).json({ message: "Household picture removed successfully", household });
});
