import { getPlatformConfig } from "@stock-radar/config";
import { analyzeMarketCandidate, makeExecutionDecision, scoreNewsIntelligence, validateCandidate } from "@stock-radar/core";
import type { AccountStateSnapshot, ExecutionPositionSnapshot } from "@stock-radar/types";
import { createMockBars, DEFAULT_SYMBOLS, stableHash } from "@stock-radar/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "./index";

const asJson = <T>(value: T) => value as Prisma.InputJsonValue;
const asNullableJson = <T>(value: T | null) => (value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue));

const asDbWorker = (worker: "news" | "market" | "validation" | "execution" | "supervisor") =>
  ({
    news: "NEWS",
    market: "MARKET",
    validation: "VALIDATION",
    execution: "EXECUTION",
    supervisor: "SUPERVISOR",
  })[worker] as "NEWS" | "MARKET" | "VALIDATION" | "EXECUTION" | "SUPERVISOR";

const asSeverity = (severity: "info" | "warning" | "critical") =>
  ({ info: "INFO", warning: "WARNING", critical: "CRITICAL" })[severity] as "INFO" | "WARNING" | "CRITICAL";

const createAccountSnapshot = (mode: "PAPER" | "LIVE"): AccountStateSnapshot => ({
  balance: 125_000,
  equity: 126_450,
  freeMargin: 101_200,
  usedMargin: 24_800,
  openPnl: 1_450,
  realizedPnlDaily: 850,
  drawdownPct: 0.9,
  maxDrawdownPct: 3.4,
  riskState: "NORMAL",
  killSwitchActive: false,
  mode: mode === "PAPER" ? "paper" : "live",
});

async function main() {
  const config = getPlatformConfig();

  const adminRole = await prisma.role.upsert({
    where: { key: "ADMIN" },
    update: { label: "Administrator" },
    create: {
      key: "ADMIN",
      label: "Administrator",
      description: "Full platform control",
    },
  });

  const operatorRole = await prisma.role.upsert({
    where: { key: "OPERATOR" },
    update: { label: "Operator" },
    create: {
      key: "OPERATOR",
      label: "Operator",
      description: "Operational oversight access",
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: config.localAdmin.email },
    update: { name: config.localAdmin.name, isActive: true },
    create: {
      email: config.localAdmin.email,
      name: config.localAdmin.name,
      roles: {
        create: [{ roleId: adminRole.id }, { roleId: operatorRole.id }],
      },
    },
  });

  const mt5Integration = await prisma.integration.upsert({
    where: { id: "seed-mt5" },
    update: {
      kind: "MT5",
      name: "Local MT5 Paper Adapter",
      mode: "PAPER",
      enabled: true,
      configJson: { host: config.services.mt5AdapterUrl, mode: "paper" },
    },
    create: {
      id: "seed-mt5",
      kind: "MT5",
      name: "Local MT5 Paper Adapter",
      mode: "PAPER",
      enabled: true,
      configJson: { host: config.services.mt5AdapterUrl, mode: "paper" },
    },
  });

  const discordIntegration = await prisma.integration.upsert({
    where: { id: "seed-discord" },
    update: {
      kind: "DISCORD",
      name: "Discord Alerts",
      enabled: Boolean(config.discordWebhookUrl),
      configJson: { configured: Boolean(config.discordWebhookUrl) },
    },
    create: {
      id: "seed-discord",
      kind: "DISCORD",
      name: "Discord Alerts",
      enabled: Boolean(config.discordWebhookUrl),
      configJson: { configured: Boolean(config.discordWebhookUrl) },
    },
  });

  await prisma.integrationStatus.upsert({
    where: { id: "seed-mt5-status" },
    update: {
      integrationId: mt5Integration.id,
      status: "CONNECTED",
      summary: "Paper adapter ready",
      lastHeartbeatAt: new Date(),
      lastSyncAt: new Date(),
    },
    create: {
      id: "seed-mt5-status",
      integrationId: mt5Integration.id,
      status: "CONNECTED",
      summary: "Paper adapter ready",
      lastHeartbeatAt: new Date(),
      lastSyncAt: new Date(),
    },
  });

  await prisma.integrationStatus.upsert({
    where: { id: "seed-discord-status" },
    update: {
      integrationId: discordIntegration.id,
      status: config.discordWebhookUrl ? "CONNECTED" : "PENDING",
      summary: config.discordWebhookUrl ? "Webhook configured" : "Waiting for webhook URL",
      lastHeartbeatAt: new Date(),
    },
    create: {
      id: "seed-discord-status",
      integrationId: discordIntegration.id,
      status: config.discordWebhookUrl ? "CONNECTED" : "PENDING",
      summary: config.discordWebhookUrl ? "Webhook configured" : "Waiting for webhook URL",
      lastHeartbeatAt: new Date(),
    },
  });

  const watchlist = await prisma.watchlist.upsert({
    where: { id: "seed-watchlist-core" },
    update: { name: "Core Focus", tier: "core", scanIntervalMs: config.schedules.marketScanMs },
    create: {
      id: "seed-watchlist-core",
      name: "Core Focus",
      description: "Primary local-dev symbols and macro proxies",
      tier: "core",
      scanIntervalMs: config.schedules.marketScanMs,
    },
  });

  const symbols = [];

  for (const symbol of DEFAULT_SYMBOLS) {
    const assetClass = symbol.endsWith("USD") ? "FX" : symbol === "XAUUSD" ? "COMMODITY" : ["SPY", "QQQ"].includes(symbol) ? "ETF" : "EQUITY";
    const created = await prisma.symbol.upsert({
      where: { ticker: symbol },
      update: { isActive: true, assetClass },
      create: {
        ticker: symbol,
        name: symbol,
        assetClass,
        sector: assetClass === "EQUITY" ? "Technology" : assetClass,
        exchange: assetClass === "FX" ? "OTC" : "NASDAQ",
        correlationGroup: assetClass === "ETF" ? "index" : assetClass === "COMMODITY" ? "commodity" : "growth",
      },
    });
    symbols.push(created);

    await prisma.watchlistItem.upsert({
      where: {
        watchlistId_symbolId: {
          watchlistId: watchlist.id,
          symbolId: created.id,
        },
      },
      update: { priority: 80 },
      create: {
        watchlistId: watchlist.id,
        symbolId: created.id,
        priority: 80,
      },
    });

    for (const timeframe of ["1m", "5m", "15m", "1h", "1d"] as const) {
      const bars = createMockBars(symbol, timeframe, timeframe === "1d" ? 90 : 120, symbol.length);

      for (const bar of bars.slice(-60)) {
        await prisma.priceBar.upsert({
          where: {
            symbolId_timeframe_timestamp: {
              symbolId: created.id,
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
            symbolId: created.id,
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

      const latestBars = bars.slice(-80);
      const newsRecord = scoreNewsIntelligence({
        source: "SeedWire",
        headline: `${symbol} shows relative strength into macro-heavy session`,
        summary: `${symbol} is reacting to earnings, flows, and rate sensitivity. The tape is watching CPI, yields, and sector rotation.`,
        originalTimestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        affectedSymbols: [symbol],
        affectedAssetClasses: [assetClass],
        tags: ["seed", "macro", "flow"],
        category: "market-moving",
      });

      const existingNews = await prisma.newsItem.findUnique({ where: { dedupeHash: newsRecord.dedupeHash } });
      const newsId =
        existingNews?.id ??
        (
          await prisma.newsItem.create({
            data: {
              source: newsRecord.source,
              headline: newsRecord.headline,
              summary: newsRecord.summary,
              originalTimestamp: new Date(newsRecord.originalTimestamp),
              ingestedAt: new Date(newsRecord.ingestionTimestamp),
              directionalBias: newsRecord.directionalBias,
              urgency: newsRecord.urgency,
              relevanceScore: newsRecord.relevanceScore,
              volatilityImpact: newsRecord.volatilityImpact,
              confidence: newsRecord.confidence,
              tags: newsRecord.tags,
              category: newsRecord.category,
              affectedAssetClass: newsRecord.affectedAssetClasses,
              rawPayloadRef: newsRecord.rawPayloadRef,
              reasoningLog: asJson(newsRecord.reasoningLog),
              dedupeHash: newsRecord.dedupeHash,
              status: newsRecord.status,
              metadata: {},
            },
          })
        ).id;

      await prisma.symbolNewsLink.upsert({
        where: {
          newsItemId_symbolId: {
            newsItemId: newsId,
            symbolId: created.id,
          },
        },
        update: { relevanceScore: newsRecord.relevanceScore },
        create: {
          newsItemId: newsId,
          symbolId: created.id,
          relevanceScore: newsRecord.relevanceScore,
          reasoning: "Seeded symbol-level market-moving context",
        },
      });

      const candidate = analyzeMarketCandidate(symbol, timeframe, latestBars, [newsRecord]);
      if (!candidate) continue;

      const snapshot = await prisma.marketSnapshot.create({
        data: {
          symbolId: created.id,
          timeframe,
          snapshotAt: new Date(candidate.detectedAt),
          currentPrice: candidate.currentPrice,
          ohlcv: asJson(latestBars.slice(-10)),
          indicatorSnapshot: asJson(candidate.indicatorSnapshot),
          supportLevels: asJson([candidate.stopLoss]),
          resistanceLevels: asJson([candidate.takeProfit]),
          trendBias: candidate.direction,
          volatilityRegime: candidate.volatilityClassification,
          sessionName: timeframe === "1d" ? "swing" : "intraday",
          reasoningLog: asJson(candidate.reasoningLog),
          rawSnapshotRef: `seed:${symbol}:${timeframe}`,
        },
      });

      const candidateRecord = await prisma.tradeCandidate.create({
        data: {
          symbolId: created.id,
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
          status: "VALIDATED",
          correlationTags: asJson(candidate.correlationTags),
          volatilityClassification: candidate.volatilityClassification,
          newsContext: asJson([newsRecord]),
          dedupeHash: stableHash({ symbol, timeframe, strategy: candidate.strategyType }),
        },
      });

      const analogs = [0.9, 1.3, -0.8, 0.6, 1.8, -0.5, 0.4, 1.2].map((value, index) => ({
        similarity: 0.9 - index * 0.05,
        outcomeR: value,
        returnPct: value * 1.6,
        holdBars: 4 + index,
      }));
      const validationBundle = validateCandidate(candidate, analogs);

      const validationRun = await prisma.validationRun.create({
        data: {
          candidateId: candidateRecord.id,
          status: validationBundle.finalScore >= 60 ? "PASSED" : "FAILED",
          finalValidationScore: validationBundle.finalScore,
          winRateEstimate: validationBundle.metrics.winRateEstimate,
          averageReturn: validationBundle.metrics.averageReturn,
          averageAdverseExcursion: validationBundle.metrics.averageAdverseExcursion,
          averageFavorableExcursion: validationBundle.metrics.averageFavorableExcursion,
          maxDrawdown: validationBundle.metrics.maxDrawdown,
          profitFactor: validationBundle.metrics.profitFactor,
          expectancy: validationBundle.metrics.expectancy,
          confidenceScore: validationBundle.metrics.confidenceScore,
          confidenceIntervalLow: validationBundle.metrics.confidenceIntervalLow,
          confidenceIntervalHigh: validationBundle.metrics.confidenceIntervalHigh,
          sampleSize: validationBundle.metrics.historicalSampleSize,
          dataQualityNotes: asJson(validationBundle.metrics.dataQualityNotes),
          reasonsFor: asJson(validationBundle.reasonsFor),
          reasonsAgainst: asJson(validationBundle.reasonsAgainst),
          invalidationConditions: asJson([{ type: "price", level: candidate.stopLoss }]),
          backtestMetadata: asJson({ mode: "seeded-rule-based", timeframe }),
          completedAt: new Date(),
        },
      });

      for (const [index, analog] of validationBundle.analogs.entries()) {
        await prisma.backtestResult.create({
          data: {
            validationRunId: validationRun.id,
            scenarioLabel: `Analog ${index + 1}`,
            similarityScore: analog.similarity,
            outcomeR: analog.outcomeR,
            returnPct: analog.returnPct,
            maxAdverseExcursion: Math.min(0, analog.outcomeR) * -1,
            maxFavorableExcursion: Math.max(0, analog.outcomeR),
            holdBars: analog.holdBars,
            occurredAt: new Date(Date.now() - index * 86_400_000),
            context: asJson({ seed: true, symbol, timeframe }),
          },
        });
      }

      const account = createAccountSnapshot("PAPER");
      const openPositions: ExecutionPositionSnapshot[] = [];
      const decision = makeExecutionDecision({
        candidate,
        validation: validationBundle.metrics,
        account,
        openPositions,
        riskLimits: {
          maxActiveTrades: config.risk.maxActiveTrades,
          maxDailyLossPct: config.risk.maxDailyLossPct,
          maxRiskPerTradePct: config.risk.maxRiskPerTradePct,
          maxTotalExposurePct: config.risk.maxTotalExposurePct,
          maxSymbolExposurePct: config.risk.maxSymbolExposurePct,
          maxCorrelatedExposurePct: config.risk.maxCorrelatedExposurePct,
          maxEntrySpreadPct: config.risk.maxEntrySpreadPct,
          staleSignalSeconds: config.risk.staleSignalSeconds,
          manualApprovalMode: config.trading.manualApprovalMode,
        },
        references: [
          { type: "candidate", id: candidateRecord.id, label: `${symbol} candidate` },
          { type: "validation", id: validationRun.id, label: `${symbol} validation` },
        ],
      });

      const executionDecision = await prisma.executionDecision.create({
        data: {
          candidateId: candidateRecord.id,
          validationRunId: validationRun.id,
          action: decision.action,
          confidence: decision.confidence,
          riskScore: decision.riskScore,
          evidenceSummary: decision.evidenceSummary,
          reasons: asJson(decision.reasons),
          blockingReasons: asJson(decision.blockingReasons),
          supportingReferences: asJson(decision.supportingReferences),
          executionParameters: asNullableJson(decision.executionParameters),
          status: decision.action === "PLACE" ? "SIMULATED" : "PROPOSED",
          mode: "PAPER",
          idempotencyKey: stableHash({ candidateId: candidateRecord.id, action: decision.action }),
          executedAt: decision.action === "PLACE" ? new Date() : null,
        },
      });

      if (decision.executionParameters) {
        await prisma.order.create({
          data: {
            symbolId: created.id,
            integrationId: mt5Integration.id,
            decisionId: executionDecision.id,
            broker: "mt5-paper",
            brokerOrderId: `paper-${candidateRecord.id.slice(0, 8)}`,
            mode: "PAPER",
            direction: decision.executionParameters.direction,
            orderType: "MARKET",
            quantity: decision.executionParameters.quantity,
            entryPrice: decision.executionParameters.entry,
            stopLoss: decision.executionParameters.stopLoss,
            takeProfit: decision.executionParameters.takeProfit,
            status: "FILLED",
            submittedAt: new Date(),
            filledAt: new Date(),
            payload: asJson(decision.executionParameters),
          },
        });
      }
    }
  }

  const seededAccount = createAccountSnapshot("PAPER");
  await prisma.accountSnapshot.create({
    data: {
      integrationId: mt5Integration.id,
      capturedAt: new Date(),
      balance: seededAccount.balance,
      equity: seededAccount.equity,
      freeMargin: seededAccount.freeMargin,
      usedMargin: seededAccount.usedMargin,
      marginLevel: Number(((seededAccount.equity / Math.max(seededAccount.usedMargin, 1)) * 100).toFixed(2)),
      openPnl: seededAccount.openPnl,
      realizedPnlDaily: seededAccount.realizedPnlDaily,
      drawdownPct: seededAccount.drawdownPct,
      maxDrawdownPct: seededAccount.maxDrawdownPct,
      riskState: "NORMAL",
      killSwitchActive: false,
      mode: "PAPER",
    },
  });

  for (const worker of ["news", "market", "validation", "execution", "supervisor"] as const) {
    await prisma.workerHeartbeat.upsert({
      where: { workerType: asDbWorker(worker) },
      update: {
        serviceName: `worker-${worker}`,
        status: "healthy",
        currentTask: worker === "supervisor" ? "monitoring" : "idle",
        lagMs: worker === "execution" ? 120 : 45,
        metrics: asJson({ seeded: true }),
        lastSeenAt: new Date(),
      },
      create: {
        workerType: asDbWorker(worker),
        serviceName: `worker-${worker}`,
        status: "healthy",
        currentTask: worker === "supervisor" ? "monitoring" : "idle",
        lagMs: worker === "execution" ? 120 : 45,
        metrics: { seeded: true },
        lastSeenAt: new Date(),
      },
    });
  }

  const template = await prisma.notificationTemplate.upsert({
    where: { key: "daily-summary" },
    update: {
      titleTemplate: "Daily Summary",
      bodyTemplate: "Starting balance {{startingBalance}}, ending balance {{endingBalance}}.",
      enabled: true,
    },
    create: {
      key: "daily-summary",
      channel: "DISCORD",
      severity: "INFO",
      titleTemplate: "Daily Summary",
      bodyTemplate: "Starting balance {{startingBalance}}, ending balance {{endingBalance}}.",
      enabled: true,
    },
  });

  const notification = await prisma.notification.create({
    data: {
      templateId: template.id,
      category: "daily_summary",
      severity: "INFO",
      channel: "DISCORD",
      status: "PENDING",
      dedupeKey: stableHash({ kind: "daily_summary", date: new Date().toISOString().slice(0, 10) }),
      title: "Daily platform summary seeded",
      body: "Paper trading summary is ready for review.",
      payload: asJson({ account: seededAccount }),
    },
  });

  await prisma.supervisorEvent.create({
    data: {
      severity: "INFO",
      eventType: "seed_complete",
      summary: "Seed data loaded for local development.",
      details: { userId: adminUser.id, symbols: symbols.length },
      notificationId: notification.id,
    },
  });

  await prisma.auditLog.createMany({
    data: [
      {
        actorType: "SYSTEM",
        actorId: adminUser.id,
        severity: "INFO",
        category: "seed",
        message: "Seed completed successfully.",
        entityType: "system",
        entityId: "seed",
        data: { symbols: symbols.length },
      },
      {
        actorType: "WORKER",
        actorId: "worker-supervisor",
        workerType: "SUPERVISOR",
        severity: "INFO",
        category: "heartbeat",
        message: "Supervisor baseline heartbeat recorded.",
        entityType: "worker",
        entityId: "worker-supervisor",
      },
    ],
  });

  await prisma.systemSetting.upsert({
    where: { key: "trading.mode" },
    update: { value: { mode: config.trading.mode }, valueType: "json" },
    create: {
      key: "trading.mode",
      value: { mode: config.trading.mode },
      valueType: "json",
      description: "Global trading mode",
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
