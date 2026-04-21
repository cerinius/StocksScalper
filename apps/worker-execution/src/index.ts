import { getPlatformConfig } from "@stock-radar/config";
import { calculatePearsonCorrelation, makeExecutionDecision, computeStreakRiskScale } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformWorker, queueNames, queueNotification } from "@stock-radar/queues";
import { stableHash, DECISION_CODES, buildDecisionRecord } from "@stock-radar/shared";

const config = getPlatformConfig();
const logger = createLogger("worker-execution");
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;
const asNullableJson = <T>(value: T | null) => (value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue));
const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
type ExecutionCandidate = {
  id: string;
  symbolId: string;
  timeframe: string;
  direction: string;
  status: string;
  currentPrice: number;
  proposedEntry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  confidenceScore: number;
  setupScore: number;
  strategyType: string;
  detectedAt: Date;
  featureValues: Prisma.JsonValue;
  indicatorSnapshot: Prisma.JsonValue;
  reasoningLog: Prisma.JsonValue;
  correlationTags: Prisma.JsonValue;
  volatilityClassification: string;
  symbol: {
    ticker: string;
  };
};
type ExecutionPositionRecord = {
  symbolId: string;
  direction: string;
  exposurePct: number;
  symbol: {
    ticker: string;
  };
};

const getDynamicRiskPerTradePct = async (account: { realizedPnlDaily: number; balance: number }) => {
  const setting = await prisma.systemSetting.findUnique({ where: { key: "risk.dynamicControls" } });
  const settingValue = asObject(setting?.value);
  const override = settingValue?.maxRiskPerTradePct;
  const supervisorBase = (typeof override === "number" && Number.isFinite(override))
    ? Math.min(config.risk.maxRiskPerTradePct, Math.max(config.risk.minDynamicRiskPerTradePct, override))
    : config.risk.maxRiskPerTradePct;

  // Build streak context from recent closed positions
  const recentClosed = await prisma.position.findMany({
    where: { status: "CLOSED" },
    orderBy: { closedAt: "desc" },
    take: 20,
    select: { realizedPnl: true, closedAt: true },
  });

  const recentOutcomes = recentClosed.map((p: { realizedPnl: number }) => p.realizedPnl > 0).reverse();
  let consecutiveLosses = 0;
  let consecutiveWins = 0;
  for (let i = recentOutcomes.length - 1; i >= 0; i--) {
    if (!recentOutcomes[i]) { consecutiveLosses++; if (consecutiveWins > 0) break; }
    else break;
  }
  for (let i = recentOutcomes.length - 1; i >= 0; i--) {
    if (recentOutcomes[i]) { consecutiveWins++; if (consecutiveLosses > 0) break; }
    else break;
  }
  if (recentOutcomes.at(-1) === false) consecutiveWins = 0;
  if (recentOutcomes.at(-1) === true) consecutiveLosses = 0;

  const dailyPnlPct = account.balance > 0 ? (account.realizedPnlDaily / account.balance) * 100 : 0;

  const streak = computeStreakRiskScale(supervisorBase, {
    consecutiveLosses,
    consecutiveWins,
    recentOutcomes,
    dailyPnlPct,
  }, config.risk.maxDailyLossPct);

  if (streak.scaleFactor !== 1.0) {
    logger.info("Streak risk scale applied", {
      base: supervisorBase,
      scaled: streak.scaledRiskPct,
      factor: streak.scaleFactor,
      reason: streak.reason,
    });
  }

  return Math.max(config.risk.minDynamicRiskPerTradePct, streak.scaledRiskPct);
};

const getQuote = async (symbol: string, mid: number) => {
  try {
    const response = await fetch(`${config.services.mt5AdapterUrl}/quote/${symbol}?mid=${mid}`);
    if (!response.ok) return null;
    return (await response.json()) as { bid: number; ask: number; mid: number; spreadPct: number };
  } catch {
    return null;
  }
};

const getRecentCloses = async (symbolId: string, timeframe: string, take: number) => {
  const bars = await prisma.priceBar.findMany({
    where: {
      symbolId,
      timeframe,
    },
    orderBy: { timestamp: "desc" },
    take,
  });

  return bars.map((bar) => bar.close).reverse();
};

const getCorrelationContext = async (
  candidate: ExecutionCandidate,
  openPositions: ExecutionPositionRecord[],
) => {
  if (openPositions.length === 0) {
    return { correlatedExposurePct: 0, correlatedSymbols: [] as string[] };
  }

  const candidateCloses = await getRecentCloses(candidate.symbolId, candidate.timeframe, config.risk.correlationLookbackBars);
  if (candidateCloses.length < 8) {
    return { correlatedExposurePct: 0, correlatedSymbols: [] as string[] };
  }

  let correlatedExposurePct = 0;
  const correlatedSymbols: string[] = [];

  for (const position of openPositions) {
    const positionCloses = await getRecentCloses(position.symbolId, candidate.timeframe, config.risk.correlationLookbackBars);
    const correlation = Math.abs(calculatePearsonCorrelation(candidateCloses, positionCloses));
    if (correlation < config.risk.correlationBlockThreshold) continue;
    if (position.direction !== candidate.direction) continue;

    correlatedExposurePct += position.exposurePct;
    correlatedSymbols.push(`${position.symbol.ticker} (${correlation.toFixed(2)})`);
  }

  return {
    correlatedExposurePct: Number(correlatedExposurePct.toFixed(2)),
    correlatedSymbols,
  };
};

// Lazy MT5 integration ID lookup — avoids hardcoding seed-specific "seed-mt5" ID
let cachedMt5IntegrationId: string | null | undefined;

const getMt5IntegrationId = async (): Promise<string | null> => {
  if (cachedMt5IntegrationId !== undefined) return cachedMt5IntegrationId;
  const integration = await prisma.integration.findFirst({ where: { kind: "MT5", enabled: true } });
  cachedMt5IntegrationId = integration?.id ?? null;
  return cachedMt5IntegrationId as string | null;
};

const getAccountSnapshot = async () => {
  let adapterResponse: Response;
  try {
    adapterResponse = await fetch(`${config.services.mt5AdapterUrl}/account`);
  } catch (err) {
    throw new Error(`MT5 adapter unreachable at ${config.services.mt5AdapterUrl}/account: ${(err as Error).message}`);
  }

  if (!adapterResponse.ok) {
    const body = await adapterResponse.text().catch(() => "");
    throw new Error(`MT5 adapter returned ${adapterResponse.status} for /account: ${body.slice(0, 200)}`);
  }

  const account = (await adapterResponse.json()) as {
    balance: number;
    equity: number;
    freeMargin: number;
    usedMargin: number;
    openPnl: number;
    realizedPnlDaily: number;
    drawdownPct: number;
    maxDrawdownPct: number;
    riskState: "NORMAL" | "CAUTION" | "BLOCKED" | "KILL_SWITCH";
    killSwitchActive: boolean;
    mode: "paper" | "live";
  };

  const integrationId = await getMt5IntegrationId();

  await prisma.accountSnapshot.create({
    data: {
      integrationId,
      capturedAt: new Date(),
      balance: account.balance,
      equity: account.equity,
      freeMargin: account.freeMargin,
      usedMargin: account.usedMargin,
      marginLevel: Number(((account.equity / Math.max(account.usedMargin, 1)) * 100).toFixed(2)),
      openPnl: account.openPnl,
      realizedPnlDaily: account.realizedPnlDaily,
      drawdownPct: account.drawdownPct,
      maxDrawdownPct: account.maxDrawdownPct,
      riskState: account.riskState,
      killSwitchActive: account.killSwitchActive,
      mode: account.mode === "paper" ? "PAPER" : "LIVE",
    },
  });

  return account;
};

const evaluateExecution = async (candidateId?: string) => {
  const run = await createWorkerRun({
    workerType: "EXECUTION",
    queueName: queueNames.execution,
    jobName: candidateId ? "candidateExecution" : "executionLoop",
    payload: candidateId ? { candidateId } : undefined,
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "EXECUTION",
      serviceName: "worker-execution",
      status: "running",
      currentTask: candidateId ? "evaluate-candidate" : "execution-loop",
    });

    const account = await getAccountSnapshot();
    const [dynamicRiskPerTradePct, openPositions, candidates] = await Promise.all([
      getDynamicRiskPerTradePct(account),
      prisma.position.findMany({
        where: { status: "OPEN" },
        include: { symbol: true },
      }),
      candidateId
        ? prisma.tradeCandidate.findMany({
            where: { id: candidateId },
            include: { symbol: true, validationRuns: { orderBy: { createdAt: "desc" }, take: 1 } },
          })
        : prisma.tradeCandidate.findMany({
            where: { status: "VALIDATED" },
            include: { symbol: true, validationRuns: { orderBy: { createdAt: "desc" }, take: 1 } },
            orderBy: { detectedAt: "desc" },
            take: 6,
          }),
    ]);

    let placed = 0;
    const integrationId = await getMt5IntegrationId();
    for (const candidate of candidates) {
      const latestValidation = candidate.validationRuns[0];
      const [correlationContext, quote] = await Promise.all([
        getCorrelationContext(candidate, openPositions),
        getQuote(candidate.symbol.ticker, candidate.currentPrice),
      ]);
      const idempotencyKey = stableHash({
        candidateId: candidate.id,
        status: candidate.status,
        actionWindow: new Date().toISOString().slice(0, 13),
      });

      const existingDecision = await prisma.executionDecision.findUnique({ where: { idempotencyKey } });
      if (existingDecision) continue;

      const decision = makeExecutionDecision({
        candidate: {
          symbol: candidate.symbol.ticker,
          timeframe: candidate.timeframe as never,
          direction: candidate.direction as never,
          strategyType: candidate.strategyType,
          detectedAt: candidate.detectedAt.toISOString(),
          currentPrice: candidate.currentPrice,
          proposedEntry: candidate.proposedEntry,
          stopLoss: candidate.stopLoss,
          takeProfit: candidate.takeProfit,
          riskReward: candidate.riskReward,
          confidenceScore: candidate.confidenceScore,
          setupScore: candidate.setupScore,
          featureValues: candidate.featureValues as Record<string, number>,
          indicatorSnapshot: candidate.indicatorSnapshot as never,
          reasoningLog: candidate.reasoningLog as never,
          status: candidate.status as never,
          correlationTags: candidate.correlationTags as string[],
          volatilityClassification: candidate.volatilityClassification,
        },
        validation: latestValidation
          ? {
              winRateEstimate: latestValidation.winRateEstimate,
              averageReturn: latestValidation.averageReturn,
              averageAdverseExcursion: latestValidation.averageAdverseExcursion,
              averageFavorableExcursion: latestValidation.averageFavorableExcursion,
              maxDrawdown: latestValidation.maxDrawdown,
              profitFactor: latestValidation.profitFactor,
              expectancy: latestValidation.expectancy,
              confidenceScore: latestValidation.confidenceScore,
              confidenceIntervalLow: latestValidation.confidenceIntervalLow,
              confidenceIntervalHigh: latestValidation.confidenceIntervalHigh,
              historicalSampleSize: latestValidation.sampleSize,
              dataQualityNotes: latestValidation.dataQualityNotes as string[],
            }
          : null,
        account,
        openPositions: openPositions.map((position) => ({
          symbol: position.symbol.ticker,
          direction: position.direction as never,
          quantity: position.quantity,
          averageEntryPrice: position.avgEntryPrice,
          unrealizedPnl: position.unrealizedPnl,
          exposurePct: position.exposurePct,
          correlationTags: Array.isArray(position.metadata) ? [] : ((position.metadata as { correlationTags?: string[] } | null)?.correlationTags ?? []),
        })),
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
          dynamicRiskPerTradePct,
        },
        marketContext: {
          spreadPct: quote?.spreadPct ?? null,
          correlatedExposurePct: correlationContext.correlatedExposurePct,
          correlatedSymbols: correlationContext.correlatedSymbols,
        },
        references: [
          { type: "candidate", id: candidate.id, label: `${candidate.symbol.ticker} candidate` },
          ...(latestValidation ? [{ type: "validation" as const, id: latestValidation.id, label: "Latest validation" }] : []),
        ],
      });

      const decisionRecord = await prisma.executionDecision.create({
        data: {
          candidateId: candidate.id,
          validationRunId: latestValidation?.id,
          action: decision.action,
          confidence: decision.confidence,
          riskScore: decision.riskScore,
          evidenceSummary: decision.evidenceSummary,
          reasons: asJson(decision.reasons),
          blockingReasons: asJson(decision.blockingReasons),
          supportingReferences: asJson(decision.supportingReferences),
          executionParameters: asNullableJson(decision.executionParameters),
          status: decision.action === "PLACE" ? "SENT" : "PROPOSED",
          mode: config.trading.mode === "paper" ? "PAPER" : "LIVE",
          idempotencyKey,
          executedAt: decision.action === "PLACE" ? new Date() : null,
        },
      });

      if (decision.action === "PLACE" && decision.executionParameters) {
        const response = await fetch(`${config.services.mt5AdapterUrl}/orders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...decision.executionParameters,
            decisionId: decisionRecord.id,
          }),
        });
        const orderResult = (await response.json()) as {
          orderId?: string;
          brokerOrderId?: string;
          status?: string;
          reason?: string;
          error?: string;
          detail?: string; // FastAPI returns errors as { detail: "..." }
        };

        if (!response.ok) {
          const errorMessage = orderResult.reason ?? orderResult.error ?? orderResult.detail ?? `Broker rejected order with status ${response.status}.`;

          await prisma.executionDecision.update({
            where: { id: decisionRecord.id },
            data: { status: "REJECTED" },
          });

          await prisma.order.create({
            data: {
              symbolId: candidate.symbolId,
              integrationId,
              decisionId: decisionRecord.id,
              broker: "mt5-adapter",
              brokerOrderId: orderResult.brokerOrderId,
              mode: config.trading.mode === "paper" ? "PAPER" : "LIVE",
              direction: decision.executionParameters.direction,
              orderType: "MARKET",
              quantity: decision.executionParameters.quantity,
              entryPrice: decision.executionParameters.entry,
              stopLoss: decision.executionParameters.stopLoss,
              takeProfit: decision.executionParameters.takeProfit,
              status: "REJECTED",
              submittedAt: new Date(),
              rejectedAt: new Date(),
              errorMessage,
              payload: asJson(orderResult),
            },
          });

          await prisma.riskEvent.create({
            data: {
              severity: "WARNING",
              eventType: "broker_reject",
              message: errorMessage,
              details: asJson({ candidateId: candidate.id, decisionId: decisionRecord.id, orderResult }),
              blocking: true,
              candidateId: candidate.id,
              decisionId: decisionRecord.id,
            },
          });

          await prisma.auditLog.create({
            data: {
              actorType: "WORKER",
              actorId: "worker-execution",
              workerType: "EXECUTION",
              severity: "WARNING",
              category: "worker.execution.reject",
              message: `Broker rejected ${candidate.symbol.ticker}: ${errorMessage}`,
              entityType: "execution_decision",
              entityId: decisionRecord.id,
              symbolId: candidate.symbolId,
            },
          });

          continue;
        }

        await prisma.order.create({
          data: {
            symbolId: candidate.symbolId,
            integrationId,
            decisionId: decisionRecord.id,
            broker: "mt5-adapter",
            brokerOrderId: orderResult.brokerOrderId,
            mode: config.trading.mode === "paper" ? "PAPER" : "LIVE",
            direction: decision.executionParameters.direction,
            orderType: "MARKET",
            quantity: decision.executionParameters.quantity,
            entryPrice: decision.executionParameters.entry,
            stopLoss: decision.executionParameters.stopLoss,
            takeProfit: decision.executionParameters.takeProfit,
            status: (orderResult.status ?? "SUBMITTED") as never,
            submittedAt: new Date(),
            filledAt: orderResult.status === "FILLED" ? new Date() : null,
            errorMessage: orderResult.reason,
            payload: asJson(orderResult),
          },
        });

        if (orderResult.status === "FILLED") {
          await prisma.position.create({
            data: {
              symbolId: candidate.symbolId,
              direction: decision.executionParameters.direction,
              quantity: decision.executionParameters.quantity,
              avgEntryPrice: decision.executionParameters.entry,
              stopLoss: decision.executionParameters.stopLoss,
              takeProfit: decision.executionParameters.takeProfit,
              unrealizedPnl: 0,
              realizedPnl: 0,
              exposurePct: Number(dynamicRiskPerTradePct.toFixed(2)),
              status: "OPEN",
              openedAt: new Date(),
              metadata: asJson({ correlationTags: candidate.correlationTags, spreadPct: quote?.spreadPct ?? null }),
            },
          });

          await prisma.tradeCandidate.update({
            where: { id: candidate.id },
            data: { status: "EXECUTED" },
          });

          await queueNotification({
            category: "trade_event",
            severity: "info",
            title: `Trade executed: ${candidate.symbol.ticker}`,
            body: `${decision.executionParameters.direction} ${candidate.symbol.ticker} was placed at ${decision.executionParameters.entry.toFixed(2)}.`,
            dedupeKey: `trade-executed-${decisionRecord.id}`,
            metadata: { candidateId: candidate.id, decisionId: decisionRecord.id, spreadPct: quote?.spreadPct ?? null },
          });
          placed += 1;
        }
      } else if (decision.blockingReasons.length > 0) {
        await prisma.riskEvent.create({
          data: {
            severity: decision.action === "INVALIDATE" ? "WARNING" : "INFO",
            eventType: "execution_blocked",
            message: decision.blockingReasons[0]?.detail ?? "Execution was blocked.",
            details: asJson(decision.blockingReasons),
            blocking: true,
            candidateId: candidate.id,
            decisionId: decisionRecord.id,
          },
        });
      }

      const outcomeCode =
        decision.action === "PLACE"
          ? DECISION_CODES.EXECUTION_ENTERED
          : decision.action === "INVALIDATE"
            ? DECISION_CODES.EXECUTION_INVALIDATED
            : decision.action === "SKIP"
              ? DECISION_CODES.EXECUTION_SKIPPED
              : config.trading.manualApprovalMode
                ? DECISION_CODES.EXECUTION_MANUAL_APPROVAL
                : DECISION_CODES.EXECUTION_HELD;

      const outcomeRecord = buildDecisionRecord(outcomeCode, {
        symbol: candidate.symbol.ticker,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        confidence: decision.confidence,
        riskScore: decision.riskScore,
        observed: {
          action: decision.action,
          evidenceSummary: decision.evidenceSummary,
          blockingReasonCount: decision.blockingReasons.length,
        },
        parentIdeaId: candidate.id,
        parentValidationId: latestValidation?.id,
        parentExecutionId: decisionRecord.id,
      });

      await prisma.auditLog.create({
        data: {
          actorType: "WORKER",
          actorId: "worker-execution",
          workerType: "EXECUTION",
          severity: decision.action === "PLACE" ? "INFO" : decision.action === "INVALIDATE" ? "WARNING" : "INFO",
          category: "execution",
          message: outcomeRecord.title,
          entityType: "execution_decision",
          entityId: decisionRecord.id,
          symbolId: candidate.symbolId,
          data: asJson({
            structured: outcomeRecord,
            structuredBlockingReasons: decision.structuredBlockingReasons ?? [],
            action: decision.action,
            confidence: decision.confidence,
            riskScore: decision.riskScore,
          }),
        },
      });

      // Write one dedicated audit row per blocking reason so reviewers can
      // filter "why was this skipped" directly on the audit page without
      // having to open the parent execution decision.
      for (const structuredBlocker of decision.structuredBlockingReasons ?? []) {
        await prisma.auditLog.create({
          data: {
            actorType: "WORKER",
            actorId: "worker-execution",
            workerType: "EXECUTION",
            severity:
              structuredBlocker.severity === "critical"
                ? "CRITICAL"
                : structuredBlocker.severity === "warning"
                  ? "WARNING"
                  : "INFO",
            category: structuredBlocker.category,
            message: structuredBlocker.title,
            entityType: "execution_decision",
            entityId: decisionRecord.id,
            symbolId: candidate.symbolId,
            data: asJson({ structured: structuredBlocker }),
          },
        });
      }
    }

    await completeWorkerRun(run.id, `${placed} orders placed`, { placed });
    await upsertWorkerHeartbeat({
      workerType: "EXECUTION",
      serviceName: "worker-execution",
      status: "healthy",
      currentTask: "idle",
      metrics: { placed },
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "EXECUTION",
      message: err.message,
      stack: err.stack,
      payload: candidateId ? { candidateId } : undefined,
    });
    await upsertWorkerHeartbeat({
      workerType: "EXECUTION",
      serviceName: "worker-execution",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message },
    });
    throw error;
  }
};

setInterval(() => {
  void upsertWorkerHeartbeat({
    workerType: "EXECUTION",
    serviceName: "worker-execution",
    status: "healthy",
    currentTask: "idle",
  });
}, 15_000);

createPlatformWorker<{ candidateId?: string } & { trigger: "validation_completed" | "periodic_loop" | "manual" }>(
  queueNames.execution,
  "worker-execution",
  async (payload) => {
    await evaluateExecution(payload.candidateId);
  },
);

logger.info("Execution worker started");
