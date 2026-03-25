import { CandidateStatus } from "@prisma/client";
import { prisma } from "@stock-radar/db";

export const listTradeIdeas = async (filters: { symbol?: string; timeframe?: string; status?: string; limit: number }) =>
  prisma.tradeCandidate.findMany({
    where: {
      timeframe: filters.timeframe,
      // Safe cast: CandidateStatus is a Prisma enum, filter is validated upstream by the API layer
      status: filters.status ? (filters.status as CandidateStatus) : undefined,
      symbol: filters.symbol
        ? {
            ticker: filters.symbol,
          }
        : undefined,
    },
    include: {
      symbol: true,
      marketSnapshot: true,
      validationRuns: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: [{ setupScore: "desc" }, { detectedAt: "desc" }],
    take: filters.limit,
  });
