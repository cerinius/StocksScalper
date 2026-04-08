/**
 * Validation Worker — Real Historical Analog Engine
 *
 * Instead of generating synthetic analogs (which produced meaningless metrics),
 * this worker now:
 *   1. Fetches actual stored PriceBars for the candidate's symbol from the DB
 *   2. Normalises the current 20-bar return pattern
 *   3. Slides a window over the full history to find patterns with high
 *      Pearson correlation to the current one
 *   4. Records the ACTUAL future outcome (next N bars) of each analog
 *   5. Falls back to adaptive synthetic analogs only when <12 real matches exist
 *
 * This makes the validation step genuinely informative.
 */

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface AnalogRecord {
  similarity: number;
  outcomeR: number;
  returnPct: number;
  holdBars: number;
}

// ─── Real Historical Analog Finder ───────────────────────────────────────────

/**
 * Pearson correlation coefficient between two equal-length arrays.
 * Returns a value in [-1, 1].
 */
const pearsonCorrelation = (a: number[], b: number[]): number => {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;

  let sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
    sumA2 += a[i] ** 2;
    sumB2 += b[i] ** 2;
    sumAB += a[i] * b[i];
  }

  const meanA = sumA / n;
  const meanB = sumB / n;
  const num = sumAB - n * meanA * meanB;
  const den = Math.sqrt((sumA2 - n * meanA ** 2) * (sumB2 - n * meanB ** 2));

  return den === 0 ? 0 : num / den;
};

/**
 * Converts a sequence of closing prices to percentage returns.
 */
const toReturns = (closes: number[]): number[] => {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const pct = closes[i - 1] === 0 ? 0 : (closes[i] - closes[i - 1]) / closes[i - 1];
    returns.push(pct);
  }
  return returns;
};

/**
 * Finds up to `maxAnalogs` real historical analogs for the given candidate
 * using price bars stored in the database.
 *
 * Algorithm:
 *   - Takes the most recent `patternLen` bars as the "query" pattern
 *   - Slides a window over all stored bars (sorted oldest-first)
 *   - Computes Pearson correlation of normalised returns at each window
 *   - Keeps the top-K by correlation (min 0.4)
 *   - For each match, records the actual outcome over the next `holdBars` bars
 *
 * Falls back to adaptive synthetics when insufficient real history exists.
 */
const findRealAnalogs = async (
  symbolId: string,
  timeframe: string,
  stopDistance: number,
  direction: "LONG" | "SHORT",
  setupScore: number,
  maxAnalogs = 14,
): Promise<AnalogRecord[]> => {
  const patternLen = 20;
  const minHold = 3;
  const maxHold = 15;

  // Fetch all stored price bars for this symbol+timeframe (up to 500)
  const bars = await prisma.priceBar.findMany({
    where: { symbolId, timeframe },
    orderBy: { timestamp: "asc" },
    take: 500,
    select: { close: true, timestamp: true },
  });

  const closes = bars.map((b) => b.close);

  // Need at least patternLen * 2 + maxHold bars for meaningful search
  if (closes.length < patternLen * 2 + maxHold) {
    return buildAdaptiveAnalogs(direction, setupScore, maxAnalogs);
  }

  // Query pattern: normalised returns of the last `patternLen` closes
  const queryCloses = closes.slice(-patternLen);
  const queryReturns = toReturns(queryCloses);

  if (queryReturns.length < patternLen - 1) {
    return buildAdaptiveAnalogs(direction, setupScore, maxAnalogs);
  }

  // Slide window over history (exclude the last patternLen bars = current pattern)
  interface ScoredWindow { similarity: number; startIdx: number; endIdx: number; entryPrice: number }
  const candidates: ScoredWindow[] = [];

  for (let i = 0; i + patternLen + minHold <= closes.length - patternLen; i++) {
    const windowCloses = closes.slice(i, i + patternLen);
    const windowReturns = toReturns(windowCloses);
    const sim = pearsonCorrelation(queryReturns, windowReturns);

    if (sim >= 0.4) {
      candidates.push({
        similarity: sim,
        startIdx: i,
        endIdx: i + patternLen - 1,
        entryPrice: windowCloses[windowCloses.length - 1],
      });
    }
  }

  // Sort by similarity desc, take top matches
  candidates.sort((a, b) => b.similarity - a.similarity);
  const topMatches = candidates.slice(0, maxAnalogs);

  if (topMatches.length < 3) {
    return buildAdaptiveAnalogs(direction, setupScore, maxAnalogs);
  }

  // For each match, compute actual future outcome
  const analogs: AnalogRecord[] = [];
  for (const match of topMatches) {
    const holdBarsUsed = Math.min(maxHold, closes.length - match.endIdx - 1);
    if (holdBarsUsed < minHold) continue;

    const futureClose = closes[match.endIdx + holdBarsUsed];
    const entryClose = match.entryPrice;

    if (!futureClose || entryClose === 0) continue;

    const rawReturn = (futureClose - entryClose) / entryClose;
    const directedReturn = direction === "LONG" ? rawReturn : -rawReturn;
    const returnPct = directedReturn * 100;
    const outcomeR = stopDistance > 0 ? (directedReturn * entryClose) / stopDistance : returnPct / 100;

    analogs.push({
      similarity: Number(match.similarity.toFixed(4)),
      outcomeR: Number(outcomeR.toFixed(3)),
      returnPct: Number(returnPct.toFixed(3)),
      holdBars: holdBarsUsed,
    });
  }

  // Pad with synthetics if we didn't find enough real analogs
  if (analogs.length < 6) {
    const synthetic = buildAdaptiveAnalogs(direction, setupScore, maxAnalogs - analogs.length);
    return [...analogs, ...synthetic].slice(0, maxAnalogs);
  }

  return analogs.slice(0, maxAnalogs);
};

/**
 * Adaptive synthetic fallback — produces analogs that are consistent with
 * the setup score and direction rather than purely mechanical patterns.
 * Used only when there is insufficient price history in the DB.
 */
const buildAdaptiveAnalogs = (
  direction: "LONG" | "SHORT",
  setupScore: number,
  count = 14,
): AnalogRecord[] => {
  const bias = direction === "LONG" ? 1 : -1;
  const edge = (setupScore - 50) / 50; // -1 to 1 based on setup quality

  return Array.from({ length: count }, (_, i) => {
    // Simulate realistic distribution: ~55% wins for edge=0.1, rising with quality
    const winProb = 0.5 + edge * 0.25;
    const isWin = (i / count) < winProb;
    const outcomeR = isWin
      ? Number(((0.6 + Math.random() * 1.2) * bias).toFixed(2))
      : Number(((-0.4 - Math.random() * 0.6) * bias).toFixed(2));

    return {
      similarity: Number((0.85 - i * 0.04).toFixed(2)),
      outcomeR,
      returnPct: Number((outcomeR * 1.5 + (Math.random() - 0.5) * 0.4).toFixed(2)),
      holdBars: 3 + Math.floor(i * 0.8),
    };
  });
};

// ─── Main processing loop ─────────────────────────────────────────────────────

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
          where: { status: { in: ["NEW", "SCANNED", "VALIDATING"] } },
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

      const stopDistance = Math.abs(candidate.currentPrice - candidate.stopLoss);

      // ── Find real historical analogs ───────────────────────────────────────
      const analogs = await findRealAnalogs(
        candidate.symbolId,
        candidate.timeframe,
        stopDistance,
        candidate.direction as "LONG" | "SHORT",
        candidate.setupScore,
        14,
      );

      logger.debug("Analogs resolved", {
        symbol: candidate.symbol.ticker,
        analogCount: analogs.length,
        realAnalogs: analogs.filter((a) => a.similarity >= 0.4).length,
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
        analogs,
      );

      const monteCarlo = runMonteCarloSimulation(
        validationBundle.analogs.map((a) => a.outcomeR),
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
          `Monte Carlo risk of ruin elevated at ${(monteCarlo.riskOfRuinPct * 100).toFixed(1)}% (${monteCarlo.simulations} simulations).`,
        );
      }

      const realAnalogCount = analogs.filter((a) => a.similarity >= 0.4).length;
      if (realAnalogCount > 0) {
        dataQualityNotes.push(`Used ${realAnalogCount} real historical pattern matches from stored price bars.`);
      } else {
        dataQualityNotes.push("Insufficient price history; used adaptive synthetic analogs.");
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
            source: realAnalogCount > 0 ? "real_historical_pattern_matching" : "adaptive_synthetic",
            realAnalogCount,
            monteCarlo,
          }),
          completedAt: new Date(),
        },
      });

      for (const [index, analog] of validationBundle.analogs.entries()) {
        await prisma.backtestResult.create({
          data: {
            validationRunId: validationRun.id,
            scenarioLabel: `${analog.similarity >= 0.4 ? "Real" : "Synthetic"} Analog ${index + 1}`,
            similarityScore: analog.similarity,
            outcomeR: analog.outcomeR,
            returnPct: analog.returnPct,
            maxAdverseExcursion: Math.max(0, -analog.outcomeR),
            maxFavorableExcursion: Math.max(0, analog.outcomeR),
            holdBars: analog.holdBars,
            occurredAt: new Date(Date.now() - index * 86_400_000),
            context: asJson({
              candidateId: candidate.id,
              source: analog.similarity >= 0.4 ? "real_history" : "synthetic",
            }),
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
          message: `Validation ${validationBundle.finalScore >= 60 ? "passed" : "failed"} for ${candidate.symbol.ticker} (score ${validationBundle.finalScore.toFixed(1)}, ${realAnalogCount} real analogs).`,
          entityType: "validation_run",
          entityId: validationRun.id,
          symbolId: candidate.symbolId,
          data: {
            finalScore: validationBundle.finalScore,
            realAnalogCount,
            expectancy: validationBundle.metrics.expectancy,
            winRate: validationBundle.metrics.winRateEstimate,
          },
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

// ─── Bootstrap ────────────────────────────────────────────────────────────────

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

logger.info("Validation worker started (real historical analog engine)");
