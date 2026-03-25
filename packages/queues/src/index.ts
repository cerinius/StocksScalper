import { getPlatformConfig } from "@stock-radar/config";
import { createLogger } from "@stock-radar/logging";
import { stableHash } from "@stock-radar/shared";
import type { DiscordNotificationPayload } from "@stock-radar/types";
import { Queue, Worker } from "bullmq";

export const queueNames = {
  news: "queue-news-intelligence",
  market: "queue-market-analysis",
  validation: "queue-validation",
  execution: "queue-execution",
  supervisor: "queue-supervisor",
  notifications: "queue-notifications",
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export interface NewsQueuePayload {
  sweepType: "urgent" | "broad";
  trigger?: "schedule" | "manual" | "startup";
}

export interface MarketQueuePayload {
  symbols?: string[];
}

export interface ValidationQueuePayload {
  candidateId?: string;
  trigger: "candidate_created" | "periodic_rescore" | "manual";
}

export interface ExecutionQueuePayload {
  candidateId?: string;
  decisionId?: string;
  trigger: "validation_completed" | "periodic_loop" | "manual";
}

export interface SupervisorQueuePayload {
  trigger: "health_check" | "daily_summary" | "manual";
}

export interface WorkerProcessor<T> {
  (payload: T): Promise<Record<string, unknown> | void>;
}

const getConnection = () => ({ connection: { url: getPlatformConfig().redisUrl } });

export const sanitizeQueueJobId = (value: string) => {
  const normalized = value
    .trim()
    .replace(/[:\s/\\]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (normalized.length === 0) {
    return `job-${stableHash(value).slice(0, 16)}`;
  }

  return normalized.slice(0, 180);
};

export const createPlatformQueue = (name: QueueName) =>
  new Queue(name, {
    ...getConnection(),
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 100,
      removeOnFail: 100,
      backoff: {
        type: "exponential",
        delay: 1_000,
      },
    },
  });

// Singleton queue instances — shared across the calling process to avoid connection proliferation.
// Each process that calls createPlatformQueues() gets one set of Queue connections.
let platformQueues: ReturnType<typeof buildPlatformQueues> | null = null;

const buildPlatformQueues = () => ({
  news: createPlatformQueue(queueNames.news),
  market: createPlatformQueue(queueNames.market),
  validation: createPlatformQueue(queueNames.validation),
  execution: createPlatformQueue(queueNames.execution),
  supervisor: createPlatformQueue(queueNames.supervisor),
  notifications: createPlatformQueue(queueNames.notifications),
});

export const createPlatformQueues = () => {
  if (!platformQueues) {
    platformQueues = buildPlatformQueues();
  }
  return platformQueues;
};

export const createPlatformWorker = <T>(queueName: QueueName, serviceName: string, processor: WorkerProcessor<T>) => {
  const logger = createLogger(serviceName, { queueName });
  const worker = new Worker(
    queueName,
    async (job) => {
      logger.info("Processing queue job", { jobId: job.id, jobName: job.name });
      return processor(job.data as T);
    },
    {
      ...getConnection(),
      concurrency: 1,
    },
  );

  worker.on("completed", (job) => {
    logger.info("Queue job completed", { jobId: job.id, jobName: job.name });
  });

  worker.on("failed", (job, error) => {
    logger.error("Queue job failed", {
      jobId: job?.id,
      jobName: job?.name,
      error: error.message,
    });
  });

  return worker;
};

const syncRepeatableJob = async <T extends object>(
  queue: Queue,
  name: string,
  data: T,
  repeat: { every?: number; pattern?: string },
  jobId: string,
) => {
  const repeatableJobs = await queue.getRepeatableJobs();
  const existingJobs = repeatableJobs.filter((job) => job.name === name);

  for (const job of existingJobs) {
    const sameEvery = typeof repeat.every === "number" && Number(job.every) === repeat.every;
    const samePattern = typeof repeat.pattern === "string" && job.pattern === repeat.pattern;
    if (sameEvery || samePattern) continue;

    await queue.removeRepeatableByKey(job.key);
  }

  return queue.add(name, data, {
    repeat,
    jobId: sanitizeQueueJobId(jobId),
  });
};

export const ensureDefaultSchedules = async () => {
  const config = getPlatformConfig();
  // Use the shared singleton queues — do not create a new set of queues here
  // to avoid connection leaks. We are safe to use the singleton because
  // ensureDefaultSchedules is called once at worker-supervisor bootstrap.
  const queues = createPlatformQueues();
  const logger = createLogger("scheduler");

  await syncRepeatableJob(
    queues.news,
    "urgentSweep",
    { sweepType: "urgent", trigger: "schedule" } satisfies NewsQueuePayload,
    { every: config.schedules.newsUrgentMs },
    "news-urgent-repeat",
  );
  await syncRepeatableJob(
    queues.news,
    "broadSweep",
    { sweepType: "broad", trigger: "schedule" } satisfies NewsQueuePayload,
    { every: config.schedules.newsBroadMs },
    "news-broad-repeat",
  );
  await syncRepeatableJob(queues.market, "scanWatchlist", {} satisfies MarketQueuePayload, {
    every: config.schedules.marketScanMs,
  }, "market-repeat");
  await syncRepeatableJob(
    queues.validation,
    "periodicValidation",
    { trigger: "periodic_rescore" } satisfies ValidationQueuePayload,
    { every: config.schedules.validationMs },
    "validation-repeat",
  );
  await syncRepeatableJob(
    queues.execution,
    "executionLoop",
    { trigger: "periodic_loop" } satisfies ExecutionQueuePayload,
    { every: config.schedules.executionMs },
    "execution-repeat",
  );
  await syncRepeatableJob(
    queues.supervisor,
    "healthCheck",
    { trigger: "health_check" } satisfies SupervisorQueuePayload,
    { every: config.schedules.supervisorMs },
    "supervisor-repeat",
  );
  await syncRepeatableJob(
    queues.supervisor,
    "dailySummary",
    { trigger: "daily_summary" } satisfies SupervisorQueuePayload,
    { pattern: config.schedules.dailySummaryCron },
    "supervisor-daily-summary",
  );

  logger.info("Default schedules ensured");
};

// queueNotification uses the shared singleton queues — no per-call connection creation.
export const queueNotification = async (payload: DiscordNotificationPayload) => {
  const queues = createPlatformQueues();
  return queues.notifications.add("dispatchNotification", payload, {
    jobId: sanitizeQueueJobId(payload.dedupeKey),
  });
};
