import { getPlatformConfig } from "@stock-radar/config";
import { analyzeMarketCandidate, MockMarketDataProvider } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat, completeWorkerRun } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformQueues, createPlatformWorker, queueNames } from "@stock-radar/queues";
import { stableHash } from "@stock-radar/shared";

const config = getPlatformConfig();
const logger = createLogger("worker-market");
const provider = new MockMarketDataProvider();
const queues = createPlatformQueues();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

const scanWatchlist = async (symbols = config.watchlistSymbols) => {
  const run = await createWorkerRun({
    workerType: "MARKET",
    queueName: queueNames.market,
    jobName: "scanWatchlist",
    payload: { symbols },
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: "running",
      currentTask: "scan-watchlist",
    });

    let createdCount = 0;
    for (const symbol of symbols) {
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

      const linkedNews = await prisma.newsItem.findMany({
        where: {
          symbolLinks: {
            some: { symbolId: symbolRecord.id },
          },
        },
        orderBy: { ingestedAt: "desc" },
        take: 5,
      });

      for (const timeframe of config.watchlistTimeframes.slice(0, 4)) {
        const bars = await provider.getPriceBars(symbol, timeframe, timeframe === "1d" ? 90 : 80);
        const candidate = analyzeMarketCandidate(
          symbol,
          timeframe,
          bars,
          linkedNews.map((item) => ({
            source: item.source,
            headline: item.headline,
            summary: item.summary,
            originalTimestamp: item.originalTimestamp.toISOString(),
            ingestionTimestamp: item.ingestedAt.toISOString(),
            affectedSymbols: [symbol],
            affectedAssetClasses: Array.isArray(item.affectedAssetClass) ? (item.affectedAssetClass as string[]) : [],
            directionalBias: item.directionalBias,
            urgency: item.urgency,
            relevanceScore: item.relevanceScore,
            volatilityImpact: item.volatilityImpact,
            confidence: item.confidence,
            tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
            category: item.category,
            rawPayloadRef: item.rawPayloadRef,
            reasoningLog: Array.isArray(item.reasoningLog) ? (item.reasoningLog as never[]) : [],
            dedupeHash: item.dedupeHash,
            status: item.status,
          })),
        );
        if (!candidate) continue;

        const marketSnapshot = await prisma.marketSnapshot.create({
          data: {
            symbolId: symbolRecord.id,
            timeframe,
            snapshotAt: new Date(candidate.detectedAt),
            currentPrice: candidate.currentPrice,
            ohlcv: asJson(bars.slice(-10)),
            indicatorSnapshot: asJson(candidate.indicatorSnapshot),
            supportLevels: asJson([candidate.stopLoss]),
            resistanceLevels: asJson([candidate.takeProfit]),
            trendBias: candidate.direction,
            volatilityRegime: candidate.volatilityClassification,
            sessionName: timeframe === "1d" ? "swing" : "intraday",
            reasoningLog: asJson(candidate.reasoningLog),
            rawSnapshotRef: `market-worker:${symbol}:${timeframe}`,
          },
        });

        const dedupeHash = stableHash({
          symbol,
          timeframe,
          strategyType: candidate.strategyType,
          bucket: new Date().toISOString().slice(0, 13),
        });

        const existing = await prisma.tradeCandidate.findFirst({ where: { dedupeHash } });
        if (existing) continue;

        const createdCandidate = await prisma.tradeCandidate.create({
          data: {
            symbolId: symbolRecord.id,
            sourceWorkerType: "MARKET",
            timeframe: candidate.timeframe,
            direction: candidate.direction,
            strategyType: candidate.strategyType,
            detectedAt: new Date(candidate.detectedAt),
            currentPrice: candidate.currentPrice,
            proposedEntry: candidate.proposedEntry,
            stopLoss: candidate.stopLoss,
            takeProfit: candidate.takeProfit,
            riskReward: candidate.riskReward,
            confidenceScore: candidate.confidenceScore,
            setupScore: candidate.setupScore,
            featureValues: asJson(candidate.featureValues),
            indicatorSnapshot: asJson(candidate.indicatorSnapshot),
            marketSnapshotId: marketSnapshot.id,
            reasoningLog: asJson(candidate.reasoningLog),
            status: "NEW",
            correlationTags: asJson(candidate.correlationTags),
            volatilityClassification: candidate.volatilityClassification,
            newsContext: asJson(linkedNews.map((item) => item.headline)),
            dedupeHash,
          },
        });
        createdCount += 1;

        await queues.validation.add("candidateCreated", {
          candidateId: createdCandidate.id,
          trigger: "candidate_created",
        });
      }
    }

    await prisma.auditLog.create({
      data: {
        actorType: "WORKER",
        actorId: "worker-market",
        workerType: "MARKET",
        severity: "INFO",
        category: "worker.market",
        message: `Market scan completed with ${createdCount} new candidates.`,
        entityType: "worker_run",
        entityId: run.id,
        data: { createdCount },
      },
    });

    await completeWorkerRun(run.id, `${createdCount} candidates created`, { createdCount });
    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: "healthy",
      currentTask: "idle",
      metrics: { createdCount },
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "MARKET",
      message: err.message,
      stack: err.stack,
      payload: { symbols },
    });
    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message },
    });
    throw error;
  }
};

setInterval(() => {
  void upsertWorkerHeartbeat({
    workerType: "MARKET",
    serviceName: "worker-market",
    status: "healthy",
    currentTask: "idle",
  });
}, 15_000);

createPlatformWorker<{ symbols?: string[] }>(queueNames.market, "worker-market", async (payload) => {
  await scanWatchlist(payload.symbols ?? config.watchlistSymbols);
});

logger.info("Market worker started");
