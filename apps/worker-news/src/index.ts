import { setInterval } from "timers/promises";
import { Prisma } from "@prisma/client";
import { getPlatformConfig } from "@stock-radar/config";
import {
  completeWorkerRun,
  createWorkerRun,
  failWorkerRun,
  prisma,
  upsertWorkerHeartbeat,
} from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { queueNames } from "@stock-radar/queues";

type PolygonNewsArticle = {
  id: string;
  title: string;
  article_url?: string;
  description?: string;
  image_url?: string;
  published_utc: string;
  tickers?: string[];
  keywords?: string[];
  publisher?: {
    name?: string;
  };
};

type PolygonNewsResponse = {
  results?: PolygonNewsArticle[];
};

const config = getPlatformConfig();
const logger = createLogger("worker-news");

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const POLLING_INTERVAL = Number(process.env.NEWS_URGENT_INTERVAL_MS ?? "60000");
const NEWS_LIMIT = Number(process.env.NEWS_LIMIT ?? "25");
const SEND_LATEST_ON_STARTUP = process.env.SEND_LATEST_ON_STARTUP === "true";

const CURSOR_SETTING_KEY = "news.latestArticleId";

let isRunning = false;

const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

function ensurePositiveNumber(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function getLatestArticleId(): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: CURSOR_SETTING_KEY },
  });

  if (!row) return null;
  return typeof row.value === "string" ? row.value : null;
}

async function setLatestArticleId(articleId: string): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: CURSOR_SETTING_KEY },
    update: {
      value: articleId,
      valueType: "string",
      description: "Latest Polygon news article id processed by worker-news",
    },
    create: {
      key: CURSOR_SETTING_KEY,
      value: articleId,
      valueType: "string",
      description: "Latest Polygon news article id processed by worker-news",
    },
  });
}

async function sendToDiscord(article: PolygonNewsArticle): Promise<boolean> {
  if (!DISCORD_WEBHOOK_URL) {
    logger.warn("DISCORD_WEBHOOK_URL is not configured; suppressing news alert");
    return true;
  }

  const payload = {
    embeds: [
      {
        title: article.title,
        url: article.article_url,
        description: article.description?.slice(0, 4000),
        author: { name: article.publisher?.name || "Polygon News" },
        ...(article.image_url ? { image: { url: article.image_url } } : {}),
        timestamp: new Date(article.published_utc).toISOString(),
        footer: {
          text: `Tickers: ${article.tickers?.join(", ") || "N/A"}`,
        },
        color: 0x00a3e0,
      },
    ],
  };

  try {
    const res = await fetchWithTimeout(
      DISCORD_WEBHOOK_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      10000,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error("Discord webhook rejected payload", {
        status: res.status,
        body,
        articleId: article.id,
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Failed to send article to Discord", {
      articleId: article.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function fetchPolygonNews(): Promise<PolygonNewsArticle[]> {
  if (!MASSIVE_API_KEY) {
    throw new Error("MASSIVE_API_KEY is not defined");
  }

  const url =
    `https://api.polygon.io/v2/reference/news` +
    `?limit=${NEWS_LIMIT}` +
    `&sort=published_utc` +
    `&order=desc` +
    `&apiKey=${encodeURIComponent(MASSIVE_API_KEY)}`;

  const res = await fetchWithTimeout(url, {}, 15000);

  if (!res.ok) {
    throw new Error(`Polygon API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as PolygonNewsResponse;
  return data.results ?? [];
}

async function pollNews(trigger: "startup" | "interval") {
  const run = await createWorkerRun({
    workerType: "NEWS",
    queueName: queueNames.news,
    jobName: trigger === "startup" ? "startupPoll" : "intervalPoll",
    payload: { trigger },
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "running",
      currentTask: trigger === "startup" ? "startup-poll" : "polling-polygon",
    });

    const results = await fetchPolygonNews();
    logger.info("Fetched Polygon news", {
      count: results.length,
      trigger,
    });

    if (results.length === 0) {
      await completeWorkerRun(run.id, "No news returned", { fetched: 0, newArticles: 0 });
      await upsertWorkerHeartbeat({
        workerType: "NEWS",
        serviceName: "worker-news",
        status: "healthy",
        currentTask: "idle",
        metrics: { fetched: 0, newArticles: 0 },
      });
      return;
    }

    let latestArticleId = await getLatestArticleId();

    if (!latestArticleId) {
      latestArticleId = results[0].id;
      await setLatestArticleId(latestArticleId);

      logger.info("Initialized latest Polygon article cursor", {
        latestArticleId,
      });

      if (SEND_LATEST_ON_STARTUP && results[0]) {
        logger.info("SEND_LATEST_ON_STARTUP enabled; sending latest article");
        await sendToDiscord(results[0]);
      }

      await completeWorkerRun(run.id, "Initialized cursor", {
        fetched: results.length,
        initializedTo: latestArticleId,
      });

      await upsertWorkerHeartbeat({
        workerType: "NEWS",
        serviceName: "worker-news",
        status: "healthy",
        currentTask: "idle",
        metrics: { fetched: results.length, initialized: true },
      });

      return;
    }

    const unseen: PolygonNewsArticle[] = [];
    for (const article of results) {
      if (article.id === latestArticleId) break;
      unseen.push(article);
    }

    logger.info("Computed unseen Polygon articles", {
      previousLatestArticleId: latestArticleId,
      unseenCount: unseen.length,
    });

    let sentCount = 0;
    let newestProcessedId: string | null = latestArticleId;

    for (const article of unseen.reverse()) {
      logger.info("Dispatching Polygon article", {
        articleId: article.id,
        title: article.title,
      });

      const ok = await sendToDiscord(article);
      if (!ok) {
        break;
      }

      newestProcessedId = article.id;
      sentCount += 1;
    }

    if (newestProcessedId && newestProcessedId !== latestArticleId) {
      await setLatestArticleId(newestProcessedId);
    }

    await completeWorkerRun(run.id, `${sentCount} news alerts sent`, {
      fetched: results.length,
      unseenCount: unseen.length,
      sentCount,
      latestArticleId: newestProcessedId,
    });

    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "healthy",
      currentTask: "idle",
      metrics: {
        fetched: results.length,
        unseenCount: unseen.length,
        sentCount,
      },
    });
  } catch (error) {
    const err = error as Error;

    await failWorkerRun({
      runId: run.id,
      workerType: "NEWS",
      message: err.message,
      stack: err.stack,
      payload: { trigger },
    });

    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message },
    });

    logger.error("News poll failed", {
      trigger,
      error: err.message,
    });
  }
}

async function runPoll(trigger: "startup" | "interval") {
  if (isRunning) {
    logger.warn("Skipping overlapping news poll", { trigger });
    return;
  }

  isRunning = true;
  try {
    await pollNews(trigger);
  } finally {
    isRunning = false;
  }
}

async function start() {
  ensurePositiveNumber(POLLING_INTERVAL, "NEWS_URGENT_INTERVAL_MS");
  ensurePositiveNumber(NEWS_LIMIT, "NEWS_LIMIT");

  logger.info("Starting Polygon.io news worker", {
    pollingIntervalMs: POLLING_INTERVAL,
    newsLimit: NEWS_LIMIT,
  });

  process.on("SIGTERM", () => {
    logger.warn("worker-news received SIGTERM");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    logger.warn("worker-news received SIGINT");
    process.exit(0);
  });

  await runPoll("startup");

  for await (const _ of setInterval(POLLING_INTERVAL)) {
    await runPoll("interval");
  }
}

start().catch((error) => {
  logger.error("worker-news failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});