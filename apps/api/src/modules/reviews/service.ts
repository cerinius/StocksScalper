import { prisma } from "@stock-radar/db";

export interface ReviewsQuery {
  accountId?: string;
  kind?: string;
  verdict?: string;
  positionId?: string;
  limit: number;
  offset: number;
}

export const getReviews = async (query: ReviewsQuery) => {
  const where: Record<string, unknown> = {};
  if (query.accountId) where.accountId = query.accountId;
  if (query.kind) where.kind = query.kind;
  if (query.verdict) where.verdict = query.verdict;
  if (query.positionId) where.positionId = query.positionId;

  const [rows, total] = await Promise.all([
    (prisma as any).aiReview.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: query.offset,
      take: query.limit,
      include: {
        account: { select: { id: true, label: true } },
        position: { include: { symbol: { select: { ticker: true } } } },
      },
    }),
    (prisma as any).aiReview.count({ where }),
  ]);

  return { rows, total, offset: query.offset, limit: query.limit };
};

export const getReviewById = async (id: string) => {
  return (prisma as any).aiReview.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, label: true } },
      position: { include: { symbol: { select: { ticker: true } } } },
      decision: { select: { id: true, action: true, status: true } },
    },
  });
};

export const getWeeklyReviews = async (accountId?: string, limit = 12) => {
  const where: Record<string, unknown> = {};
  if (accountId) where.accountId = accountId;

  return (prisma as any).weeklyReview.findMany({
    where,
    orderBy: { weekStart: "desc" },
    take: limit,
    include: {
      account: { select: { id: true, label: true } },
    },
  });
};

export const getSupervisionTicks = async (positionId: string, limit = 50) => {
  return (prisma as any).positionSupervisionTick.findMany({
    where: { positionId },
    orderBy: { asOf: "desc" },
    take: limit,
  });
};
