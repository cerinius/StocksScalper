import { prisma } from "@stock-radar/db";

export const listAccountsOverview = async () => {
  const accounts = await prisma.account.findMany({
    where: { isActive: true },
    include: {
      currentPhase: true,
      snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
      _count: { select: { positions: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return accounts.map((account: any) => {
    const latest = account.snapshots[0] ?? null;
    return {
      id: account.id,
      displayName: account.displayName,
      kind: account.kind,
      providerName: account.providerName,
      tradingMode: account.tradingMode,
      mode: account.mode,
      health: account.health,
      phaseKind: account.currentPhase?.kind ?? null,
      isActive: account.isActive,
      tags: account.tags,
      latestSnapshot: latest
        ? {
            capturedAt: latest.capturedAt,
            balance: latest.balance,
            equity: latest.equity,
            openPnl: latest.openPnl,
            drawdownPct: latest.drawdownPct,
            dailyLossUsedPct: latest.dailyLossUsedPct,
            totalLossUsedPct: latest.totalLossUsedPct,
            openPositionCount: latest.openPositionCount,
            riskState: latest.riskState,
            killSwitchActive: latest.killSwitchActive,
          }
        : null,
      openPositions: account._count.positions,
    };
  });
};

export const getAccountDetail = async (accountId: string) => {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      currentPhase: true,
      activeRuleProfile: true,
      snapshots: { orderBy: { capturedAt: "desc" }, take: 24 },
      positions: {
        where: { status: "OPEN" },
        include: { symbol: true },
        orderBy: { openedAt: "desc" },
      },
      allocationCandidates: {
        include: {
          allocationDecision: {
            include: {
              candidate: { include: { symbol: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 30,
      },
    },
  });

  if (!account) return null;

  return {
    account,
    latestSnapshot: account.snapshots[0] ?? null,
    recentSnapshots: account.snapshots,
    openPositions: account.positions,
    allocationHistory: account.allocationCandidates.map((row: any) => ({
      id: row.id,
      createdAt: row.createdAt,
      selected: row.selected,
      totalScore: row.totalScore,
      componentsJson: row.componentsJson,
      reasonCodes: row.reasonCodes,
      message: row.message,
      allocationDecisionId: row.allocationDecisionId,
      allocationStatus: row.allocationDecision.status,
      policy: row.allocationDecision.policy,
      setupKey: row.allocationDecision.setupKey,
      candidate: {
        id: row.allocationDecision.candidate.id,
        symbol: row.allocationDecision.candidate.symbol.ticker,
        direction: row.allocationDecision.candidate.direction,
        timeframe: row.allocationDecision.candidate.timeframe,
        strategyType: row.allocationDecision.candidate.strategyType,
      },
    })),
  };
};
