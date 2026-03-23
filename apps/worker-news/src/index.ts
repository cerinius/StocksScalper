import { getPlatformConfig } from "@stock-radar/config";
import { MockNewsProvider, scoreNewsIntelligence } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformWorker, queueNames, queueNotification } from "@stock-radar/queues";

const config = getPlatformConfig();
const logger = createLogger("worker-news");
const provider = new MockNewsProvider();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

const upsertNewsItem = async (symbol: string, item: ReturnType<typeof scoreNewsIntelligence>) => {
  const existing = await prisma.newsItem.findUnique({ where: { dedupeHash: item.dedupeHash } });
  const symbolRecord = await prisma.symbol.upsert({
    where: { ticker: symbol },
    update: { isActive: true },
    create: {
      ticker: symbol,
      name: symbol,
      assetClass: symbol.endsWith("USD") ? "FX" : "EQUITY",
      exchange: symbol.endsWith("USD") ? "OTC" : "NASDAQ",
    },
  });

  const newsItem =
    existing ??
    (await prisma.newsItem.create({
      data: {
        source: item.source,
        headline: item.headline,
        summary: item.summary,
        originalTimestamp: new Date(item.originalTimestamp),
        ingestedAt: new Date(item.ingestionTimestamp),
        directionalBias: item.directionalBias,
        urgency: item.urgency,
        relevanceScore: item.relevanceScore,
        volatilityImpact: item.volatilityImpact,
        confidence: item.confidence,
        tags: item.tags,
        category: item.category,
        affectedAssetClass: item.affectedAssetClasses,
        rawPayloadRef: item.rawPayloadRef,
        reasoningLog: asJson(item.reasoningLog),
        dedupeHash: item.dedupeHash,
        status: item.status,
      },
    }));

  await prisma.symbolNewsLink.upsert({
    where: {
      newsItemId_symbolId: {
        newsItemId: newsItem.id,
        symbolId: symbolRecord.id,
      },
    },
    update: { relevanceScore: item.relevanceScore },
    create: {
      newsItemId: newsItem.id,
      symbolId: symbolRecord.id,
      relevanceScore: item.relevanceScore,
      reasoning: "News intelligence worker linked symbol context.",
    },
  });

  return newsItem;
};

const processSweep = async (sweepType: "urgent" | "broad") => {
  const run = await createWorkerRun({
    workerType: "NEWS",
    queueName: queueNames.news,
    jobName: sweepType,
    payload: { sweepType },
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "running",
      currentTask: `${sweepType}-sweep`,
    });

    const symbols = sweepType === "urgent" ? config.watchlistSymbols.slice(0, 5) : config.watchlistSymbols;
    const macroItems = await provider.getMacroNews(sweepType === "urgent" ? 2 : 5);
    let stored = 0;
    let highUrgency = 0;

    for (const macro of macroItems) {
      const scored = scoreNewsIntelligence({
        source: macro.source,
        headline: macro.headline,
        summary: macro.summary ?? "",
        originalTimestamp: macro.publishedAt,
        affectedSymbols: [macro.symbol],
        affectedAssetClasses: [macro.symbol.endsWith("USD") ? "FX" : "INDEX"],
        tags: macro.tags ?? [],
        category: "macro",
        rawPayloadRef: macro.url,
      });
      await upsertNewsItem(macro.symbol, scored);
      stored += 1;
      if (["HIGH", "CRITICAL"].includes(scored.urgency)) highUrgency += 1;
    }

    for (const symbol of symbols) {
      const items = await provider.getNews(symbol, sweepType === "urgent" ? 1 : 3);
      for (const item of items) {
        const scored = scoreNewsIntelligence({
          source: item.source,
          headline: item.headline,
          summary: item.summary ?? "",
          originalTimestamp: item.publishedAt,
          affectedSymbols: [symbol],
          affectedAssetClasses: [symbol.endsWith("USD") ? "FX" : "EQUITY"],
          tags: item.tags ?? [],
          category: "symbol-specific",
          rawPayloadRef: item.url,
        });
        await upsertNewsItem(symbol, scored);
        stored += 1;
        if (["HIGH", "CRITICAL"].includes(scored.urgency)) highUrgency += 1;
      }
    }

    if (highUrgency > 0) {
      await queueNotification({
        category: "market_news",
        severity: "warning",
        title: "High urgency news detected",
        body: `${highUrgency} high urgency news item(s) were ingested during the ${sweepType} sweep.`,
        dedupeKey: `news-${sweepType}-${new Date().toISOString().slice(0, 16)}`,
        metadata: { sweepType, highUrgency },
      });
    }

    await prisma.auditLog.create({
      data: {
        actorType: "WORKER",
        actorId: "worker-news",
        workerType: "NEWS",
        severity: "INFO",
        category: "worker.news",
        message: `News sweep completed with ${stored} stored items.`,
        entityType: "worker_run",
        entityId: run.id,
        data: { stored, sweepType },
      },
    });

    await completeWorkerRun(run.id, `${stored} items stored`, { stored, highUrgency });
    await upsertWorkerHeartbeat({
      workerType: "NEWS",
      serviceName: "worker-news",
      status: "healthy",
      currentTask: "idle",
      metrics: { stored, highUrgency },
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "NEWS",
      message: err.message,
      stack: err.stack,
      payload: { sweepType },
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

setInterval(() => {
  void upsertWorkerHeartbeat({
    workerType: "NEWS",
    serviceName: "worker-news",
    status: "healthy",
    currentTask: "idle",
  });
}, 15_000);

createPlatformWorker<{ sweepType: "urgent" | "broad" }>(queueNames.news, "worker-news", async (payload) => {
  await processSweep(payload.sweepType);
});

logger.info("News worker started");
