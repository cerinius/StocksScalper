import { prisma } from "@stock-radar/db";

export const listValidationRuns = async (limit: number) =>
  prisma.validationRun.findMany({
    include: {
      candidate: {
        include: {
          symbol: true,
        },
      },
      backtestResults: {
        orderBy: { similarityScore: "desc" },
        take: 5,
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
