import "dotenv/config";
import jwt, { type SignOptions } from "jsonwebtoken";

const JWT_SECRET = process.env["JWT_SECRET"];

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not set in the environment");
}

const EXPIRES_IN: SignOptions["expiresIn"] = "7d";

export type AuthTokenPayload = {
  userId: string;
  email: string;
};

export const signToken = (payload: AuthTokenPayload): string =>
  jwt.sign(payload, JWT_SECRET, { expiresIn: EXPIRES_IN });

export const verifyToken = (token: string): AuthTokenPayload => {
  const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });

  if (
    typeof payload === "string" ||
    typeof payload["userId"] !== "string" ||
    !payload["userId"].trim() ||
    typeof payload["email"] !== "string"
  ) {
    throw new Error("Invalid token payload");
  }

  return { userId: payload["userId"], email: payload["email"] };
};
