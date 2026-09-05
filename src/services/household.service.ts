import { Prisma } from "../../generated/prisma/client.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";

export const createHousehold = async (name: string, userId: string) => {
  try {
    // Nested writes are atomic: a failed membership also rolls back the household.
    return await prisma.household.create({
      data: {
        name,
        members: {
          create: {
            user: { connect: { id: userId } },
            role: "OWNER",
          },
        },
      },
      include: { members: true },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new AppError("Authenticated user no longer exists", 401);
    }

    throw error;
  }
};
