import { prisma } from "@stock-radar/db";

export const getDashboardSummary = async () => {
  const [account, activeTrades, recentActions, riskWarnings, heartbeats, dynamicRiskSetting] = await Promise.all([
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
  ]);
  const dynamicRiskValue =
    dynamicRiskSetting && typeof dynamicRiskSetting.value === "object" && dynamicRiskSetting.value && !Array.isArray(dynamicRiskSetting.value)
      ? (dynamicRiskSetting.value as { maxRiskPerTradePct?: number }).maxRiskPerTradePct
      : undefined;

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
    dynamicMaxRiskPerTradePct: typeof dynamicRiskValue === "number" ? dynamicRiskValue : null,
  };
};
