import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __stockRadarPrisma__: PrismaClient | undefined;
}

export const prisma =
  global.__stockRadarPrisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__stockRadarPrisma__ = prisma;
}

export const disconnectPrisma = async () => {
  await prisma.$disconnect();
};

export * from "./workers";
