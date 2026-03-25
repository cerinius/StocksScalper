import { getPlatformConfig } from "@stock-radar/config";
import { analyzeMarketCandidate, MassiveMarketDataProvider, MockMarketDataProvider, resolveMassiveSymbol } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformQueues, createPlatformWorker, queueNames } from "@stock-radar/queues";
import { stableHash } from "@stock-radar/shared";
import type { PriceBar, Timeframe } from "@stock-radar/types";
import WebSocket from "ws";

const config = getPlatformConfig();
const logger = createLogger("worker-market");
const provider =
  config.dataProvider === "massive" && config.marketData.massive.apiKey
    ? new MassiveMarketDataProvider({
        apiKey: config.marketData.massive.apiKey,
        restBaseUrl: config.marketData.massive.restBaseUrl,
        watchlistSymbols: config.watchlistSymbols,
      })
    : new MockMarketDataProvider();
const isMassiveProvider = provider instanceof MassiveMarketDataProvider;
const queues = createPlatformQueues();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

const timeframeMs: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

const streamPrices = new Map<string, number>();
const streamTriggers = new Map<string, number>();
const startedRealtimeConnections = new Set<string>();
let scheduledSymbolCursor = 0;

const selectExchange = (symbol: ReturnType<typeof resolveMassiveSymbol>) => {
  if (symbol.assetType === "crypto") return "CRYPTO";
  if (symbol.assetType === "forex") return "OTC";
  if (symbol.dbAssetClass === "ETF") return "NYSE ARCA";
  return "NASDAQ";
};

const mapNewsContext = (symbol: string, linkedNews: Awaited<ReturnType<typeof prisma.newsItem.findMany>>) =>
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
  }));

const upsertTrackedSymbol = async (inputSymbol: string) => {
  const symbol = resolveMassiveSymbol(inputSymbol);
  return prisma.symbol.upsert({
    where: { ticker: symbol.canonicalSymbol },
    update: {
      isActive: true,
      assetClass: symbol.dbAssetClass,
      exchange: selectExchange(symbol),
    },
    create: {
      ticker: symbol.canonicalSymbol,
      name: symbol.canonicalSymbol,
      assetClass: symbol.dbAssetClass,
      exchange: selectExchange(symbol),
    },
  });
};

const syncPriceBars = async (symbolId: string, timeframe: Timeframe, bars: Awaited<ReturnType<typeof provider.getPriceBars>>) => {
  if (bars.length === 0) return;

  const latestExisting = await prisma.priceBar.findFirst({
    where: { symbolId, timeframe },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  const cutoffMs = latestExisting ? latestExisting.timestamp.getTime() - timeframeMs[timeframe] * 2 : null;
  const barsToPersist = cutoffMs
    ? bars.filter((bar) => new Date(bar.timestamp).getTime() >= cutoffMs)
    : bars;

  for (const bar of barsToPersist) {
    await prisma.priceBar.upsert({
      where: {
        symbolId_timeframe_timestamp: {
          symbolId,
          timeframe,
          timestamp: new Date(bar.timestamp),
        },
      },
      update: {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      },
      create: {
        symbolId,
        timeframe,
        timestamp: new Date(bar.timestamp),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      },
    });
  }
};

const resamplePriceBars = (bars: PriceBar[], timeframe: "5m" | "15m" | "4h"): PriceBar[] => {
  const intervalMs = timeframeMs[timeframe];
  const buckets = new Map<number, PriceBar[]>();

  for (const bar of bars) {
    const bucketStart = Math.floor(new Date(bar.timestamp).getTime() / intervalMs) * intervalMs;
    const bucket = buckets.get(bucketStart) ?? [];
    bucket.push(bar);
    buckets.set(bucketStart, bucket);
  }

  return [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([bucketStart, bucketBars]) => {
      const firstBar = bucketBars[0];
      const lastBar = bucketBars[bucketBars.length - 1];

      return {
        symbol: firstBar.symbol,
        timeframe,
        timestamp: new Date(bucketStart).toISOString(),
        open: firstBar.open,
        high: Math.max(...bucketBars.map((bar) => bar.high)),
        low: Math.min(...bucketBars.map((bar) => bar.low)),
        close: lastBar.close,
        volume: bucketBars.reduce((total, bar) => total + bar.volume, 0),
      };
    });
};

const getBarsByTimeframe = async (symbol: string) => {
  if (!isMassiveProvider) {
    const barsByTimeframe: Partial<Record<Timeframe, PriceBar[]>> = {};
    for (const timeframe of config.watchlistTimeframes.slice(0, 5)) {
      barsByTimeframe[timeframe] = await provider.getPriceBars(symbol, timeframe, timeframe === "1d" ? 90 : 80);
    }
    return barsByTimeframe;
  }

  const [minuteBars, hourBars, dayBars] = await Promise.all([
    provider.getPriceBars(symbol, "1m", 1_300),
    provider.getPriceBars(symbol, "1h", 120),
    provider.getPriceBars(symbol, "1d", 120),
  ]);

  return {
    "1m": minuteBars.slice(-80),
    "5m": resamplePriceBars(minuteBars, "5m").slice(-80),
    "15m": resamplePriceBars(minuteBars, "15m").slice(-80),
    "1h": hourBars.slice(-80),
    "4h": resamplePriceBars(hourBars, "4h").slice(-80),
    "1d": dayBars.slice(-90),
  } satisfies Partial<Record<Timeframe, PriceBar[]>>;
};

const queueStreamTriggeredScan = async (symbol: string, reason: string, movePct: number) => {
  const now = Date.now();
  const lastTriggerAt = streamTriggers.get(symbol) ?? 0;
  if (now - lastTriggerAt < config.marketData.massive.streamCooldownMs) return;

  streamTriggers.set(symbol, now);
  await queues.market.add("streamPriceMovement", { symbols: [symbol] });
  logger.info("Queued stream-driven market scan", {
    symbol,
    reason,
    movePct: Number(movePct.toFixed(4)),
  });
};

const extractNumber = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
};

const extractStreamSymbol = (message: Record<string, unknown>) => {
  const rawSymbol = [message.sym, message.symbol, message.pair, message.ticker].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!rawSymbol) return null;
  return rawSymbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
};

const extractStreamPrice = (message: Record<string, unknown>) => {
  const closePrice = extractNumber(message.c, message.price, message.lastPrice, message.lp);
  if (closePrice !== null) return closePrice;

  const tradePrice = typeof message.p === "number" ? message.p : null;
  if (tradePrice !== null) return tradePrice;

  const bid = extractNumber(message.bp, message.bid, message.bidPrice, message.b);
  const ask = extractNumber(message.ap, message.ask, message.askPrice, message.a);
  if (bid !== null && ask !== null) return (bid + ask) / 2;
  return ask ?? bid;
};

const handleStreamMessage = async (assetType: "stocks" | "forex" | "crypto", message: Record<string, unknown>) => {
  if (message.ev === "status") {
    const status = typeof message.status === "string" ? message.status : undefined;
    const statusMessage = typeof message.message === "string" ? message.message : undefined;
    if (status === "auth_failed") {
      logger.warn("Massive websocket access was rejected, continuing with REST-backed market scans", {
        assetType,
        statusMessage,
      });
      await upsertWorkerHeartbeat({
        workerType: "MARKET",
        serviceName: "worker-market",
        status: "degraded",
        currentTask: "rest-scan-only",
        metrics: { websocket: "auth_failed", assetType, statusMessage },
      });
    }
    return;
  }

  const symbol = extractStreamSymbol(message);
  const price = extractStreamPrice(message);
  if (!symbol || price === null) return;

  const previous = streamPrices.get(symbol);
  streamPrices.set(symbol, price);
  if (!previous || previous === 0) return;

  const movePct = Math.abs(((price - previous) / previous) * 100);
  if (movePct < config.marketData.massive.streamMinMovePct) return;

  await queueStreamTriggeredScan(symbol, String(message.ev ?? assetType), movePct);
};

const startRealtimeFeed = (assetType: "stocks" | "forex" | "crypto", url: string, subscriptions: string[]) => {
  if (subscriptions.length === 0 || startedRealtimeConnections.has(assetType)) return;
  startedRealtimeConnections.add(assetType);

  let authFailed = false;
  const websocket = new WebSocket(url);

  websocket.on("open", () => {
    websocket.send(JSON.stringify({ action: "auth", params: config.marketData.massive.apiKey }));
    setTimeout(() => {
      websocket.send(JSON.stringify({ action: "subscribe", params: subscriptions.join(",") }));
    }, 400);
  });

  websocket.on("message", (payload) => {
    try {
      const messages = JSON.parse(String(payload)) as Array<Record<string, unknown>>;
      for (const message of messages) {
        if (message.status === "auth_failed") {
          authFailed = true;
        }
        void handleStreamMessage(assetType, message);
      }
    } catch (error) {
      logger.warn("Unable to parse Massive websocket message", {
        assetType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  websocket.on("error", (error) => {
    logger.warn("Massive websocket connection error", {
      assetType,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  websocket.on("close", () => {
    startedRealtimeConnections.delete(assetType);
    if (authFailed) return;

    setTimeout(() => {
      startRealtimeFeed(assetType, url, subscriptions);
    }, 5_000);
  });
};

const startRealtimeStreams = () => {
  if (!(provider instanceof MassiveMarketDataProvider) || !provider.hasApiKey()) {
    logger.info("Massive websocket stream not started because the worker is not configured with a Massive API key");
    return;
  }

  const subscriptionGroups = {
    stocks: new Set<string>(),
    forex: new Set<string>(),
    crypto: new Set<string>(),
  };

  for (const symbol of config.watchlistSymbols) {
    const descriptor = resolveMassiveSymbol(symbol);
    for (const subscription of descriptor.websocketSubscriptions) {
      subscriptionGroups[descriptor.assetType].add(subscription);
    }
  }

  logger.info("Starting Massive websocket subscriptions", {
    stocks: subscriptionGroups.stocks.size,
    forex: subscriptionGroups.forex.size,
    crypto: subscriptionGroups.crypto.size,
  });

  startRealtimeFeed("stocks", config.marketData.massive.websocketUrls.stocks, [...subscriptionGroups.stocks]);
  startRealtimeFeed("forex", config.marketData.massive.websocketUrls.forex, [...subscriptionGroups.forex]);
  startRealtimeFeed("crypto", config.marketData.massive.websocketUrls.crypto, [...subscriptionGroups.crypto]);
};

const scanWatchlist = async (symbols = config.watchlistSymbols) => {
  const run = await createWorkerRun({
    workerType: "MARKET",
    queueName: queueNames.market,
    jobName: "scanWatchlist",
    payload: { symbols, dataProvider: config.dataProvider },
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: "running",
      currentTask: "scan-watchlist",
      metrics: { dataProvider: config.dataProvider, symbols: symbols.length },
    });

    let createdCount = 0;
    let scannedCount = 0;
    let failedSymbols = 0;

    for (const requestedSymbol of symbols) {
      try {
        const descriptor = resolveMassiveSymbol(requestedSymbol);
        const symbolRecord = await upsertTrackedSymbol(requestedSymbol);
        const linkedNews = await prisma.newsItem.findMany({
          where: {
            symbolLinks: {
              some: { symbolId: symbolRecord.id },
            },
          },
          orderBy: { ingestedAt: "desc" },
          take: 5,
        });
        const relevantNews = mapNewsContext(descriptor.canonicalSymbol, linkedNews);
        const barsByTimeframe = await getBarsByTimeframe(descriptor.canonicalSymbol);

        for (const timeframe of config.watchlistTimeframes.slice(0, 5)) {
          const bars = barsByTimeframe[timeframe] ?? [];
          if (bars.length === 0) continue;

          await syncPriceBars(symbolRecord.id, timeframe, bars);

          const candidate = analyzeMarketCandidate(descriptor.canonicalSymbol, timeframe, bars, relevantNews);
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
              rawSnapshotRef: `${config.dataProvider}:${descriptor.assetType}:${descriptor.canonicalSymbol}:${timeframe}`,
            },
          });

          const dedupeHash = stableHash({
            symbol: descriptor.canonicalSymbol,
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

        scannedCount += 1;
      } catch (error) {
        failedSymbols += 1;
        logger.warn("Failed to scan symbol with market provider", {
          symbol: requestedSymbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await prisma.auditLog.create({
      data: {
        actorType: "WORKER",
        actorId: "worker-market",
        workerType: "MARKET",
        severity: failedSymbols > 0 ? "WARNING" : "INFO",
        category: "worker.market",
        message: `Market scan completed with ${createdCount} new candidates across ${scannedCount} symbols.`,
        entityType: "worker_run",
        entityId: run.id,
        data: { createdCount, scannedCount, failedSymbols, dataProvider: config.dataProvider },
      },
    });

    await completeWorkerRun(run.id, `${createdCount} candidates created`, {
      createdCount,
      scannedCount,
      failedSymbols,
      dataProvider: config.dataProvider,
    });
    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: failedSymbols > 0 ? "degraded" : "healthy",
      currentTask: "idle",
      metrics: { createdCount, scannedCount, failedSymbols, dataProvider: config.dataProvider },
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "MARKET",
      message: err.message,
      stack: err.stack,
      payload: { symbols, dataProvider: config.dataProvider },
    });
    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message, dataProvider: config.dataProvider },
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
    metrics: { dataProvider: config.dataProvider },
  });
}, 15_000);

const getScheduledScanSymbols = () => {
  if (!isMassiveProvider || config.watchlistSymbols.length === 0) {
    return config.watchlistSymbols;
  }

  const symbol = config.watchlistSymbols[scheduledSymbolCursor % config.watchlistSymbols.length];
  scheduledSymbolCursor = (scheduledSymbolCursor + 1) % config.watchlistSymbols.length;
  return symbol ? [symbol] : config.watchlistSymbols;
};

createPlatformWorker<{ symbols?: string[] }>(queueNames.market, "worker-market", async (payload) => {
  await scanWatchlist(payload.symbols?.length ? payload.symbols : getScheduledScanSymbols());
});

logger.info("Market worker started", { dataProvider: config.dataProvider });
startRealtimeStreams();
