import { AssetClass, Prisma } from "@prisma/client";
import { getPlatformConfig } from "@stock-radar/config";
import { scoreNewsIntelligence } from "@stock-radar/core";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformQueues, createPlatformWorker, queueNames, queueNotification } from "@stock-radar/queues";
import { stableHash } from "@stock-radar/shared";

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
const queues = createPlatformQueues();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

// Use the centralized config for all news-specific settings
const NEWS_LIMIT = config.news.limit;
const SEND_LATEST_ON_STARTUP = config.news.sendLatestOnStartup;

// Known fiat currency bases (3-letter ISO codes ending in USD = forex pair)
const KNOWN_FIAT_BASES = new Set(["EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "JPY"]);
// Known crypto bases whose USD pair should be classified as CRYPTO
const KNOWN_CRYPTO_BASES = new Set([
  "BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH",
  "AVAX", "LINK", "DOT", "MATIC", "UNI", "ATOM", "TRX", "ETC",
]);

const assetClassFromSymbol = (symbol: string): AssetClass => {
  if (symbol === "XAUUSD" || symbol === "XAGUSD") return AssetClass.COMMODITY;

  if (symbol.endsWith("USD") && symbol.length <= 10) {
    const base = symbol.slice(0, symbol.length - 3);
    if (KNOWN_FIAT_BASES.has(base)) return AssetClass.FX;
    if (KNOWN_CRYPTO_BASES.has(base)) return AssetClass.CRYPTO;
    // Longer unknown USD pairs (e.g. SOLUSD at 6 chars) are most likely crypto
    return symbol.length > 6 ? AssetClass.CRYPTO : AssetClass.FX;
  }

  if (["SPY", "QQQ"].includes(symbol)) return AssetClass.ETF;
  return AssetClass.EQUITY;
};

const normalizeTicker = (ticker: string) => ticker.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const readCursor = async (sweepType: "urgent" | "broad") => {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: `news.cursor.${sweepType}` },
  });
  return typeof setting?.value === "string" ? setting.value : null;
};

const writeCursor = async (sweepType: "urgent" | "broad", articleId: string) => {
  await prisma.systemSetting.upsert({
    where: { key: `news.cursor.${sweepType}` },
    update: {
      value: articleId,
      valueType: "string",
      description: `Latest Polygon news article id processed by ${sweepType} sweep`,
    },
    create: {
      key: `news.cursor.${sweepType}`,
      value: articleId,
      valueType: "string",
      description: `Latest Polygon news article id processed by ${sweepType} sweep`,
    },
  });
};

const fetchPolygonNews = async (sweepType: "urgent" | "broad") => {
  const apiKey = config.marketData.massive.apiKey;
  if (!apiKey) {
    throw new Error("MASSIVE_API_KEY is not configured — required for Polygon news ingestion");
  }

  const limit = sweepType === "urgent" ? Math.max(NEWS_LIMIT, 25) : Math.max(NEWS_LIMIT, 100);
  const url =
    `https://api.polygon.io/v2/reference/news` +
    `?limit=${limit}` +
    `&sort=published_utc` +
    `&order=desc` +
    `&apiKey=${encodeURIComponent(apiKey)}`;

  const res = await fetchWithTimeout(url, {}, 15000);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Polygon API error: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as PolygonNewsResponse;
  return data.results ?? [];
};

const upsertSymbol = async (ticker: string) => {
  const assetClass = assetClassFromSymbol(ticker);

  return prisma.symbol.upsert({
    where: { ticker },
    update: { isActive: true, assetClass },
    create: {
      ticker,
      name: ticker,
      assetClass,
      exchange: assetClass === AssetClass.FX || assetClass === AssetClass.CRYPTO ? "OTC" : "NASDAQ",
      sector: assetClass.toString(),
      isActive: true,
    },
  });
};

const maybeQueueUrgentNotification = async (
  article: PolygonNewsArticle,
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
) => {
  if (urgency !== "HIGH" && urgency !== "CRITICAL") return;

  await queueNotification({
    category: "market_news",
    severity: urgency === "CRITICAL" ? "critical" : "warning",
    title: article.title,
    body: article.description || article.title,
    dedupeKey: `market-news-${stableHash({ id: article.id, urgency }).slice(0, 24)}`,
    metadata: {
      articleId: article.id,
      articleUrl: article.article_url ?? null,
      imageUrl: article.image_url ?? null,
      publishedUtc: article.published_utc,
      tickers: article.tickers ?? [],
      urgency,
    },
  });
};

const persistArticle = async (article: PolygonNewsArticle) => {
  const symbols = [...new Set((article.tickers ?? []).map(normalizeTicker).filter(Boolean))];
  const affectedAssetClasses = [...new Set(symbols.map((symbol) => assetClassFromSymbol(symbol).toString()))];

  const scored = scoreNewsIntelligence({
    source: article.publisher?.name || "Polygon News",
    headline: article.title,
    summary: article.description || article.title,
    originalTimestamp: article.published_utc,
    affectedSymbols: symbols,
    affectedAssetClasses,
    tags: [...new Set([...(article.keywords ?? []), "polygon"])],
    category: symbols.length > 0 ? "symbol" : "macro",
    rawPayloadRef: article.article_url || `polygon-${article.id}`,
  });

  const newsItem = await prisma.newsItem.upsert({
    where: { dedupeHash: scored.dedupeHash },
    update: {
      source: scored.source,
      headline: scored.headline,
      summary: scored.summary,
      originalTimestamp: new Date(scored.originalTimestamp),
      directionalBias: scored.directionalBias,
      urgency: scored.urgency,
      relevanceScore: scored.relevanceScore,
      volatilityImpact: scored.volatilityImpact,
      confidence: scored.confidence,
      tags: asJson(scored.tags),
      category: scored.category,
      affectedAssetClass: asJson(scored.affectedAssetClasses),
      rawPayloadRef: scored.rawPayloadRef,
      reasoningLog: asJson(scored.reasoningLog),
      status: scored.status,
      metadata: asJson({
        polygonId: article.id,
        imageUrl: article.image_url ?? null,
        articleUrl: article.article_url ?? null,
        keywords: article.keywords ?? [],
      }),
    },
    create: {
      source: scored.source,
      headline: scored.headline,
      summary: scored.summary,
      originalTimestamp: new Date(scored.originalTimestamp),
      directionalBias: scored.directionalBias,
      urgency: scored.urgency,
      relevanceScore: scored.relevanceScore,
      volatilityImpact: scored.volatilityImpact,
      confidence: scored.confidence,
      tags: asJson(scored.tags),
      category: scored.category,
      affectedAssetClass: asJson(scored.affectedAssetClasses),
      rawPayloadRef: scored.rawPayloadRef,
      reasoningLog: asJson(scored.reasoningLog),
      dedupeHash: scored.dedupeHash,
      status: scored.status,
      metadata: asJson({
        polygonId: article.id,
        imageUrl: article.image_url ?? null,
        articleUrl: article.article_url ?? null,
        keywords: article.keywords ?? [],
      }),
    },
  });

  for (const ticker of symbols) {
    const symbol = await upsertSymbol(ticker);
    await prisma.symbolNewsLink.upsert({
      where: {
        newsItemId_symbolId: {
          newsItemId: newsItem.id,
          symbolId: symbol.id,
        },
      },
      update: {
        relevanceScore: scored.relevanceScore,
        reasoning: `Linked from Polygon tickers for ${ticker}`,
      },
      create: {
        newsItemId: newsItem.id,
        symbolId: symbol.id,
        relevanceScore: scored.relevanceScore,
        reasoning: `Linked from Polygon tickers for ${ticker}`,
      },
    });
  }

  return { newsItem, scored, symbols };
};

const processNewsSweep = async (payload: { sweepType: "urgent" | "broad"; trigger?: "schedule" | "manual" | "startup" }) => {
  const run = await createWorkerRun({
    workerType: "NEWS",
    queueName: queueNames.news,
    jobName: payload.sweepType === "urgent" ? "urgentSweep" : "broadSweep",
    payload,
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "running",
      currentTask: `${payload.sweepType}-sweep`,
    });

    const results = await fetchPolygonNews(payload.sweepType);
    const latestStoredCursor = await readCursor(payload.sweepType);

    if (results.length === 0) {
      await completeWorkerRun(run.id, "No Polygon news returned", { fetched: 0, inserted: 0, linked: 0 });
      await upsertWorkerHeartbeat({
        workerType: "NEWS",
        serviceName: "worker-news",
        status: "healthy",
        currentTask: "idle",
        metrics: { fetched: 0, inserted: 0, linked: 0 },
      });
      return;
    }

    if (!latestStoredCursor) {
      await writeCursor(payload.sweepType, results[0].id);

      if (payload.trigger === "startup" && SEND_LATEST_ON_STARTUP && results[0]) {
        const persisted = await persistArticle(results[0]);
        await maybeQueueUrgentNotification(
          results[0],
          persisted.scored.urgency as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
        );
      }

      await completeWorkerRun(run.id, "Initialized Polygon news cursor", {
        fetched: results.length,
        initializedTo: results[0].id,
        trigger: payload.trigger ?? "schedule",
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
      if (article.id === latestStoredCursor) break;
      unseen.push(article);
    }

    let inserted = 0;
    let linked = 0;
    let notifications = 0;
    let newestProcessedId = latestStoredCursor;

    for (const article of unseen.reverse()) {
      const persisted = await persistArticle(article);
      inserted += 1;
      linked += persisted.symbols.length;
      newestProcessedId = article.id;

      if (persisted.scored.urgency === "HIGH" || persisted.scored.urgency === "CRITICAL") {
        await maybeQueueUrgentNotification(
          article,
          persisted.scored.urgency as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
        );
        notifications += 1;
      }
    }

    if (newestProcessedId !== latestStoredCursor) {
      await writeCursor(payload.sweepType, newestProcessedId);
    }

    await completeWorkerRun(run.id, `${inserted} Polygon articles processed`, {
      fetched: results.length,
      unseenCount: unseen.length,
      inserted,
      linked,
      notifications,
      latestArticleId: newestProcessedId,
    });
    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "healthy",
      currentTask: "idle",
      metrics: { fetched: results.length, unseenCount: unseen.length, inserted, linked, notifications },
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "NEWS",
      message: err.message,
      stack: err.stack,
      payload,
    });
    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message, sweepType: payload.sweepType },
    });
    throw error;
  }
};

async function bootstrap() {
  logger.info("worker-news starting", {
    newsLimit: NEWS_LIMIT,
    startupDispatch: SEND_LATEST_ON_STARTUP,
    provider: config.dataProvider,
    apiKeyConfigured: Boolean(config.marketData.massive.apiKey),
  });

  process.on("SIGTERM", () => {
    logger.warn("worker-news received SIGTERM");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    logger.warn("worker-news received SIGINT");
    process.exit(0);
  });

  createPlatformWorker<{ sweepType: "urgent" | "broad"; trigger?: "schedule" | "manual" | "startup" }>(
    queueNames.news,
    "worker-news",
    async (payload) => {
      await processNewsSweep(payload);
    },
  );

  await queues.news.add(
    "startupNewsSweep",
    { sweepType: "urgent", trigger: "startup" },
    { jobId: `news-startup-${Date.now()}` },
  );

  await upsertWorkerHeartbeat({
    workerType: "NEWS",
    serviceName: "worker-news",
    status: "healthy",
    currentTask: "idle",
    metrics: { mode: config.dataProvider, newsLimit: NEWS_LIMIT },
  });

  logger.info("worker-news ready");
}

bootstrap().catch((error) => {
  logger.error("worker-news failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
