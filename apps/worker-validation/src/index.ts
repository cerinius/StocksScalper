import { getPlatformConfig } from "@stock-radar/config";
import { runMonteCarloSimulation, validateCandidate } from "@stock-radar/core";
import { Prisma } from "@prisma/client";
import { completeWorkerRun, createWorkerRun, failWorkerRun, prisma, upsertWorkerHeartbeat } from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformQueues, createPlatformWorker, queueNames } from "@stock-radar/queues";

const config = getPlatformConfig();
const logger = createLogger("worker-validation");
const queues = createPlatformQueues();
const asJson = <T>(value: T) => value as Prisma.InputJsonValue;

const buildAnalogs = (candidate: Awaited<ReturnType<typeof prisma.tradeCandidate.findFirstOrThrow>>) =>
  Array.from({ length: 12 }).map((_, index) => {
    const bias = candidate.direction === "LONG" ? 1 : -1;
    const slope = candidate.setupScore / 100;
    const outcomeR = Number((((index % 4 === 0 ? -0.8 : 0.5 + index * 0.12) * slope) * bias).toFixed(2));
    return {
      similarity: Number((0.92 - index * 0.04).toFixed(2)),
      outcomeR,
      returnPct: Number((outcomeR * 1.45).toFixed(2)),
      holdBars: 3 + index,
    };
  });

const processCandidate = async (candidateId?: string) => {
  const run = await createWorkerRun({
    workerType: "VALIDATION",
    queueName: queueNames.validation,
    jobName: candidateId ? "candidateValidation" : "periodicValidation",
    payload: candidateId ? { candidateId } : undefined,
  });

  try {
    await upsertWorkerHeartbeat({
      workerType: "VALIDATION",
      serviceName: "worker-validation",
      status: "running",
      currentTask: candidateId ? "validate-candidate" : "periodic-validation",
    });

    const candidates = candidateId
      ? [
          await prisma.tradeCandidate.findFirstOrThrow({
            where: { id: candidateId },
            include: { symbol: true },
          }),
        ]
      : await prisma.tradeCandidate.findMany({
          where: {
            status: {
              in: ["NEW", "SCANNED", "VALIDATING"],
            },
          },
          include: { symbol: true },
          orderBy: { detectedAt: "desc" },
          take: 10,
        });

    let processed = 0;
    for (const candidate of candidates) {
      await prisma.tradeCandidate.update({
        where: { id: candidate.id },
        data: { status: "VALIDATING" },
      });

      const validationBundle = validateCandidate(
        {
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
        buildAnalogs(candidate),
      );
      const monteCarlo = runMonteCarloSimulation(
        validationBundle.analogs.map((analog) => analog.outcomeR),
        {
          simulations: config.risk.monteCarloSimulations,
          riskPerTradePct: config.risk.maxRiskPerTradePct,
          ruinDrawdownPct: config.risk.monteCarloRuinDrawdownPct,
          seed: candidate.id.length + candidate.symbol.ticker.length,
        },
      );
      const dataQualityNotes = [...validationBundle.metrics.dataQualityNotes];
      if (monteCarlo.riskOfRuinPct >= 0.1) {
        dataQualityNotes.push(
          `Monte Carlo risk of ruin is elevated at ${(monteCarlo.riskOfRuinPct * 100).toFixed(1)}% using ${monteCarlo.simulations} simulations.`,
        );
      }

      const validationRun = await prisma.validationRun.create({
        data: {
          candidateId: candidate.id,
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
          dataQualityNotes: asJson(dataQualityNotes),
          reasonsFor: asJson(validationBundle.reasonsFor),
          reasonsAgainst: asJson(validationBundle.reasonsAgainst),
          invalidationConditions: asJson([{ type: "stop_loss", level: candidate.stopLoss }]),
          backtestMetadata: asJson({
            source: "rule_based_validation_worker",
            monteCarlo,
          }),
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
            maxAdverseExcursion: Math.max(0, -analog.outcomeR),
            maxFavorableExcursion: Math.max(0, analog.outcomeR),
            holdBars: analog.holdBars,
            occurredAt: new Date(Date.now() - index * 86_400_000),
            context: asJson({ candidateId: candidate.id, seed: "generated" }),
          },
        });
      }

      const nextStatus = validationBundle.finalScore >= 60 ? "VALIDATED" : "REJECTED";
      await prisma.tradeCandidate.update({
        where: { id: candidate.id },
        data: { status: nextStatus },
      });

      await prisma.auditLog.create({
        data: {
          actorType: "WORKER",
          actorId: "worker-validation",
          workerType: "VALIDATION",
          severity: validationBundle.finalScore >= 60 ? "INFO" : "WARNING",
          category: "worker.validation",
          message: `Validation ${validationBundle.finalScore >= 60 ? "passed" : "failed"} for ${candidate.symbol.ticker}.`,
          entityType: "validation_run",
          entityId: validationRun.id,
          symbolId: candidate.symbolId,
          data: { finalScore: validationBundle.finalScore },
        },
      });

      if (validationBundle.finalScore >= 60) {
        await queues.execution.add("validationCompleted", {
          candidateId: candidate.id,
          trigger: "validation_completed",
        });
      }

      processed += 1;
    }

    await completeWorkerRun(run.id, `${processed} candidates validated`, { processed });
    await upsertWorkerHeartbeat({
      workerType: "VALIDATION",
      serviceName: "worker-validation",
      status: "healthy",
      currentTask: "idle",
      metrics: { processed },
    });
  } catch (error) {
    const err = error as Error;
    await failWorkerRun({
      runId: run.id,
      workerType: "VALIDATION",
      message: err.message,
      stack: err.stack,
      payload: candidateId ? { candidateId } : undefined,
    });
    await upsertWorkerHeartbeat({
      workerType: "VALIDATION",
      serviceName: "worker-validation",
      status: "degraded",
      currentTask: "error",
      metrics: { error: err.message },
    });
    throw error;
  }
};

setInterval(() => {
  void upsertWorkerHeartbeat({
    workerType: "VALIDATION",
    serviceName: "worker-validation",
    status: "healthy",
    currentTask: "idle",
  });
}, 15_000);

createPlatformWorker<{ candidateId?: string } & { trigger: "candidate_created" | "periodic_rescore" | "manual" }>(
  queueNames.validation,
  "worker-validation",
  async (payload) => {
    await processCandidate(payload.candidateId);
  },
);

logger.info("Validation worker started");
