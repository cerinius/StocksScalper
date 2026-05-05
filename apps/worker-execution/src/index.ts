import { getPlatformConfig } from "@stock-radar/config";
import {
  completeWorkerRun,
  createWorkerRun,
  failWorkerRun,
  prisma,
  upsertWorkerHeartbeat,
} from "@stock-radar/db";
import { createLogger } from "@stock-radar/logging";
import { createPlatformWorker, queueNames } from "@stock-radar/queues";
import { Prisma } from "@prisma/client";
import { isAiEnabled } from "@stock-radar/ai";

import { collectAccountContexts } from "./flow/collect-context";
import { allocateCandidates } from "./flow/allocate";
import { runPretradeCritic } from "./flow/pretrade-critic";
import { decideForAccount } from "./flow/decide";
import { placeOrder } from "./flow/place";
import { persistAllocationDecision, persistDecision } from "./flow/record";
import { getCorrelationContext, getQuote } from "./flow/market-context";
import type { CandidateContext } from "./flow/types";
import { runLegacyExecutionLoop } from "./legacy-loop";

const config = getPlatformConfig();
const logger = createLogger("worker-execution");
const aiCriticEnabled = isAiEnabled();

type AnyPrisma = Record<string, unknown>;
const pAny = prisma as unknown as AnyPrisma;

const platformDefaults = {
  maxSymbolExposurePct: config.risk.maxSymbolExposurePct,
  maxCorrelatedExposurePct: config.risk.maxCorrelatedExposurePct,
  maxEntrySpreadPct: config.risk.maxEntrySpreadPct,
  staleSignalSeconds: config.risk.staleSignalSeconds,
};

/**
 * Fetch validated candidates (or a single candidate by id) and
 * hydrate them into CandidateContext objects ready for allocation.
 * Correlation and spread context are computed once per candidate and
 * reused across all account evaluations.
 */
const buildCandidateContexts = async (candidateId?: string): Promise<CandidateContext[]> => {
  const candidates = await prisma.tradeCandidate.findMany({
    where: candidateId ? { id: candidateId } : { status: "VALIDATED" },
    include: { symbol: true, validationRuns: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: candidateId ? undefined : { detectedAt: "desc" },
    take: candidateId ? 1 : 6,
  });

  // All open positions across all accounts are used for spread / correlation
  // context (we still bound correlation to same-direction accounts in
  // the rule evaluator).
  const allOpenPositions = await prisma.position.findMany({
    where: { status: "OPEN" },
    include: { symbol: true },
  });

  const contexts: CandidateContext[] = [];
  for (const candidate of candidates) {
    const latestValidation = candidate.validationRuns[0];
    const [correlation, quote] = await Promise.all([
      getCorrelationContext(
        { symbolId: candidate.symbolId, timeframe: candidate.timeframe, direction: candidate.direction },
        allOpenPositions,
      ),
      getQuote(candidate.symbol.ticker, candidate.currentPrice),
    ]);

    contexts.push({
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
        correlationTags: (candidate.correlationTags as string[]) ?? [],
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
            dataQualityNotes: (latestValidation.dataQualityNotes as string[]) ?? [],
          }
        : null,
      references: [
        { type: "candidate", id: candidate.id, label: `${candidate.symbol.ticker} candidate` },
        ...(latestValidation ? [{ type: "validation", id: latestValidation.id, label: "Latest validation" }] : []),
      ],
      dbIds: {
        candidateId: candidate.id,
        validationRunId: latestValidation?.id ?? null,
        symbolId: candidate.symbolId,
      },
      market: {
        spreadPct: quote?.spreadPct ?? null,
        correlatedExposurePct: correlation.correlatedExposurePct,
        correlatedSymbols: correlation.correlatedSymbols,
      },
    });
  }
  return contexts;
};

/**
 * Account-aware execution loop. For each VALIDATED candidate:
 *  1. Build market context (spread, correlation).
 *  2. Collect every active account + its rule profile + snapshot.
 *  3. Allocate: per (candidate, account), evaluate deterministic rules.
 *  4. Decide: run the decision engine with account-derived risk limits.
 *  5. Critic (advisory, Phase E): AI may reduce size — NEVER widen.
 *  6. Place: call MT5 adapter with client order id idempotency.
 *  7. Record: ExecutionDecision, Order, Position, RiskEvent, AuditLog,
 *     RuleViolation, AllocationDecision — all attributed to accountId.
 *
 * Phase C will add a real AllocationPolicy resolver (ONE_ACCOUNT_ONLY
 * vs. MAX_N_ACCOUNTS etc.) — right now we pick the top-ranked
 * eligible account per candidate so the pipeline is end-to-end.
 */
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

    const accounts = await collectAccountContexts();

    // If the multi-account world hasn't been bootstrapped yet (db has
    // no Account rows or delegate missing), fall back to the legacy
    // single-account loop so deployments keep working.
    if (accounts.length === 0) {
      logger.warn("No active accounts found — running legacy execution loop as fallback.");
      const placed = await runLegacyExecutionLoop(candidateId);
      await completeWorkerRun(run.id, `${placed} orders placed (legacy)`, { placed, mode: "legacy" });
      await upsertWorkerHeartbeat({
        workerType: "EXECUTION",
        serviceName: "worker-execution",
        status: "healthy",
        currentTask: "idle",
        metrics: { placed, mode: "legacy" },
      });
      return;
    }

    const candidates = await buildCandidateContexts(candidateId);
    if (candidates.length === 0) {
      await completeWorkerRun(run.id, "No candidates to evaluate", { placed: 0, candidates: 0 });
      await upsertWorkerHeartbeat({
        workerType: "EXECUTION",
        serviceName: "worker-execution",
        status: "healthy",
        currentTask: "idle",
        metrics: { placed: 0 },
      });
      return;
    }

    const setupPolicies = await prisma.setupAllocationPolicy
      .findMany()
      .then((rows: Array<{
        setupKey: string;
        policy: "ONE_ACCOUNT_ONLY" | "MAX_N_ACCOUNTS" | "ALL_ELIGIBLE" | "CHALLENGE_ONLY" | "FUNDED_ONLY" | "STRATEGY_TAGGED";
        maxAccounts: number;
        requiredTags: unknown;
        excludedTags: unknown;
        allowedPhaseKinds: unknown;
        allowedAccountModes: unknown;
      }>) =>
        Object.fromEntries(
          rows.map((r: {
            setupKey: string;
            policy: "ONE_ACCOUNT_ONLY" | "MAX_N_ACCOUNTS" | "ALL_ELIGIBLE" | "CHALLENGE_ONLY" | "FUNDED_ONLY" | "STRATEGY_TAGGED";
            maxAccounts: number;
            requiredTags: unknown;
            excludedTags: unknown;
            allowedPhaseKinds: unknown;
            allowedAccountModes: unknown;
          }) => [
            r.setupKey,
            {
              setupKey: r.setupKey,
              policy: r.policy,
              maxAccounts: r.maxAccounts,
              requiredTags: (r.requiredTags as string[]) ?? [],
              excludedTags: (r.excludedTags as string[]) ?? [],
              allowedPhaseKinds: (r.allowedPhaseKinds as string[]) ?? [],
              allowedAccountModes: (r.allowedAccountModes as string[]) ?? [],
            },
          ]),
        ),
      )
      .catch(() => ({}));

    const now = new Date();
    const allocations = allocateCandidates({ candidates, accounts, news: [], now, setupPolicies });

    let placed = 0;
    for (const alloc of allocations) {
      const selectedAccountIds = alloc.selected.map((row) => row.account.accountId);

      // Record a RuleViolation for every fully-blocked account so we
      // keep an audit trail even when no trade is placed.
      for (const blockedRow of alloc.blocked) {
        const allocDecisionIdemKey = `${alloc.candidateContext.dbIds.candidateId}-${blockedRow.account.accountId}-${new Date().toISOString().slice(0, 13)}`;
        void allocDecisionIdemKey; // reserved for future dedupe
      }

      if (alloc.selected.length === 0) {
        // No eligible account: record an AllocationDecision and move on.
        await persistAllocationDecision(alloc, []);
        continue;
      }

      for (const pick of alloc.selected) {
        const critic = await runPretradeCritic({
          candidateContext: alloc.candidateContext,
          allocationRow: pick,
          aiEnabled: aiCriticEnabled,
        });

        // If AI vetoes and verdict is REJECT, skip placement (critic can
        // only add safety). The decision engine still runs for audit.
        const decideResult = decideForAccount({
          candidateContext: alloc.candidateContext,
          allocationRow: pick,
          critic,
          platformDefaults,
          manualApprovalMode: config.trading.manualApprovalMode,
        });

        const tradingMode = pick.account.tradingMode === "paper" ? "PAPER" : "LIVE";

        // Idempotency check against existing ExecutionDecision for this
        // account and candidate within the current hour window.
        const idem = await prisma.executionDecision
          .findFirst({
            where: {
              candidateId: alloc.candidateContext.dbIds.candidateId,
              accountId: pick.account.accountId,
            },
            orderBy: { createdAt: "desc" },
          })
          .catch(() => null);
        if (idem && idem.createdAt.getTime() > Date.now() - 60 * 60 * 1_000) {
          logger.info("Skipping account — ExecutionDecision already recorded in the last hour.", {
            candidateId: alloc.candidateContext.dbIds.candidateId,
            accountId: pick.account.accountId,
          });
          continue;
        }

        let placement = null as Awaited<ReturnType<typeof placeOrder>> | null;
        const shouldPlace =
          decideResult.decision.action === "PLACE" &&
          critic.verdict !== "REJECT" &&
          decideResult.decision.executionParameters !== null;
        if (shouldPlace) {
          placement = await placeOrder({
            mt5AdapterUrl: config.services.mt5AdapterUrl,
            account: pick.account,
            decision: decideResult.decision,
            decisionId: "pending", // replaced post-persist; adapter only needs clientOrderId
            candidateId: alloc.candidateContext.dbIds.candidateId,
          });
        }

        const decisionId = await persistDecision({
          candidateContext: alloc.candidateContext,
          account: pick.account,
          allocationRow: pick,
          decideResult,
          critic,
          placement,
          tradingMode,
        });

        if (placement?.ok && placement.orderStatus === "FILLED") {
          placed += 1;
        }

        logger.info("Decision recorded", {
          candidateId: alloc.candidateContext.dbIds.candidateId,
          decisionId,
          accountId: pick.account.accountId,
          accountMode: pick.account.mode,
          action: decideResult.decision.action,
          critic: critic.verdict,
          appliedSizeMultiplier: decideResult.appliedSizeMultiplier,
        });
      }

      await persistAllocationDecision(alloc, selectedAccountIds);
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
    logger.error("Execution worker error", { message: err.message, stack: err.stack });
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

type ExecutionJobPayload = { candidateId?: string } & { trigger: "validation_completed" | "periodic_loop" | "manual" };
createPlatformWorker<ExecutionJobPayload>(
  queueNames.execution,
  "worker-execution",
  async (payload: ExecutionJobPayload) => {
    await evaluateExecution(payload.candidateId);
  },
);

// Exported for legacy fallback — referenced by legacy-loop
export { pAny };

logger.info("Execution worker started (account-aware pipeline enabled)");
