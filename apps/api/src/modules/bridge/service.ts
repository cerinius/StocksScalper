import { prisma } from "@stock-radar/db";

export interface BridgeOverviewQuery {
  limit: number;
}

export const getBridgeOverview = async (query: BridgeOverviewQuery) => {
  const recentSnapshots = await prisma.bridgeHealthSnapshot.findMany({
    include: {
      account: {
        select: {
          id: true,
          displayName: true,
          mode: true,
          health: true,
          tradingMode: true,
          providerName: true,
        },
      },
      integration: {
        select: {
          id: true,
          name: true,
          kind: true,
          enabled: true,
          mode: true,
        },
      },
    },
    orderBy: { capturedAt: "desc" },
    take: query.limit,
  });

  const latestByAccountMap = new Map<string, (typeof recentSnapshots)[number]>();
  for (const row of recentSnapshots) {
    if (!latestByAccountMap.has(row.accountId)) {
      latestByAccountMap.set(row.accountId, row);
    }
  }
  const latestByAccount = Array.from(latestByAccountMap.values());

  const summary = {
    accounts: latestByAccount.length,
    connected: latestByAccount.filter((row) => row.status === "CONNECTED").length,
    degraded: latestByAccount.filter((row) => row.status === "DEGRADED").length,
    stale: latestByAccount.filter((row) => row.status === "STALE").length,
    disconnected: latestByAccount.filter((row) => row.status === "DISCONNECTED").length,
    error: latestByAccount.filter((row) => row.status === "ERROR").length,
    blockNewOrders: latestByAccount.filter((row) => row.status === "STALE" || row.status === "DISCONNECTED" || row.status === "ERROR" || !row.terminalConnected || !row.brokerConnected).length,
  };

  return {
    summary,
    latestByAccount,
    recentSnapshots,
  };
};
