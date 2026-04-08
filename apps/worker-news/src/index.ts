import { AssetClass, Prisma } from "@prisma/client";
import { getPlatformConfig } from "@stock-radar/config";
import { createNewsProvider, scoreNewsIntelligence } from "@stock-radar/core";
import type { NewsItem } from "@stock-radar/core";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformQueues, createPlatformWorker, queueNames, queueNotification } from "@stock-radar/queues";
import { stableHash } from "@stock-radar/shared";

const config = getPlatformConfig();
const logger = createLogger("worker-news");
const queues = createPlatformQueues();
const newsProvider = createNewsProvider();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

const NEWS_LIMIT = config.news.limit;

const KNOWN_FIAT_BASES = new Set(["EUR", "GBP", "AUD", "NZD", "CAD", "CHF", "JPY"]);
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
    return symbol.length > 6 ? AssetClass.CRYPTO : AssetClass.FX;
  }

  if (["SPY", "QQQ"].includes(symbol)) return AssetClass.ETF;
  return AssetClass.EQUITY;
};

const normalizeTicker = (ticker: string) => ticker.toUpperCase().replace(/[^A-Z0-9]/g, "");

const getWatchlistSymbols = async (): Promise<string[]> => {
  const activeWatchlist = await prisma.watchlist.findFirst({
    where: { isActive: true },
    include: { items: { include: { symbol: true } } },
  });

  if (activeWatchlist && activeWatchlist.items.length > 0) {
    return activeWatchlist.items.map((item) => item.symbol.ticker);
  }

  logger.warn("No active watchlist found, falling back to default symbols");
  return config.watchlistFallbackSymbols;
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
  article: NewsItem,
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
) => {
  if (urgency !== "HIGH" && urgency !== "CRITICAL") return;

  await queueNotification({
    category: "market_news",
    severity: urgency === "CRITICAL" ? "critical" : "warning",
    title: article.headline,
    body: article.summary || article.headline,
    dedupeKey: `market-news-${stableHash({ id: article.id, urgency }).slice(0, 24)}`,
    metadata: {
      articleId: article.id,
      articleUrl: article.url ?? null,
      publishedUtc: article.publishedAt,
      tickers: [article.symbol],
      urgency,
    },
  });
};

const persistArticle = async (article: NewsItem) => {
  const symbols = [normalizeTicker(article.symbol)].filter(Boolean);
  const affectedAssetClasses = [...new Set(symbols.map((symbol) => assetClassFromSymbol(symbol).toString()))];

  const scored = scoreNewsIntelligence({
    source: article.source,
    headline: article.headline,
    summary: article.summary ?? "",
    originalTimestamp: article.publishedAt,
    affectedSymbols: symbols,
    affectedAssetClasses,
    tags: article.tags ?? [],
    category: symbols.length > 0 ? "symbol" : "macro",
    rawPayloadRef: article.url,
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
        ...article,
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
        ...article,
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
        reasoning: `Linked from ${article.source} for ${ticker}`,
      },
      create: {
        newsItemId: newsItem.id,
        symbolId: symbol.id,
        relevanceScore: scored.relevanceScore,
        reasoning: `Linked from ${article.source} for ${ticker}`,
      },
    });
  }

  return { newsItem, scored, symbols };
};

const processNewsSweep = async (payload: { trigger?: "schedule" | "manual" | "startup" }) => {
  const run = await createWorkerRun({
    workerType: "NEWS",
    queueName: queueNames.news,
    jobName: "watchlistSweep",
    payload,
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "running",
      currentTask: `watchlist-sweep`,
    });

    const symbols = await getWatchlistSymbols();
    const results = await newsProvider.getNewsForSymbols(symbols, NEWS_LIMIT);

    if (results.length === 0) {
      await completeWorkerRun(run.id, "No news returned from provider", { fetched: 0, inserted: 0, linked: 0 });
      await upsertWorkerHeartbeat({
        workerType: "NEWS",
        serviceName: "worker-news",
        status: "healthy",
        currentTask: "idle",
        metrics: { fetched: 0, inserted: 0, linked: 0 },
      });
      return;
    }

    let inserted = 0;
    let linked = 0;
    let notifications = 0;

    for (const article of results) {
      const persisted = await persistArticle(article);
      inserted += 1;
      linked += persisted.symbols.length;

      if (persisted.scored.urgency === "HIGH" || persisted.scored.urgency === "CRITICAL") {
        await maybeQueueUrgentNotification(
          article,
          persisted.scored.urgency as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
        );
        notifications += 1;
      }
    }

    await completeWorkerRun(run.id, `${inserted} articles processed`, {
      fetched: results.length,
      inserted,
      linked,
      notifications,
    });

    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "healthy",
      currentTask: "idle",
      metrics: { fetched: results.length, inserted, linked, notifications },
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
      metrics: { error: err.message },
    });
    throw error;
  }
};

async function bootstrap() {
  logger.info("worker-news starting", {
    newsLimit: NEWS_LIMIT,
    provider: config.news.provider,
  });

  process.on("SIGTERM", () => {
    logger.warn("worker-news received SIGTERM");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    logger.warn("worker-news received SIGINT");
    process.exit(0);
  });

  createPlatformWorker<{ trigger?: "schedule" | "manual" | "startup" }>(
    queueNames.news,
    "worker-news",
    async (payload) => {
      await processNewsSweep(payload);
    },
  );

  await queues.news.add(
    "startupNewsSweep",
    { trigger: "startup" },
    { jobId: `news-startup-${Date.now()}` },
  );

  await upsertWorkerHeartbeat({
    workerType: "NEWS",
    serviceName: "worker-news",
    status: "healthy",
    currentTask: "idle",
    metrics: { provider: config.news.provider, newsLimit: NEWS_LIMIT },
  });

  logger.info("worker-news ready");
}

bootstrap().catch((error) => {
  logger.error("worker-news failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
