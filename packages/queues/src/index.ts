import { getPlatformConfig } from "@stock-radar/config";
import { createLogger } from "@stock-radar/logging";
import type { DiscordNotificationPayload } from "@stock-radar/types";
import { Queue, Worker } from "bullmq";

export const queueNames = {
  news: "queue:news-intelligence",
  market: "queue:market-analysis",
  validation: "queue:validation",
  execution: "queue:execution",
  supervisor: "queue:supervisor",
  notifications: "queue:notifications",
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export interface NewsQueuePayload {
  sweepType: "urgent" | "broad";
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

export const createPlatformQueues = () => ({
  news: createPlatformQueue(queueNames.news),
  market: createPlatformQueue(queueNames.market),
  validation: createPlatformQueue(queueNames.validation),
  execution: createPlatformQueue(queueNames.execution),
  supervisor: createPlatformQueue(queueNames.supervisor),
  notifications: createPlatformQueue(queueNames.notifications),
});

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

export const ensureDefaultSchedules = async () => {
  const config = getPlatformConfig();
  const queues = createPlatformQueues();
  const logger = createLogger("scheduler");

  await queues.news.add("urgentSweep", { sweepType: "urgent" } satisfies NewsQueuePayload, {
    repeat: { every: config.schedules.newsUrgentMs },
    jobId: "news-urgent-repeat",
  });
  await queues.news.add("broadSweep", { sweepType: "broad" } satisfies NewsQueuePayload, {
    repeat: { every: config.schedules.newsBroadMs },
    jobId: "news-broad-repeat",
  });
  await queues.market.add("scanWatchlist", {} satisfies MarketQueuePayload, {
    repeat: { every: config.schedules.marketScanMs },
    jobId: "market-repeat",
  });
  await queues.validation.add("periodicValidation", { trigger: "periodic_rescore" } satisfies ValidationQueuePayload, {
    repeat: { every: config.schedules.validationMs },
    jobId: "validation-repeat",
  });
  await queues.execution.add("executionLoop", { trigger: "periodic_loop" } satisfies ExecutionQueuePayload, {
    repeat: { every: config.schedules.executionMs },
    jobId: "execution-repeat",
  });
  await queues.supervisor.add("healthCheck", { trigger: "health_check" } satisfies SupervisorQueuePayload, {
    repeat: { every: config.schedules.supervisorMs },
    jobId: "supervisor-repeat",
  });
  await queues.supervisor.add("dailySummary", { trigger: "daily_summary" } satisfies SupervisorQueuePayload, {
    repeat: { pattern: config.schedules.dailySummaryCron },
    jobId: "supervisor-daily-summary",
  });

  logger.info("Default schedules ensured");
};

export const queueNotification = async (payload: DiscordNotificationPayload) => {
  const queues = createPlatformQueues();
  return queues.notifications.add("dispatchNotification", payload, {
    jobId: payload.dedupeKey,
  });
};
