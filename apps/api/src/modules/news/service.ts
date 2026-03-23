import { prisma } from "@stock-radar/db";

export const listNewsItems = async (filters: { symbol?: string; urgency?: string; limit: number; offset: number }) => {
  return prisma.newsItem.findMany({
    where: {
      urgency: filters.urgency as never | undefined,
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
    orderBy: [{ urgency: "desc" }, { originalTimestamp: "desc" }],
    take: filters.limit,
    skip: filters.offset,
  });
};
