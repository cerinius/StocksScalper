import { Prisma } from "@prisma/client";
import type { WorkerType, WorkerRunStatus } from "@prisma/client";
import { prisma } from "./index";

const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

export const upsertWorkerHeartbeat = async (input: {
  workerType: WorkerType;
  serviceName: string;
  status: string;
  currentTask?: string;
  lagMs?: number;
  metrics?: Record<string, unknown>;
}) =>
  prisma.workerHeartbeat.upsert({
    where: { workerType: input.workerType },
    update: {
      serviceName: input.serviceName,
      status: input.status,
      currentTask: input.currentTask,
      lagMs: input.lagMs ?? 0,
      metrics: input.metrics ? asJson(input.metrics) : undefined,
      lastSeenAt: new Date(),
    },
    create: {
      workerType: input.workerType,
      serviceName: input.serviceName,
      status: input.status,
      currentTask: input.currentTask,
      lagMs: input.lagMs ?? 0,
      metrics: input.metrics ? asJson(input.metrics) : undefined,
      lastSeenAt: new Date(),
    },
  });

export const createWorkerRun = async (input: {
  workerType: WorkerType;
  queueName: string;
  jobName: string;
  payload?: Record<string, unknown>;
  status?: WorkerRunStatus;
}) =>
  prisma.workerRun.create({
    data: {
      workerType: input.workerType,
      status: input.status ?? "RUNNING",
      queueName: input.queueName,
      jobName: input.jobName,
      payload: input.payload ? asJson(input.payload) : undefined,
      startedAt: new Date(),
    },
  });

export const completeWorkerRun = async (runId: string, resultSummary?: string, reasoning?: Record<string, unknown>) => {
  // Fetch startedAt to compute accurate durationMs
  const run = await prisma.workerRun.findUnique({ where: { id: runId }, select: { startedAt: true } });
  const durationMs = run ? Date.now() - run.startedAt.getTime() : undefined;

  return prisma.workerRun.update({
    where: { id: runId },
    data: {
      status: "SUCCEEDED",
      finishedAt: new Date(),
      durationMs,
      resultSummary,
      reasoning: reasoning ? asJson(reasoning) : undefined,
    },
  });
};

export const failWorkerRun = async (input: {
  runId?: string;
  workerType: WorkerType;
  message: string;
  stack?: string;
  retryCount?: number;
  payload?: Record<string, unknown>;
}) => {
  if (input.runId) {
    const run = await prisma.workerRun.findUnique({ where: { id: input.runId }, select: { startedAt: true } });
    const durationMs = run ? Date.now() - run.startedAt.getTime() : undefined;

    await prisma.workerRun.update({
      where: { id: input.runId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        durationMs,
        resultSummary: input.message,
      },
    });
  }

  return prisma.workerFailure.create({
    data: {
      workerRunId: input.runId,
      workerType: input.workerType,
      errorMessage: input.message,
      stack: input.stack,
      retryCount: input.retryCount ?? 0,
      payload: input.payload ? asJson(input.payload) : undefined,
    },
  });
};
