import { createPlatformQueues } from "@stock-radar/queues";
import { prisma } from "@stock-radar/db";
import { writeAuditLog } from "../../lib/audit";

const queues = createPlatformQueues();

export const triggerWorkerJob = async (worker: string, actorId?: string) => {
  const queueMap = {
    news: () => queues.news.add("manualNewsSweep", { sweepType: "urgent" }),
    market: () => queues.market.add("manualMarketScan", {}),
    validation: () => queues.validation.add("manualValidation", { trigger: "manual" }),
    execution: () => queues.execution.add("manualExecutionLoop", { trigger: "manual" }),
    supervisor: () => queues.supervisor.add("manualSupervisor", { trigger: "manual" }),
  } as const;

  const selected = queueMap[worker as keyof typeof queueMap];
  if (!selected) {
    throw new Error(`Unknown worker "${worker}"`);
  }

  const job = await selected();
  await writeAuditLog({
    actorType: "USER",
    actorId,
    category: "control.worker",
    message: `Triggered manual ${worker} job.`,
    entityType: "queue_job",
    entityId: String(job.id),
  });

  return { queued: true, jobId: job.id };
};

export const setKillSwitch = async (active: boolean, actorId?: string) => {
  const latestSnapshot = await prisma.accountSnapshot.findFirst({ orderBy: { capturedAt: "desc" } });

  await prisma.systemSetting.upsert({
    where: { key: "risk.killSwitch" },
    update: { value: { active }, valueType: "json" },
    create: {
      key: "risk.killSwitch",
      value: { active },
      valueType: "json",
      description: "Manual emergency trading stop",
    },
  });

  if (latestSnapshot) {
    await prisma.accountSnapshot.create({
      data: {
        integrationId: latestSnapshot.integrationId,
        capturedAt: new Date(),
        balance: latestSnapshot.balance,
        equity: latestSnapshot.equity,
        freeMargin: latestSnapshot.freeMargin,
        usedMargin: latestSnapshot.usedMargin,
        marginLevel: latestSnapshot.marginLevel,
        openPnl: latestSnapshot.openPnl,
        realizedPnlDaily: latestSnapshot.realizedPnlDaily,
        drawdownPct: latestSnapshot.drawdownPct,
        maxDrawdownPct: latestSnapshot.maxDrawdownPct,
        riskState: active ? "KILL_SWITCH" : latestSnapshot.riskState,
        killSwitchActive: active,
        mode: latestSnapshot.mode,
      },
    });
  }

  await prisma.riskEvent.create({
    data: {
      severity: active ? "CRITICAL" : "INFO",
      eventType: "kill_switch",
      message: active ? "Kill switch activated manually." : "Kill switch cleared manually.",
      details: { active, actorId },
      blocking: active,
    },
  });

  await writeAuditLog({
    actorType: "USER",
    actorId,
    category: "control.kill_switch",
    message: active ? "Activated kill switch." : "Cleared kill switch.",
    entityType: "system_setting",
    entityId: "risk.killSwitch",
    severity: active ? "CRITICAL" : "INFO",
  });

  return { active };
};
