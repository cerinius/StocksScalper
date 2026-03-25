import { prisma } from "@stock-radar/db";

// Urgency ordering: CRITICAL > HIGH > MEDIUM > LOW
// Postgres sorts enums as strings by default, so we use explicit ordering via Prisma's enum
// ordering trick: sort by originalTimestamp desc within a priority bucket.
// Best practice: use a numeric relevance score as the primary sort, then timestamp.
export const listNewsItems = async (filters: { symbol?: string; urgency?: string; limit: number; offset: number }) => {
  return prisma.newsItem.findMany({
    where: {
      urgency: filters.urgency ? (filters.urgency as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL") : undefined,
      symbolLinks: filters.symbol
        ? {
            some: {
              symbol: {
                ticker: filters.symbol,
              },
            },
          }
        : undefined,
    },
    include: {
      symbolLinks: {
        include: {
          symbol: true,
        },
      },
    },
    // Sort by relevance score desc (semantically correct), then timestamp desc for tie-breaking.
    // This avoids the string-alphabetical sort of the NewsUrgency enum.
    orderBy: [{ relevanceScore: "desc" }, { originalTimestamp: "desc" }],
    take: filters.limit,
    skip: filters.offset,
  });
};
