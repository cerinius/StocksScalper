import { prisma } from "@stock-radar/db";

export const getPortfolioOverview = async () => {
  const [account, openPositions, closedPositions, recentOrders] = await Promise.all([
    prisma.accountSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
    prisma.position.findMany({
      where: { status: "OPEN" },
      include: { symbol: true, order: true },
      orderBy: { openedAt: "desc" },
    }),
    prisma.position.findMany({
      where: { status: "CLOSED" },
      include: { symbol: true },
      orderBy: { closedAt: "desc" },
      take: 20,
    }),
    prisma.order.findMany({
      include: { symbol: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const exposureBySymbol = openPositions.map((position) => ({
    symbol: position.symbol.ticker,
    exposurePct: position.exposurePct,
    direction: position.direction,
    unrealizedPnl: position.unrealizedPnl,
  }));

  return {
    account,
    openPositions,
    closedPositions,
    recentOrders,
    exposureBySymbol,
  };
};
