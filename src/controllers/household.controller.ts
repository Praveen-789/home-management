import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { createHousehold, listHouseholds } from "../services/household.service.js";
import { AppError } from "../lib/errors.js";

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
