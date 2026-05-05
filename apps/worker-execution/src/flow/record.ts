import { prisma } from "@stock-radar/db";
import { queueNotification } from "@stock-radar/queues";
import { DECISION_CODES, buildDecisionRecord, stableHash } from "@stock-radar/shared";
import type { StructuredDecision } from "@stock-radar/types";
import type { AllocationForCandidate, AllocationDecisionRow } from "./allocate";
import type { AccountContext, CandidateContext } from "./types";
import type { PlaceOrderResult } from "./place";
import type { DecideResult } from "./decide";
import type { PretradeCriticResult } from "./pretrade-critic";

const asJson = <T,>(value: T) => value as unknown;
const asNullableJson = <T,>(value: T | null) => value as unknown;

type AnyPrisma = Record<string, unknown>;
const p = prisma as unknown as AnyPrisma;
const delegate = (name: string) => p[name] as {
  create?: (args: unknown) => Promise<unknown>;
  upsert?: (args: unknown) => Promise<unknown>;
  update?: (args: unknown) => Promise<unknown>;
  updateMany?: (args: unknown) => Promise<unknown>;
  findUnique?: (args: unknown) => Promise<unknown>;
} | undefined;

export interface PersistDecisionInputs {
  candidateContext: CandidateContext;
  account: AccountContext;
  allocationRow: AllocationDecisionRow;
  decideResult: DecideResult;
  critic: PretradeCriticResult;
  placement: PlaceOrderResult | null;
  tradingMode: "PAPER" | "LIVE";
}

/**
 * Persist the full decision trail for a single (candidate, account):
 *  - ExecutionDecision (action, reasons, accountId, riskLimit version)
 *  - Order (if action=PLACE) — with accountId + clientOrderId
 *  - Position (if filled)
 *  - RiskEvent for each hard rule that failed
 *  - AuditLog rollup + one row per structured blocker
 *  - RuleViolation entries (ledger)
 *
 * All writes go through the Prisma client under an `unknown` cast
 * because the multi-account delegates aren't generated yet. Once the
 * user runs `prisma generate` these casts become no-ops.
 */
export const persistDecision = async (inputs: PersistDecisionInputs): Promise<string> => {
  const { candidateContext, account, allocationRow, decideResult, critic, placement, tradingMode } = inputs;
  const { decision } = decideResult;

  const idempotencyKey = stableHash({
    candidateId: candidateContext.dbIds.candidateId,
    accountId: account.accountId,
    status: candidateContext.candidate.status,
    actionWindow: new Date().toISOString().slice(0, 13),
  });

  // 1) ExecutionDecision
  // Guard: verify account still exists before writing the FK. The account
  // could have been deleted between context-collection and here (rare race),
  // which would cause a FK constraint violation and abort the whole pipeline.
  const accountExists = account.accountId
    ? (await (prisma as any).account?.findUnique?.({ where: { id: account.accountId }, select: { id: true } })) != null
    : false;
  const safeAccountId = accountExists ? account.accountId : null;

  let createdDecision: { id: string } | undefined;
  try {
    createdDecision = (await delegate("executionDecision")?.create?.({
      data: {
        candidateId: candidateContext.dbIds.candidateId,
        validationRunId: candidateContext.dbIds.validationRunId,
        accountId: safeAccountId,
        action: decision.action,
        confidence: decision.confidence,
        riskScore: decision.riskScore,
        evidenceSummary: decision.evidenceSummary,
        reasons: asJson(decision.reasons),
        blockingReasons: asJson(decision.blockingReasons),
        structuredReasons: asJson(decision.structuredReasons ?? []),
        supportingReferences: asJson(decision.supportingReferences),
        executionParameters: asNullableJson(decision.executionParameters),
        ruleEvaluations: asJson(allocationRow.ruleResults),
        preTradeAiReviewId: critic.aiReviewId ?? null,
        status: decision.action === "PLACE" ? "SENT" : "PROPOSED",
        mode: tradingMode,
        idempotencyKey,
        executedAt: decision.action === "PLACE" ? new Date() : null,
      },
    })) as { id: string } | undefined;
  } catch (err) {
    // FK violation can still occur in edge cases (concurrent account deletion).
    // Log it and fall back to the idempotency key so downstream writes still
    // have a stable decisionId to reference.
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("Foreign key") || msg.includes("fkey") || msg.includes("foreign_key")) {
      console.error(
        `[record] ExecutionDecision FK violation for account ${account.accountId} — persisting without accountId`,
        msg,
      );
      createdDecision = (await delegate("executionDecision")?.create?.({
        data: {
          candidateId: candidateContext.dbIds.candidateId,
          validationRunId: candidateContext.dbIds.validationRunId,
          accountId: null,
          action: decision.action,
          confidence: decision.confidence,
          riskScore: decision.riskScore,
          evidenceSummary: decision.evidenceSummary,
          reasons: asJson(decision.reasons),
          blockingReasons: asJson(decision.blockingReasons),
          structuredReasons: asJson(decision.structuredReasons ?? []),
          supportingReferences: asJson(decision.supportingReferences),
          executionParameters: asNullableJson(decision.executionParameters),
          ruleEvaluations: asJson(allocationRow.ruleResults),
          preTradeAiReviewId: critic.aiReviewId ?? null,
          status: decision.action === "PLACE" ? "SENT" : "PROPOSED",
          mode: tradingMode,
          idempotencyKey,
          executedAt: decision.action === "PLACE" ? new Date() : null,
        },
      })) as { id: string } | undefined;
    } else {
      throw err;
    }
  }
  const decisionId = createdDecision?.id ?? idempotencyKey;

  // 2) Order (on placement)
  if (placement) {
    const params = decision.executionParameters!;
    const riskUsd = account.snapshot.balance * ((decideResult.appliedSizeMultiplier * account.ruleProfile.maxRiskPerTradePct));

    await delegate("order")?.create?.({
      data: {
        symbolId: candidateContext.dbIds.symbolId,
        accountId: safeAccountId,
        integrationId: account.integrationId,
        decisionId,
        clientOrderId: placement.clientOrderId,
        broker: "mt5-adapter",
        brokerOrderId: placement.brokerOrderId,
        mode: tradingMode,
        direction: params.direction,
        orderType: "MARKET",
        quantity: params.quantity,
        entryPrice: params.entry,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        riskUsd,
        status: placement.ok ? (placement.orderStatus ?? "SUBMITTED") : "REJECTED",
        submittedAt: new Date(),
        filledAt: placement.orderStatus === "FILLED" ? new Date() : null,
        rejectedAt: placement.ok ? null : new Date(),
        errorMessage: placement.errorMessage,
        payload: asJson(placement.raw ?? {}),
      },
    });

    if (placement.ok && placement.orderStatus === "FILLED") {
      await delegate("position")?.create?.({
        data: {
          symbolId: candidateContext.dbIds.symbolId,
          accountId: safeAccountId,
          direction: params.direction,
          quantity: params.quantity,
          avgEntryPrice: params.entry,
          stopLoss: params.stopLoss,
          takeProfit: params.takeProfit,
          unrealizedPnl: 0,
          realizedPnl: 0,
          exposurePct: Number((decideResult.appliedSizeMultiplier * account.ruleProfile.maxRiskPerTradePct * 100).toFixed(2)),
          riskUsdAtEntry: riskUsd,
          currentRiskUsd: riskUsd,
          lastSupervisedAt: new Date(),
          status: "OPEN",
          openedAt: new Date(),
          metadata: asJson({
            correlationTags: candidateContext.candidate.correlationTags,
            spreadPct: candidateContext.market.spreadPct,
            aiVerdict: critic.verdict,
          }),
        },
      });

      await delegate("tradeCandidate")?.update?.({
        where: { id: candidateContext.dbIds.candidateId },
        data: { status: "EXECUTED" },
      });

      await queueNotification({
        category: "trade_event",
        severity: "info",
        title: `Trade placed: ${candidateContext.candidate.symbol} on ${account.displayName}`,
        body: `${params.direction} ${candidateContext.candidate.symbol} at ${params.entry.toFixed(2)} — risk $${riskUsd.toFixed(0)}.`,
        dedupeKey: `trade-executed-${decisionId}`,
        metadata: {
          candidateId: candidateContext.dbIds.candidateId,
          decisionId,
          accountId: account.accountId,
          spreadPct: candidateContext.market.spreadPct,
        },
      });
    }
  }

  // 3) RiskEvent for each blocking reason — per-account attribution
  if (decision.blockingReasons.length > 0) {
    await delegate("riskEvent")?.create?.({
      data: {
        accountId: safeAccountId,
        severity: decision.action === "INVALIDATE" ? "WARNING" : "INFO",
        code: allocationRow.blockingCodes[0] ?? null,
        eventType: "execution_blocked",
        message: decision.blockingReasons[0]?.detail ?? "Execution was blocked.",
        details: asJson({
          blockingReasons: decision.blockingReasons,
          ruleResults: allocationRow.ruleResults,
          accountMode: account.mode,
        }),
        blocking: true,
        candidateId: candidateContext.dbIds.candidateId,
        decisionId,
      },
    });
  }

  // 4) RuleViolation ledger entries (one per failed deterministic rule)
  // RuleViolation.accountId is non-nullable — skip if the account no longer exists in DB.
  for (const r of allocationRow.ruleResults) {
    if (r.pass) continue;
    if (!safeAccountId) continue; // can't write a RuleViolation without a valid account FK
    await delegate("ruleViolation")?.create?.({
      data: {
        accountId: safeAccountId,
        code: r.code,
        category: r.category,
        severity: r.severity,
        outcome: decision.action === "PLACE" ? "WARNED" : "BLOCKED",
        message: r.message,
        observed: asNullableJson(r.observed ?? null),
        expected: asNullableJson(r.expected ?? null),
        candidateId: candidateContext.dbIds.candidateId,
        decisionId,
      },
    });
  }

  // 5) Rollup audit log for the decision
  await delegate("auditLog")?.create?.({
    data: {
      actorType: "WORKER",
      actorId: "worker-execution",
      workerType: "EXECUTION",
      severity: decision.action === "PLACE" ? "INFO" : decision.action === "INVALIDATE" ? "WARNING" : "INFO",
      category: "execution",
      message: summarizeAction(decision, account),
      entityType: "execution_decision",
      entityId: decisionId,
      symbolId: candidateContext.dbIds.symbolId,
      data: asJson({
        accountId: account.accountId,
        accountMode: account.mode,
        action: decision.action,
        confidence: decision.confidence,
        riskScore: decision.riskScore,
        appliedSizeMultiplier: decideResult.appliedSizeMultiplier,
        criticVerdict: critic.verdict,
        criticReduceMultiplier: decideResult.criticReduceMultiplier,
        ruleSummary: allocationRow.summary,
      }),
    },
  });

  // 6) One audit row per structured blocker (makes "why was this
  //    blocked for X account" filterable in the UI).
  for (const structuredBlocker of decision.structuredBlockingReasons ?? []) {
    await delegate("auditLog")?.create?.({
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
        entityId: decisionId,
        symbolId: candidateContext.dbIds.symbolId,
        data: asJson({ accountId: account.accountId, structured: structuredBlocker }),
      },
    });
  }

  return decisionId;
};

/**
 * Persist a top-level AllocationDecision row summarizing which
 * accounts this candidate touched and which were selected.
 */
export const persistAllocationDecision = async (
  candidateAlloc: AllocationForCandidate,
  selectedAccountIds: string[],
): Promise<string | null> => {
  const status =
    candidateAlloc.selected.length === 0
      ? "SKIPPED"
      : selectedAccountIds.length === candidateAlloc.selected.length
        ? "ALLOCATED"
        : selectedAccountIds.length > 0
          ? "PARTIAL"
          : "FAILED";

  const idempotencyKey = stableHash({
    candidateId: candidateAlloc.candidateContext.dbIds.candidateId,
    setupKey: candidateAlloc.setupKey,
    policy: candidateAlloc.policy,
    selectedAccountIds,
    actionWindow: new Date().toISOString().slice(0, 13),
  });

  const data = {
    candidateId: candidateAlloc.candidateContext.dbIds.candidateId,
    policy: candidateAlloc.policy,
    setupKey: candidateAlloc.setupKey,
    status,
    selectedAccountIds: asJson(selectedAccountIds),
    summary:
      selectedAccountIds.length > 0
        ? `Selected ${selectedAccountIds.length} account(s) from ${candidateAlloc.eligible.length} eligible.`
        : `No account selected (${candidateAlloc.blocked.length} blocked, ${candidateAlloc.eligible.length} eligible).`,
    idempotencyKey,
  };

  const candidateRows = candidateAlloc.accounts.map((r) => ({
    accountId: r.account.accountId,
    selected: selectedAccountIds.includes(r.account.accountId),
    totalScore: r.fitScore,
    componentsJson: asJson(r.fitComponents),
    reasonCodes: asJson(r.blockingCodes),
    message: r.fitExplanation,
    proposedRiskUsd: Number((r.account.snapshot.balance * r.account.ruleProfile.maxRiskPerTradePct).toFixed(2)),
    proposedQuantity: null,
    proposedStopLoss: candidateAlloc.candidateContext.candidate.stopLoss,
    proposedTakeProfit: candidateAlloc.candidateContext.candidate.takeProfit,
  }));

  const allocationDelegate = delegate("allocationDecision");
  const row = (await allocationDelegate?.upsert?.({
    where: { idempotencyKey },
    update: {
      status,
      selectedAccountIds: asJson(selectedAccountIds),
      summary: data.summary,
    },
    create: {
      ...data,
      candidates: {
        create: candidateRows,
      },
    },
  }) ?? await allocationDelegate?.create?.({
    data: {
      ...data,
      candidates: {
        create: candidateRows,
      },
    },
  })) as { id: string } | undefined;
  return row?.id ?? null;
};

const summarizeAction = (decision: StructuredDecision, account: AccountContext): string => {
  const parts = [`${decision.action}`, account.displayName, `(${account.mode})`];
  if (decision.action === "PLACE" && decision.executionParameters) {
    parts.push(
      `${decision.executionParameters.direction} ${decision.executionParameters.symbol} qty=${decision.executionParameters.quantity}`,
    );
  }
  return parts.join(" ");
};

/**
 * Build a rollup DecisionRecord (stable code) mirroring the
 * pipeline outcome. Currently unused in persistence but kept here
 * so Phase G's API can display it.
 */
export const buildOutcomeRecord = (decision: StructuredDecision, _account: AccountContext) => {
  const code =
    decision.action === "PLACE"
      ? DECISION_CODES.EXECUTION_ENTERED
      : decision.action === "INVALIDATE"
        ? DECISION_CODES.EXECUTION_INVALIDATED
        : decision.action === "SKIP"
          ? DECISION_CODES.EXECUTION_SKIPPED
          : DECISION_CODES.EXECUTION_HELD;
  return buildDecisionRecord(code, {
    symbol: decision.executionParameters?.symbol ?? "",
    confidence: decision.confidence,
    riskScore: decision.riskScore,
    observed: {
      action: decision.action,
      blockingReasonCount: decision.blockingReasons.length,
    },
  });
};
