import { prisma } from "@stock-radar/db";

export const getWorkersOverview = async () => {
  const [heartbeats, runs, failures] = await Promise.all([
    prisma.workerHeartbeat.findMany({ orderBy: { workerType: "asc" } }),
    prisma.workerRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 }),
    prisma.workerFailure.findMany({ orderBy: { occurredAt: "desc" }, take: 20 }),
  ]);

  return {
    workers: heartbeats.map((heartbeat) => ({
      ...heartbeat,
      lastRun: runs.find((run) => run.workerType === heartbeat.workerType) ?? null,
      recentFailures: failures.filter((failure) => failure.workerType === heartbeat.workerType).slice(0, 3),
    })),
    recentRuns: runs,
    recentFailures: failures,
  };
};
