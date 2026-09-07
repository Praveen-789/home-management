import { Prisma } from "../../generated/prisma/client.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/errors.js";

export const createHousehold = async (name: string, userId: string) => {
  try {
    // Nested writes are atomic: a failed membership also rolls back the household.
    return await prisma.household.create({
      data: {
        name: name.trim(),
        createdBy: { connect: { id: userId } },
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
      error.code === "P2002"
    ) {
      throw new AppError("You already have a household with this name", 409);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      throw new AppError("Authenticated user no longer exists", 401);
    }

    throw error;
  }
};

export async function listHouseholds(userId: string) {
  const memberships = await prisma.householdMember.findMany({
    where: { userId },
    select: {
      role: true,
      household: {
        select: { id: true, name: true, createdAt: true },
      },
    },
    orderBy: [{ household: { createdAt: "desc" } }, { householdId: "asc" }],
  });

  return memberships.map((membership) => ({
    id: membership.household.id,
    name: membership.household.name,
    createdAt: membership.household.createdAt,
    role: membership.role,
  }));
}
