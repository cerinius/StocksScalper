import { prisma } from "@stock-radar/db";

export const listAuditLogs = async (filters: { category?: string; symbol?: string; limit: number }) =>
  prisma.auditLog.findMany({
    where: {
      category: filters.category,
      symbol: filters.symbol
        ? {
            ticker: filters.symbol,
          }
        : undefined,
    },
    include: {
      symbol: true,
    },
    orderBy: { createdAt: "desc" },
    take: filters.limit,
  });
