import { getPlatformConfig } from "@stock-radar/config";
import { summarizeAccountRisk, summarizeWorkerHealth } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformWorker, ensureDefaultSchedules, queueNames } from "@stock-radar/queues";

const config = getPlatformConfig();
const logger = createLogger("worker-supervisor");
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

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

      for (const alert of [...workerAlerts, ...accountAlerts]) {
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
