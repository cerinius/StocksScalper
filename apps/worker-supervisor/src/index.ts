import { getPlatformConfig } from "@stock-radar/config";
import { summarizeAccountRisk, summarizeWorkerHealth } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformWorker, ensureDefaultSchedules, queueNames } from "@stock-radar/queues";

const config = getPlatformConfig();
const logger = createLogger("worker-supervisor");
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;
const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const readDynamicControls = async () => {
  const setting = await prisma.systemSetting.findUnique({ where: { key: "risk.dynamicControls" } });
  const value = asObject(setting?.value);
  const maxRiskPerTradePct =
    typeof value?.maxRiskPerTradePct === "number" && Number.isFinite(value.maxRiskPerTradePct)
      ? value.maxRiskPerTradePct
      : config.risk.maxRiskPerTradePct;
  const lastAdjustedAt = typeof value?.lastAdjustedAt === "string" ? value.lastAdjustedAt : null;

  return {
    maxRiskPerTradePct,
    lastAdjustedAt,
    reason: typeof value?.reason === "string" ? value.reason : null,
  };
};

const maybeThrottleRisk = async (
  account: {
    balance: number;
    realizedPnlDaily: number;
    drawdownPct: number;
  } | null,
) => {
  const controls = await readDynamicControls();
  if (!account) return null;

  const recentPlacedDecisions = await prisma.executionDecision.findMany({
    where: {
      action: "PLACE",
      validationRunId: {
        not: null,
      },
    },
    include: {
      validationRun: true,
    },
    orderBy: { createdAt: "desc" },
    take: 12,
  });

  const expectancies = recentPlacedDecisions
    .map((decision) => decision.validationRun?.expectancy ?? null)
    .filter((value): value is number => typeof value === "number");
  const averageExpectancy =
    expectancies.length === 0 ? 0 : expectancies.reduce((total, value) => total + value, 0) / expectancies.length;
  const realizedLossPct =
    account.balance <= 0 ? 0 : Math.max(0, (-Math.min(account.realizedPnlDaily, 0) / account.balance) * 100);
  const drawdownPressure = account.drawdownPct >= Math.max(1, config.risk.maxDailyLossPct * 0.5);
  const expectancyMismatch = averageExpectancy >= 0.15 && realizedLossPct >= config.risk.maxRiskPerTradePct * 0.75;

  if (!drawdownPressure && !expectancyMismatch) {
    return null;
  }

  if (controls.lastAdjustedAt) {
    const lastAdjustedMs = new Date(controls.lastAdjustedAt).getTime();
    if (Date.now() - lastAdjustedMs < config.risk.riskThrottleCooldownMinutes * 60_000) {
      return null;
    }
  }

  if (controls.maxRiskPerTradePct <= config.risk.minDynamicRiskPerTradePct) {
    return null;
  }

  const nextRiskPerTradePct = Math.max(
    config.risk.minDynamicRiskPerTradePct,
    Number((controls.maxRiskPerTradePct - config.risk.riskThrottleStepPct).toFixed(2)),
  );
  if (nextRiskPerTradePct >= controls.maxRiskPerTradePct) {
    return null;
  }

  const reason = drawdownPressure
    ? `Drawdown reached ${account.drawdownPct.toFixed(2)}%, so dynamic risk was reduced.`
    : `Expected edge stayed positive (${averageExpectancy.toFixed(2)}R) while realized daily PnL lagged, so risk was reduced.`;

  await prisma.systemSetting.upsert({
    where: { key: "risk.dynamicControls" },
    update: {
      value: {
        maxRiskPerTradePct: nextRiskPerTradePct,
        lastAdjustedAt: new Date().toISOString(),
        reason,
      },
      valueType: "json",
      description: "Supervisor-managed dynamic execution throttle",
    },
    create: {
      key: "risk.dynamicControls",
      value: {
        maxRiskPerTradePct: nextRiskPerTradePct,
        lastAdjustedAt: new Date().toISOString(),
        reason,
      },
      valueType: "json",
      description: "Supervisor-managed dynamic execution throttle",
    },
  });

  await prisma.riskEvent.create({
    data: {
      severity: "WARNING",
      eventType: "dynamic_risk_throttle",
      message: `Risk per trade was reduced from ${controls.maxRiskPerTradePct.toFixed(2)}% to ${nextRiskPerTradePct.toFixed(2)}%.`,
      details: {
        averageExpectancy,
        realizedLossPct,
        drawdownPct: account.drawdownPct,
        previousRiskPerTradePct: controls.maxRiskPerTradePct,
        nextRiskPerTradePct,
      },
      blocking: false,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorType: "WORKER",
      actorId: "worker-supervisor",
      workerType: "SUPERVISOR",
      severity: "WARNING",
      category: "supervisor.dynamic_risk",
      message: `Supervisor lowered max risk per trade to ${nextRiskPerTradePct.toFixed(2)}%.`,
      entityType: "system_setting",
      entityId: "risk.dynamicControls",
      data: {
        averageExpectancy,
        realizedLossPct,
        previousRiskPerTradePct: controls.maxRiskPerTradePct,
        nextRiskPerTradePct,
      },
    },
  });

  return {
    summary: `Dynamic risk throttle lowered max risk per trade to ${nextRiskPerTradePct.toFixed(2)}%.`,
    nextRiskPerTradePct,
  };
};

const processSupervisorJob = async (trigger: "health_check" | "daily_summary" | "manual") => {
  const run = await createWorkerRun({
    workerType: "SUPERVISOR",
    queueName: queueNames.supervisor,
    jobName: trigger,
    payload: { trigger },
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "SUPERVISOR",
      serviceName: "worker-supervisor",
      status: "running",
      currentTask: trigger,
    });

    if (trigger === "daily_summary") {
      const snapshots = await prisma.accountSnapshot.findMany({
        orderBy: { capturedAt: "desc" },
        take: 2,
      });
      const latest = snapshots[0];
      const previous = snapshots[1] ?? latest;

      await prisma.notification.create({
        data: {
          category: "daily_summary",
          severity: "INFO",
          channel: "DISCORD",
          status: config.discordWebhookUrl ? "PENDING" : "SUPPRESSED",
          dedupeKey: `daily-summary-${new Date().toISOString().slice(0, 10)}`,
          title: "Daily trading summary",
          body: latest
            ? `Balance ${previous?.balance?.toFixed(2) ?? latest.balance.toFixed(2)} -> ${latest.balance.toFixed(2)}. Realized PnL ${latest.realizedPnlDaily.toFixed(2)}.`
            : "No account snapshot available yet.",
          payload: { latest, previous },
        },
      });
    } else {
      const [heartbeats, account] = await Promise.all([
        prisma.workerHeartbeat.findMany({ orderBy: { workerType: "asc" } }),
        prisma.accountSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
      ]);
      const throttleEvent = await maybeThrottleRisk(
        account
          ? {
              balance: account.balance,
              realizedPnlDaily: account.realizedPnlDaily,
              drawdownPct: account.drawdownPct,
            }
          : null,
      );

      const workerAlerts = summarizeWorkerHealth(
        heartbeats.map((heartbeat) => ({
          workerType: heartbeat.workerType.toLowerCase() as "news" | "market" | "validation" | "execution" | "supervisor",
          status:
            Date.now() - heartbeat.lastSeenAt.getTime() > config.schedules.supervisorMs * 4
              ? "offline"
              : heartbeat.status === "degraded"
                ? "degraded"
                : "healthy",
          lastHeartbeatAt: heartbeat.lastSeenAt.toISOString(),
          lagMs: heartbeat.lagMs,
          currentTask: heartbeat.currentTask ?? "idle",
          failureCount24h: 0,
        })),
      );
      const accountAlerts = summarizeAccountRisk(
        account
          ? {
              balance: account.balance,
              equity: account.equity,
              freeMargin: account.freeMargin,
              usedMargin: account.usedMargin,
              openPnl: account.openPnl,
              realizedPnlDaily: account.realizedPnlDaily,
              drawdownPct: account.drawdownPct,
              maxDrawdownPct: account.maxDrawdownPct,
              riskState: account.riskState,
              killSwitchActive: account.killSwitchActive,
              mode: account.mode === "PAPER" ? "paper" : "live",
            }
          : null,
      );
      const throttleAlerts = throttleEvent
        ? [{ severity: "warning" as const, summary: throttleEvent.summary }]
        : [];

      for (const alert of [...workerAlerts, ...accountAlerts, ...throttleAlerts]) {
        const notification = await prisma.notification.create({
          data: {
            category: alert.severity === "critical" ? "supervisor" : "worker_health",
            severity: alert.severity.toUpperCase() as "INFO" | "WARNING" | "CRITICAL",
            channel: "DISCORD",
            status: config.discordWebhookUrl ? "PENDING" : "SUPPRESSED",
            dedupeKey: `${alert.severity}-${alert.summary}`,
            title: "Supervisor alert",
            body: alert.summary,
          },
        });

        await prisma.supervisorEvent.create({
          data: {
            severity: alert.severity.toUpperCase() as "INFO" | "WARNING" | "CRITICAL",
            eventType: "health_check",
            summary: alert.summary,
            notificationId: notification.id,
          },
        });
      }
    }

    await completeWorkerRun(run.id, `Supervisor ${trigger} processed`);
    await upsertWorkerHeartbeat({
      workerType: "SUPERVISOR",
      serviceName: "worker-supervisor",
      status: "healthy",
      currentTask: "idle",
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "SUPERVISOR",
      message: err.message,
      stack: err.stack,
      payload: { trigger },
    });
    await upsertWorkerHeartbeat({
      workerType: "SUPERVISOR",
      serviceName: "worker-supervisor",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message },
    });
    throw error;
  }
};

const processNotification = async (payload: {
  category: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}) => {
  const notification = await prisma.notification.create({
    data: {
      category: payload.category,
      severity: payload.severity.toUpperCase() as "INFO" | "WARNING" | "CRITICAL",
      channel: "DISCORD",
      status: config.discordWebhookUrl ? "PENDING" : "SUPPRESSED",
      dedupeKey: payload.dedupeKey,
      title: payload.title,
      body: payload.body,
      payload: asJson(payload.metadata),
    },
  });

  if (!config.discordWebhookUrl) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { status: "SUPPRESSED", errorMessage: "DISCORD_WEBHOOK_URL is not configured." },
    });
    return;
  }

  const response = await fetch(config.discordWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `**${payload.title}**\n${payload.body}`,
    }),
  });

  await prisma.notification.update({
    where: { id: notification.id },
    data: {
      status: response.ok ? "SENT" : "FAILED",
      deliveredAt: response.ok ? new Date() : null,
      lastAttemptAt: new Date(),
      errorMessage: response.ok ? null : `Discord webhook failed with ${response.status}`,
    },
  });
};

setInterval(() => {
  void upsertWorkerHeartbeat({
    workerType: "SUPERVISOR",
    serviceName: "worker-supervisor",
    status: "healthy",
    currentTask: "monitoring",
  });
}, 15_000);

void ensureDefaultSchedules().catch((error) => {
  logger.error("Failed to ensure schedules", { error: (error as Error).message });
});

createPlatformWorker<{ trigger: "health_check" | "daily_summary" | "manual" }>(
  queueNames.supervisor,
  "worker-supervisor",
  async (payload) => {
    await processSupervisorJob(payload.trigger);
  },
);

createPlatformWorker<{
  category: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}>(queueNames.notifications, "worker-supervisor-notifications", async (payload) => {
  await processNotification(payload);
});

logger.info("Supervisor worker started");
