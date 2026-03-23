import { prisma } from "@stock-radar/db";

export const getDashboardSummary = async () => {
  const [account, activeTrades, recentActions, riskWarnings, heartbeats] = await Promise.all([
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
  ]);

  return {
    account,
    activeTrades,
    recentActions: recentActions.map((item) => ({
      message: item.message,
      createdAt: item.createdAt,
      severity: item.severity,
      category: item.category,
    })),
    riskWarnings: riskWarnings.map((item) => ({
      id: item.id,
      eventType: item.eventType,
      message: item.message,
      severity: item.severity,
      createdAt: item.createdAt,
      blocking: item.blocking,
    })),
    workerHealth: heartbeats,
    killSwitchActive: account?.killSwitchActive ?? false,
  };
};
