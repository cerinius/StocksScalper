import {
  buildRiskLimitsFromRuleProfile,
  makeExecutionDecision,
} from "@stock-radar/core";
import type { AccountStateSnapshot, StructuredDecision } from "@stock-radar/types";
import type { AllocationDecisionRow } from "./allocate";
import type { CandidateContext } from "./types";
import type { PretradeCriticResult } from "./pretrade-critic";

export interface DecideInputs {
  candidateContext: CandidateContext;
  allocationRow: AllocationDecisionRow;
  critic: PretradeCriticResult;
  /** Global platform defaults for rules not yet promoted per-account. */
  platformDefaults: {
    maxSymbolExposurePct: number;
    maxCorrelatedExposurePct: number;
    maxEntrySpreadPct: number;
    staleSignalSeconds: number;
  };
  /** Global trading config. */
  manualApprovalMode: boolean;
}

/**
 * Run the deterministic decision engine for a single (candidate,
 * account) pair. Returns the structured decision + the effective
 * size multiplier actually applied (mode × AI reduction).
 *
 * AI safety invariant: the critic can ONLY reduce size. We clamp
 * reduceSizeMultiplier to [0, 1.0] here — any attempt to widen stops
 * or increase size would have been rejected by the AI safety filter,
 * but we double-enforce the size clamp.
 */
export interface DecideResult {
  decision: StructuredDecision;
  appliedSizeMultiplier: number;
  criticReduceMultiplier: number;
}

export const decideForAccount = (inputs: DecideInputs): DecideResult => {
  const { candidateContext, allocationRow, critic, platformDefaults, manualApprovalMode } = inputs;
  const account = allocationRow.account;

  // Clamp AI reduction to [0, 1.0]. Never allow widening.
  const criticReduce = Math.max(0, Math.min(1.0, critic.reduceSizeMultiplier));

  // Build the legacy riskLimits shape the decision engine expects.
  const limits = buildRiskLimitsFromRuleProfile({
    ruleProfile: account.ruleProfile,
    mode: account.mode,
    manualApprovalMode,
    platformDefaults,
  });
  // Apply the AI reduction on top of the mode multiplier.
  limits.dynamicRiskPerTradePct = Math.max(
    0,
    (limits.dynamicRiskPerTradePct ?? limits.maxRiskPerTradePct) * criticReduce,
  );

  // Map the account snapshot into the legacy AccountStateSnapshot shape
  // the decision engine consumes.
  const legacyAccount: AccountStateSnapshot = {
    balance: account.snapshot.balance,
    equity: account.snapshot.equity,
    freeMargin: account.snapshot.freeMargin,
    usedMargin: account.snapshot.usedMargin,
    openPnl: account.snapshot.openPnl,
    realizedPnlDaily: account.snapshot.realizedPnlDaily,
    drawdownPct: account.snapshot.drawdownPct,
    maxDrawdownPct: account.snapshot.maxDrawdownPct,
    riskState: account.snapshot.riskState,
    killSwitchActive: account.snapshot.killSwitchActive,
    mode: account.snapshot.mode,
  };

  const references: import("@stock-radar/types").SupportingReference[] = [
    ...(candidateContext.references as import("@stock-radar/types").SupportingReference[]),
    { type: "audit", id: account.accountId, label: `${account.displayName} (${account.mode})` },
    ...(critic.verdict !== "ABSTAIN"
      ? [{ type: "audit" as const, id: "pretrade-critic", label: `AI: ${critic.verdict}` }]
      : []),
  ];

  const decision = makeExecutionDecision({
    candidate: candidateContext.candidate,
    validation: candidateContext.validation,
    account: legacyAccount,
    openPositions: account.openPositions,
    riskLimits: limits,
    marketContext: candidateContext.market,
    references,
  });

  return {
    decision,
    appliedSizeMultiplier: (limits.dynamicRiskPerTradePct ?? limits.maxRiskPerTradePct) / Math.max(limits.maxRiskPerTradePct, 0.0001),
    criticReduceMultiplier: criticReduce,
  };
};
