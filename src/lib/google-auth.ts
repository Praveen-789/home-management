import { OAuth2Client } from "google-auth-library";
import { AppError } from "./errors.js";

// This library verifies Google's signature and the issuer, expiry, and audience.
export const googleClient = new OAuth2Client();

export async function verifyGoogleToken(idToken: unknown) {
  if (typeof idToken !== "string" || !idToken.trim() || idToken.length > 10000) {
    throw new AppError("A valid Google ID token is required", 400);
  }

  // Only accept tokens issued for our own app. Never take client IDs from a request.
  const audiences = (process.env["GOOGLE_CLIENT_IDS"] ?? "")
    .split(",").map(value => value.trim()).filter(Boolean);
  if (audiences?.length === 0) {
    throw new AppError("Google sign-in is not configured", 503);
  }

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken, audience: audiences });
  } catch {
    // Do not log the token or return Google's internal error details.
    throw new AppError("Invalid or expired Google ID token", 401);
  }

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new AppError("Google account must have a verified email address", 401);
  }

  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: payload.name?.trim() || "HomeHub user",
  };
}
