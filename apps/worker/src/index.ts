import { Worker } from "bullmq";
import { weeklyUniverseRefresh } from "./jobs/weeklyUniverseRefresh";
import { dailyUpdate } from "./jobs/dailyUpdate";
import { intradayScan } from "./jobs/intradayScan";

const connection = {
  connection: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
  },
};

const weeklyWorker = new Worker(
  "weeklyRefreshQueue",
  async () => {
    await weeklyUniverseRefresh();
  },
  connection,
);

const dailyWorker = new Worker(
  "dailyUpdateQueue",
  async () => {
    await dailyUpdate();
  },
  connection,
);

const intradayWorker = new Worker(
  "intradayScanQueue",
  async () => {
    await intradayScan();
  },
  connection,
);

const workers = [weeklyWorker, dailyWorker, intradayWorker];

workers.forEach((worker) => {
  worker.on("completed", (job) => {
    // eslint-disable-next-line no-console
    console.log(`Job ${job.id} completed on ${worker.name}`);
  });
  worker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`Job ${job?.id} failed on ${worker.name}`, err);
  });
});
