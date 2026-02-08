import { Queue } from "bullmq";

const connection = {
  connection: {
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
  },
};

export const weeklyRefreshQueue = new Queue("weeklyRefreshQueue", connection);
export const dailyUpdateQueue = new Queue("dailyUpdateQueue", connection);
export const intradayScanQueue = new Queue("intradayScanQueue", connection);
