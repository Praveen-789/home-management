import { Request, Response } from "express";
import { registerUser, loginUser } from "../services/auth.service.js";
import { AppError } from "../lib/errors.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  requestPasswordReset,
  resetPassword as resetPasswordWithCode,
} from "../services/password-reset.service.js";

export const register = async (req: Request, res: Response) => {
  try {
    const { name, email, password } = req.body;

    const user = await registerUser(name, email, readNewPassword(password));

    return res.status(201).json({
      message: "User registered successfully",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error(error);

    return res.status(400).json({
      message: error instanceof Error ? error.message : "Registration failed",
    });
  }
};

const isEmail = (value: unknown): value is string =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const readNewPassword = (value: unknown): string => {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH) {
    throw new AppError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    throw new AppError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400);
  }
  return value;
};

const respondWithError = (res: Response, error: unknown, fallback: string) => {
  if (error instanceof AppError) {
    return res.status(error.statusCode).json({ message: error.message });
  }
  console.error(error);
  return res.status(500).json({ message: fallback });
};

// Answers the same way whether or not the address is registered, so the endpoint cannot be used
// to find out who has an account.
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const email: unknown = req.body?.email;
    if (!isEmail(email)) {
      return res.status(400).json({ message: "A valid email address is required" });
    }
    await requestPasswordReset(email);
    return res.status(200).json({ message: "If that email is registered, a reset code is on its way" });
  } catch (error) {
    return respondWithError(res, error, "Could not start the password reset");
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { email, code, password } = (req.body ?? {}) as Record<string, unknown>;
    if (!isEmail(email)) {
      return res.status(400).json({ message: "A valid email address is required" });
    }
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: "Enter the 6-digit code from the email" });
    }
    await resetPasswordWithCode(email, code, readNewPassword(password));
    return res.status(200).json({ message: "Password updated. You can sign in with your new password." });
  } catch (error) {
    return respondWithError(res, error, "Could not reset the password");
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({
        message: "Email and password are required",
      });
    }

    const { user, token } = await loginUser(email, password);

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        message: error.message,
      });
    }

    console.error(error);

    return res.status(500).json({
      message: "Login failed",
    });
  }
};
