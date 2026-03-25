import { getPlatformConfig } from "@stock-radar/config";
import { analyzeMarketCandidate, MassiveMarketDataProvider, MockMarketDataProvider, resolveMassiveSymbol } from "@stock-radar/core";
import { AssetClass, Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformQueues, createPlatformWorker, queueNames } from "@stock-radar/queues";
import { stableHash } from "@stock-radar/shared";
import type { NewsIntelligenceRecord, PriceBar, Timeframe } from "@stock-radar/types";
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

// Real-time price tracking for Massive WebSocket streams
const streamPrices = new Map<string, number>();
const streamTriggers = new Map<string, number>();
const startedRealtimeConnections = new Set<string>();

const toPrismaAssetClass = (value: string): AssetClass => {
  switch (value) {
    case "EQUITY":
      return AssetClass.EQUITY;
    case "ETF":
      return AssetClass.ETF;
    case "FX":
      return AssetClass.FX;
    case "COMMODITY":
      return AssetClass.COMMODITY;
    case "INDEX":
      return AssetClass.INDEX;
    case "CRYPTO":
      return AssetClass.CRYPTO;
    default:
      return AssetClass.EQUITY;
  }
};

const selectExchange = (symbol: ReturnType<typeof resolveMassiveSymbol>) => {
  if (symbol.assetType === "crypto") return "CRYPTO";
  if (symbol.assetType === "forex") return "OTC";
  if (symbol.dbAssetClass === "ETF") return "NYSE ARCA";
  return "NASDAQ";
};

const mapNewsContext = (
  ticker: string,
  linkedNews: Awaited<ReturnType<typeof prisma.newsItem.findMany>>,
): NewsIntelligenceRecord[] =>
  linkedNews.map((item) => ({
    source: item.source,
    headline: item.headline,
    summary: item.summary,
    originalTimestamp: item.originalTimestamp.toISOString(),
    ingestionTimestamp: item.ingestedAt.toISOString(),
    affectedSymbols: [ticker],
    affectedAssetClasses: Array.isArray(item.affectedAssetClass) ? (item.affectedAssetClass as string[]) : [],
    directionalBias: item.directionalBias as NewsIntelligenceRecord["directionalBias"],
    urgency: item.urgency as NewsIntelligenceRecord["urgency"],
    relevanceScore: item.relevanceScore,
    volatilityImpact: item.volatilityImpact as NewsIntelligenceRecord["volatilityImpact"],
    confidence: item.confidence,
    tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
    category: item.category,
    rawPayloadRef: item.rawPayloadRef,
    reasoningLog: Array.isArray(item.reasoningLog) ? (item.reasoningLog as unknown as NewsIntelligenceRecord["reasoningLog"]) : [],
    dedupeHash: item.dedupeHash,
    status: item.status,
  }));

const upsertTrackedSymbol = async (inputSymbol: string) => {
  const symbol = resolveMassiveSymbol(inputSymbol);
  const prismaAssetClass = toPrismaAssetClass(symbol.dbAssetClass);

  return prisma.symbol.upsert({
    where: { ticker: symbol.canonicalSymbol },
    update: {
      isActive: true,
      assetClass: prismaAssetClass,
      exchange: selectExchange(symbol),
    },
    create: {
      ticker: symbol.canonicalSymbol,
      name: symbol.canonicalSymbol,
      assetClass: prismaAssetClass,
      exchange: selectExchange(symbol),
    },
  });
};

const persistPriceBars = async (symbolId: string, timeframe: Timeframe, bars: PriceBar[]) => {
  for (const bar of bars.slice(-60)) {
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

const scanSymbolTimeframe = async (
  inputSymbol: string,
  timeframe: Timeframe,
  dbSymbolId: string,
  ticker: string,
): Promise<boolean> => {
  let bars: PriceBar[];
  try {
    bars = await provider.getPriceBars(ticker, timeframe, 120);
  } catch (error) {
    logger.warn("Failed to fetch price bars", { symbol: ticker, timeframe, error: (error as Error).message });
    return false;
  }

  if (bars.length < 40) return false;

  // Persist bars to DB for downstream use
  await persistPriceBars(dbSymbolId, timeframe, bars);

  // Fetch recent news linked to this symbol from DB (live data, not mock)
  const linkedNews = await prisma.newsItem.findMany({
    where: {
      symbolLinks: { some: { symbolId: dbSymbolId } },
      originalTimestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    orderBy: { originalTimestamp: "desc" },
    take: 5,
  });
  const newsContext = mapNewsContext(ticker, linkedNews);

  const candidate = analyzeMarketCandidate(ticker, timeframe, bars, newsContext);
  if (!candidate) return false;

  // Deduplicate by symbol + timeframe + strategy + hour bucket
  const dedupeHash = stableHash({
    symbol: ticker,
    timeframe,
    strategy: candidate.strategyType,
    hour: new Date().toISOString().slice(0, 13),
  });

  const existing = await prisma.tradeCandidate.findFirst({ where: { dedupeHash } });
  if (existing) return false;

  const latestBar = bars.at(-1)!;
  const snapshot = await prisma.marketSnapshot.create({
    data: {
      symbolId: dbSymbolId,
      timeframe,
      snapshotAt: new Date(),
      currentPrice: latestBar.close,
      ohlcv: asJson(bars.slice(-10)),
      indicatorSnapshot: asJson(candidate.indicatorSnapshot),
      supportLevels: asJson([candidate.stopLoss]),
      resistanceLevels: asJson([candidate.takeProfit]),
      trendBias: candidate.direction,
      volatilityRegime: candidate.volatilityClassification,
      sessionName: timeframe === "1d" ? "swing" : "intraday",
      reasoningLog: asJson(candidate.reasoningLog),
      rawSnapshotRef: `market:${ticker}:${timeframe}`,
    },
  });

  const candidateRecord = await prisma.tradeCandidate.create({
    data: {
      symbolId: dbSymbolId,
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
      marketSnapshotId: snapshot.id,
      reasoningLog: asJson(candidate.reasoningLog),
      status: "NEW",
      correlationTags: asJson(candidate.correlationTags),
      volatilityClassification: candidate.volatilityClassification,
      newsContext: asJson(newsContext),
      dedupeHash,
    },
  });

  logger.info("Trade candidate created", {
    symbol: ticker,
    timeframe,
    strategy: candidate.strategyType,
    direction: candidate.direction,
    setupScore: candidate.setupScore.toFixed(1),
    candidateId: candidateRecord.id,
  });

  await queues.validation.add(
    "candidateFromMarket",
    { candidateId: candidateRecord.id, trigger: "candidate_created" },
    { jobId: `validate-${candidateRecord.id}` },
  );

  return true;
};

const scanSymbol = async (inputSymbol: string): Promise<{ candidatesFound: number; timeframesScanned: number }> => {
  const symbolDescriptor = resolveMassiveSymbol(inputSymbol);
  const dbSymbol = await upsertTrackedSymbol(inputSymbol);

  let candidatesFound = 0;
  let timeframesScanned = 0;

  for (const timeframe of config.watchlistTimeframes) {
    try {
      timeframesScanned += 1;
      const found = await scanSymbolTimeframe(inputSymbol, timeframe, dbSymbol.id, symbolDescriptor.canonicalSymbol);
      if (found) candidatesFound += 1;
    } catch (error) {
      logger.error("Error scanning symbol timeframe", {
        symbol: symbolDescriptor.canonicalSymbol,
        timeframe,
        error: (error as Error).message,
      });
    }
  }

  return { candidatesFound, timeframesScanned };
};

const processMarketScan = async (symbols?: string[]) => {
  const symbolsToScan = symbols?.length ? symbols : config.watchlistSymbols;
  const run = await createWorkerRun({
    workerType: "MARKET",
    queueName: queueNames.market,
    jobName: symbols?.length ? "targetedScan" : "scanWatchlist",
    payload: symbols?.length ? { symbols } : undefined,
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: "running",
      currentTask: "scanning",
    });

    let totalCandidates = 0;
    let totalTimeframes = 0;

    for (const symbol of symbolsToScan) {
      const result = await scanSymbol(symbol);
      totalCandidates += result.candidatesFound;
      totalTimeframes += result.timeframesScanned;
    }

    await completeWorkerRun(run.id, `${totalCandidates} candidates across ${symbolsToScan.length} symbols`, {
      symbolsScanned: symbolsToScan.length,
      timeframesScanned: totalTimeframes,
      candidatesFound: totalCandidates,
      provider: config.dataProvider,
    });

    await upsertWorkerHeartbeat({
      workerType: "MARKET",
      serviceName: "worker-market",
      status: "healthy",
      currentTask: "idle",
      metrics: {
        symbolsScanned: symbolsToScan.length,
        candidatesFound: totalCandidates,
        provider: config.dataProvider,
      },
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "MARKET",
      message: err.message,
      stack: err.stack,
      payload: symbols?.length ? { symbols } : undefined,
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

// ─── Massive WebSocket real-time streaming (optional, Massive provider only) ─────────────────────

const startMassiveStream = (
  wsUrl: string,
  subscriptions: string[],
  ticker: string,
  minMovePct: number,
  cooldownMs: number,
) => {
  if (startedRealtimeConnections.has(ticker)) return;
  startedRealtimeConnections.add(ticker);

  const connect = () => {
    const ws = new WebSocket(`${wsUrl}?apiKey=${encodeURIComponent(config.marketData.massive.apiKey)}`);

    ws.on("open", () => {
      logger.info("Massive WebSocket connected", { ticker, subscriptions });
      ws.send(JSON.stringify({ action: "subscribe", params: subscriptions.join(",") }));
    });

    ws.on("message", (raw) => {
      try {
        const messages = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Array<{ ev?: string; p?: number; c?: number; x?: number }>;
        for (const msg of messages) {
          const price = msg.p ?? msg.c ?? msg.x;
          if (!price || !Number.isFinite(price)) continue;

          const prev = streamPrices.get(ticker);
          streamPrices.set(ticker, price);

          if (!prev) continue;

          const movePct = Math.abs((price - prev) / prev) * 100;
          if (movePct < minMovePct) continue;

          const lastTrigger = streamTriggers.get(ticker) ?? 0;
          if (Date.now() - lastTrigger < cooldownMs) continue;
          streamTriggers.set(ticker, Date.now());

          logger.info("Real-time price trigger", { ticker, price, movePct: movePct.toFixed(3) });
          queues.market
            .add("realtimeTrigger", { symbols: [ticker] }, { jobId: `rt-${ticker}-${Date.now()}` })
            .catch((error) => logger.error("Failed to queue real-time trigger", { error: (error as Error).message }));
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on("error", (error) => {
      logger.warn("Massive WebSocket error", { ticker, error: error.message });
    });

    ws.on("close", () => {
      logger.warn("Massive WebSocket closed, reconnecting in 5s", { ticker });
      setTimeout(connect, 5_000);
    });
  };

  connect();
};

const startRealtimeStreams = () => {
  if (!isMassiveProvider) return;

  const { websocketUrls, streamMinMovePct, streamCooldownMs } = config.marketData.massive;

  for (const inputSymbol of config.watchlistSymbols) {
    try {
      const descriptor = resolveMassiveSymbol(inputSymbol);
      const wsUrl =
        descriptor.assetType === "stocks"
          ? websocketUrls.stocks
          : descriptor.assetType === "forex"
            ? websocketUrls.forex
            : websocketUrls.crypto;

      startMassiveStream(wsUrl, descriptor.websocketSubscriptions, descriptor.canonicalSymbol, streamMinMovePct, streamCooldownMs);
    } catch (error) {
      logger.warn("Failed to start realtime stream for symbol", {
        symbol: inputSymbol,
        error: (error as Error).message,
      });
    }
  }
};

// ─── Bootstrap ──────────────────────────────────────────────────────────────────────────────────

setInterval(() => {
  void upsertWorkerHeartbeat({
    workerType: "MARKET",
    serviceName: "worker-market",
    status: "healthy",
    currentTask: "idle",
    metrics: { streamedSymbols: startedRealtimeConnections.size },
  });
}, 15_000);

createPlatformWorker<{ symbols?: string[] }>(
  queueNames.market,
  "worker-market",
  async (payload) => {
    await processMarketScan(payload.symbols);
  },
);

startRealtimeStreams();

void upsertWorkerHeartbeat({
  workerType: "MARKET",
  serviceName: "worker-market",
  status: "healthy",
  currentTask: "idle",
  metrics: { provider: config.dataProvider, symbols: config.watchlistSymbols.length },
});

logger.info("Market worker started", {
  provider: config.dataProvider,
  symbols: config.watchlistSymbols.length,
  timeframes: config.watchlistTimeframes.length,
  realtimeStreaming: isMassiveProvider,
});
