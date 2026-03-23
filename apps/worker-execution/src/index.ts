import { getPlatformConfig } from "@stock-radar/config";
import { makeExecutionDecision } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformWorker, queueNames, queueNotification } from "@stock-radar/queues";
import { stableHash } from "@stock-radar/shared";

const config = getPlatformConfig();
const logger = createLogger("worker-execution");
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;
const asNullableJson = <T>(value: T | null) => (value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue));

const getAccountSnapshot = async () => {
  const adapterResponse = await fetch(`${config.services.mt5AdapterUrl}/account`);
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

  await prisma.accountSnapshot.create({
    data: {
      integrationId: "seed-mt5",
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
    const [openPositions, candidates] = await Promise.all([
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
    for (const candidate of candidates) {
      const latestValidation = candidate.validationRuns[0];
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
          staleSignalSeconds: config.risk.staleSignalSeconds,
          manualApprovalMode: config.trading.manualApprovalMode,
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
        const orderResult = (await response.json()) as { orderId: string; brokerOrderId: string; status: string; reason?: string };

        await prisma.order.create({
          data: {
            symbolId: candidate.symbolId,
            integrationId: "seed-mt5",
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
            status: orderResult.status as never,
            submittedAt: new Date(),
            filledAt: orderResult.status === "FILLED" ? new Date() : null,
            errorMessage: orderResult.reason,
            payload: asJson(orderResult),
          },
        });

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
            exposurePct: Number(config.risk.maxRiskPerTradePct.toFixed(2)),
            status: "OPEN",
            openedAt: new Date(),
            metadata: asJson({ correlationTags: candidate.correlationTags }),
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
          metadata: { candidateId: candidate.id, decisionId: decisionRecord.id },
        });
        placed += 1;
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

      await prisma.auditLog.create({
        data: {
          actorType: "WORKER",
          actorId: "worker-execution",
          workerType: "EXECUTION",
          severity: decision.action === "PLACE" ? "INFO" : "WARNING",
          category: "worker.execution",
          message: `Execution decision ${decision.action} created for ${candidate.symbol.ticker}.`,
          entityType: "execution_decision",
          entityId: decisionRecord.id,
          symbolId: candidate.symbolId,
        },
      });
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
