import { FastifyInstance } from "fastify";
import { dailyUpdateQueue, intradayScanQueue, weeklyRefreshQueue } from "../services/queues";

export const jobRoutes = async (app: FastifyInstance) => {
  app.post("/api/jobs/run-weekly-refresh", async () => {
    const job = await weeklyRefreshQueue.add("weeklyUniverseRefresh", {});
    return { queued: true, jobId: job.id };
  });

  app.post("/api/jobs/run-daily-update", async () => {
    const job = await dailyUpdateQueue.add("dailyUpdate", {});
    return { queued: true, jobId: job.id };
  });

  app.post("/api/jobs/run-intraday-scan", async () => {
    const job = await intradayScanQueue.add("intradayScan", {});
    return { queued: true, jobId: job.id };
  });
};
