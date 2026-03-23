import { prisma } from "@stock-radar/db";

export const getExecutionOverview = async (limit: number) => {
  const [decisions, orders, riskEvents] = await Promise.all([
    prisma.executionDecision.findMany({
      include: {
        candidate: {
          include: { symbol: true },
        },
        validationRun: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.order.findMany({
      include: { symbol: true, decision: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.riskEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  return { decisions, orders, riskEvents };
};
