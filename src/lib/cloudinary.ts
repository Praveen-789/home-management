import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { AppError } from "./errors.js";

// The SDK reads CLOUDINARY_URL (cloudinary://key:secret@cloud) from the environment, but only on
// its first config() call. Passing true forces a re-read here, after dotenv above has run, so it
// does not matter whether something required the SDK earlier. Only the server holds the secret;
// the app receives a signature that authorizes one upload.
cloudinary.config(true);
cloudinary.config({ secure: true });

// Every image lives under this prefix, one folder per household, so a public ID alone proves
// which household an upload was signed for.
const IMAGE_ROOT = "homehub/households";

export const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp", "heic", "heif"] as const;
export type ImageFormat = (typeof ALLOWED_FORMATS)[number];

// Applied by Cloudinary before storing, so nothing wider or taller than this is kept.
const INCOMING_TRANSFORMATION = "c_limit,w_2000,h_2000";

// Cloudinary refuses signatures whose timestamp is more than an hour old.
export const SIGNATURE_TTL_SECONDS = 60 * 60;

export const imageFolder = (householdId: string) => `${IMAGE_ROOT}/${householdId}`;

// Whether a public ID is one this server would have signed for the household.
export function isHouseholdImage(householdId: string, publicId: string): boolean {
  const prefix = `${imageFolder(householdId)}/`;
  return publicId.startsWith(prefix) && /^[0-9a-f-]{36}$/.test(publicId.slice(prefix.length));
}

type Credentials = { cloudName: string; apiKey: string; apiSecret: string };

function credentials(): Credentials {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  if (!cloud_name || !api_key || !api_secret) {
    throw new AppError("Image uploads are not configured on this server", 503);
  }
  return { cloudName: String(cloud_name), apiKey: String(api_key), apiSecret: String(api_secret) };
}

// Cloudinary's upload signature: the signed parameters sorted by name, joined as key=value pairs
// with &, followed by the API secret, hashed with SHA-256.
export function signUploadParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
  return createHash("sha256").update(toSign + apiSecret).digest("hex");
}

// Everything the app needs to upload one file straight to Cloudinary. `fields` go into the
// multipart form exactly as given, alongside the file.
export type UploadTicket = {
  uploadUrl: string;
  fields: Record<string, string>;
  publicId: string;
  allowedFormats: readonly string[];
  expiresAt: string;
};

export function createUploadTicket(householdId: string, now = new Date()): UploadTicket {
  const { cloudName, apiKey, apiSecret } = credentials();
  const timestamp = Math.floor(now.getTime() / 1000);
  const publicId = `${imageFolder(householdId)}/${randomUUID()}`;
  // asset_folder files the upload under the household in the Media Library. Accounts in dynamic
  // folder mode keep that separate from the public ID, which alone would leave it in the root.
  const params = {
    timestamp,
    public_id: publicId,
    asset_folder: imageFolder(householdId),
    allowed_formats: ALLOWED_FORMATS.join(","),
    transformation: INCOMING_TRANSFORMATION,
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    fields: {
      ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
      api_key: apiKey,
      signature: signUploadParams(params, apiSecret),
    },
    publicId,
    allowedFormats: ALLOWED_FORMATS,
    expiresAt: new Date((timestamp + SIGNATURE_TTL_SECONDS) * 1000).toISOString(),
  };
}

// Delivery URLs. f_auto and q_auto let Cloudinary pick the best format and quality per device.
export function imageUrls(publicId: string): { url: string; thumbnailUrl: string } {
  const base = `https://res.cloudinary.com/${credentials().cloudName}/image/upload`;
  return {
    url: `${base}/f_auto,q_auto/${publicId}`,
    thumbnailUrl: `${base}/c_fill,g_auto,w_400,h_400,f_auto,q_auto/${publicId}`,
  };
}

// Removal is best-effort and runs after the database rows are gone: a Cloudinary outage must not
// block a delete. Failures are logged so leftovers can be swept later.
export const imageStorage = {
  async destroy(publicIds: string[]): Promise<void> {
    await Promise.all(publicIds.map(async (publicId) => {
      try {
        await cloudinary.uploader.destroy(publicId, { invalidate: true });
      } catch (error) {
        console.error(`Could not delete Cloudinary image ${publicId}`, error);
      }
    }));
  },
};
