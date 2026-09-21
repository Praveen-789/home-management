import { Prisma } from "../../generated/prisma/client.js";
import prisma from "./prisma.js";
import { AppError } from "./errors.js";

// Re-run the lookup after competing get-or-create / idempotent-send requests.
export async function chatTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2034" || error.code === "P2002") continue;
        if (error.code === "P2003" || error.code === "P2025") throw new AppError("Chat resource no longer exists", 404);
      }
      throw error;
    }
  }
  throw new AppError("Chat changed concurrently; please retry", 409);
}
