import { ALLOWED_FORMATS } from "../lib/cloudinary.js";
import { AppError } from "../lib/errors.js";
import { handleHouseholdRequest, readEnum, readId } from "../lib/controller.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { requestUpload, type ImageInput } from "../services/image.service.js";

// Cloudinary already capped the stored image at 2000 pixels a side; these bounds only reject
// nonsense the app could not have received from it.
const MAX_DIMENSION = 20_000;
const MAX_BYTES = 20 * 1024 * 1024;

const readPositiveInteger = (value: unknown, label: string, max: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new AppError(`${label} must be an integer between 1 and ${max}`, 400);
  }
  return value;
};

// What the app sends after Cloudinary accepted its upload: the signed public ID and Cloudinary's
// description of the stored file. Formats arrive in either case.
export const readImageInput = (body: unknown): ImageInput => {
  const source = (body ?? {}) as Record<string, unknown>;
  const format = typeof source["format"] === "string" ? source["format"].toLowerCase() : source["format"];
  return {
    publicId: readId(source["publicId"], "Image public ID"),
    width: readPositiveInteger(source["width"], "Width", MAX_DIMENSION),
    height: readPositiveInteger(source["height"], "Height", MAX_DIMENSION),
    bytes: readPositiveInteger(source["bytes"], "Size in bytes", MAX_BYTES),
    format: readEnum(format, ALLOWED_FORMATS, "Format"),
  };
};

export const readImageId = (req: AuthenticatedRequest) => readId(req.params["imageId"], "Image ID");

const handle = handleHouseholdRequest("Upload request failed");

export const authorizeUpload = handle(async (req, res, householdId, requesterId) => {
  const upload = await requestUpload(householdId, requesterId);
  return res.status(201).json({ message: "Upload authorized", upload });
});
