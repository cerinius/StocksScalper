import { prisma } from "@stock-radar/db";

export const getDashboardSummary = async () => {
  const [
    account,
    activeTrades,
    recentActions,
    riskWarnings,
    heartbeats,
    dynamicRiskSetting,
    activeWatchlist,
    bridgeSnapshots,
  ] = await Promise.all([
    prisma.accountSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
    prisma.position.count({ where: { status: "OPEN" } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.riskEvent.findMany({
      where: {
        OR: [{ severity: "WARNING" }, { severity: "CRITICAL" }, { blocking: true }],
      },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.workerHeartbeat.findMany({ orderBy: { workerType: "asc" } }),
    prisma.systemSetting.findUnique({ where: { key: "risk.dynamicControls" } }),
    prisma.watchlist.findFirst({
      where: { isActive: true },
      include: {
        items: {
          include: {
            symbol: true,
          },
        },
      },
    }),
    prisma.bridgeHealthSnapshot.findMany({
      include: {
        account: {
          select: {
            id: true,
            displayName: true,
          },
        },
      },
      orderBy: { capturedAt: "desc" },
      take: 200,
    }),
  ]);
  const dynamicRiskValue =
    dynamicRiskSetting &&
    typeof dynamicRiskSetting.value === "object" &&
    dynamicRiskSetting.value &&
    !Array.isArray(dynamicRiskSetting.value)
      ? (dynamicRiskSetting.value as { maxRiskPerTradePct?: number }).maxRiskPerTradePct
      : undefined;

  const watchedSymbols = activeWatchlist?.items.map((item: any) => item.symbol.id) ?? [];

  const [news, marketSnapshots] = await Promise.all([
    prisma.newsItem.findMany({
      where: {
        symbolLinks: {
          some: {
            symbolId: {
              in: watchedSymbols,
            },
          },
        },
      },
      orderBy: {
        originalTimestamp: "desc",
      },
      take: 10,
    }),
    prisma.marketSnapshot.findMany({
      where: {
        symbolId: {
          in: watchedSymbols,
        },
      },
      orderBy: {
        snapshotAt: "desc",
      },
      take: 10,
      include: {
        symbol: true,
      },
    }),
  ]);

  const latestBridgeByAccountMap = new Map<string, (typeof bridgeSnapshots)[number]>();
  for (const row of bridgeSnapshots) {
    if (!latestBridgeByAccountMap.has(row.accountId)) {
      latestBridgeByAccountMap.set(row.accountId, row);
    }
  }
  const latestBridgeByAccount = Array.from(latestBridgeByAccountMap.values());
  const bridgeSummary = {
    accounts: latestBridgeByAccount.length,
    connected: latestBridgeByAccount.filter((row) => row.status === "CONNECTED").length,
    degraded: latestBridgeByAccount.filter((row) => row.status === "DEGRADED").length,
    stale: latestBridgeByAccount.filter((row) => row.status === "STALE").length,
    disconnected: latestBridgeByAccount.filter((row) => row.status === "DISCONNECTED").length,
    error: latestBridgeByAccount.filter((row) => row.status === "ERROR").length,
    blockNewOrders: latestBridgeByAccount.filter((row) =>
      row.status === "STALE" ||
      row.status === "DISCONNECTED" ||
      row.status === "ERROR" ||
      !row.terminalConnected ||
      !row.brokerConnected,
    ).length,
    blockedAccounts: latestBridgeByAccount
      .filter((row) =>
        row.status === "STALE" ||
        row.status === "DISCONNECTED" ||
        row.status === "ERROR" ||
        !row.terminalConnected ||
        !row.brokerConnected,
      )
      .map((row) => row.account.displayName),
    latestCapturedAt: latestBridgeByAccount[0]?.capturedAt ?? null,
  };

  return {
    account,
    activeTrades,
    recentActions: recentActions.map((item: any) => ({
      message: item.message,
      createdAt: item.createdAt,
      severity: item.severity,
      category: item.category,
    })),
    riskWarnings: riskWarnings.map((item: any) => ({
      id: item.id,
      eventType: item.eventType,
      message: item.message,
      severity: item.severity,
      createdAt: item.createdAt,
      blocking: item.blocking,
    })),
    workerHealth: heartbeats,
    killSwitchActive: account?.killSwitchActive ?? false,
    dynamicMaxRiskPerTradePct: typeof dynamicRiskValue === "number" ? dynamicRiskValue : null,
    bridgeSummary,
    activeWatchlist,
    news,
    marketSnapshots,
  };
};

