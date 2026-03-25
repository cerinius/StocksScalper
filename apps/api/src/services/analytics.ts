import { prisma } from "@stock-radar/db";

export const getBacktestReport = async (limit = 250) => {
  const candidates = await prisma.tradeCandidate.findMany({
    include: { symbol: true },
    orderBy: { detectedAt: "desc" },
    take: limit,
  });

  const candidateSummary = candidates.map((c) => ({
    id: c.id,
    symbol: c.symbol.ticker,
    timeframe: c.timeframe,
    direction: c.direction,
    confidenceScore: c.confidenceScore,
    setupScore: c.setupScore,
    status: c.status,
    createdAt: c.detectedAt.toISOString(),
  }));

  return {
    generatedAt: new Date().toISOString(),
    totalCandidates: candidates.length,
    topCandidates: candidateSummary.slice(0, 8),
    recentCandidates: candidateSummary.slice(0, 40),
  };
};

export const getDashboardOverview = async () => {
  const [accountSnapshot, activeTrades, recentDecisions, openPositions] = await Promise.all([
    prisma.accountSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
    prisma.position.count({ where: { status: "OPEN" } }),
    prisma.executionDecision.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.position.findMany({ where: { status: "OPEN" }, include: { symbol: true } }),
  ]);

  const recentTrades = (await prisma.order.findMany({ orderBy: { submittedAt: "desc" }, take: 8, include: { symbol: true } })) || [];

  return {
    generatedAt: new Date().toISOString(),
    account: accountSnapshot,
    activeTrades,
    openPositions: openPositions.map((position) => ({
      symbol: position.symbol.ticker,
      direction: position.direction,
      quantity: position.quantity,
      exposurePct: position.exposurePct,
      unrealizedPnl: position.unrealizedPnl,
    })),
    recentDecisions: recentDecisions.map((d) => ({
      id: d.id,
      action: d.action,
      status: d.status,
      confidence: d.confidence,
      createdAt: d.createdAt,
    })),
    recentTrades: recentTrades.map((trade) => ({
      id: trade.id,
      symbol: trade.symbol.ticker,
      direction: trade.direction,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      status: trade.status,
      submittedAt: trade.submittedAt,
    })),
  };
};
