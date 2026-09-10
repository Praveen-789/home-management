import { Prisma } from "../../generated/prisma/client.js";
import prisma from "./prisma.js";
import { AppError } from "./errors.js";

// Messages a module supplies for the database failures this wrapper translates.
export type TransactionMessages = {
  // P2002: a unique constraint was violated, usually by a concurrent write.
  conflict: string;
  // P2025 / P2003: a row the operation relied on disappeared before the write.
  missing: string;
  // Serialization conflicts kept recurring and the retry budget ran out.
  retriesExhausted: string;
};

const MAX_ATTEMPTS = 3;

// Runs an operation in a serializable transaction so its permission checks and
// writes observe one consistent snapshot. Result preserves each operation's return type.
export async function withSerializableTransaction<Result>(
  operation: (tx: Prisma.TransactionClient) => Promise<Result>,
  messages: TransactionMessages,
): Promise<Result> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
        throw error;
      }

      // A conflict retries the whole operation, including permission checks.
      if (error.code === "P2034") {
        continue;
      }

      if (error.code === "P2002") {
        throw new AppError(messages.conflict, 409);
      }

      if (error.code === "P2025" || error.code === "P2003") {
        throw new AppError(messages.missing, 404);
      }

      throw error;
    }
  }

  throw new AppError(messages.retriesExhausted, 409);
}
