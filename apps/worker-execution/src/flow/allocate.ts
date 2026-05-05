import {
  evaluateCandidateAgainstAccount,
  summarizeEvaluation,
  ACCOUNT_RULE_CODES,
  blockingResults,
} from "@stock-radar/core";
import type { NewsIntelligenceRecord, RuleEvaluationResult } from "@stock-radar/types";
import type { CandidateContext, AccountContext } from "./types";

type AllocationPolicy = "ONE_ACCOUNT_ONLY" | "MAX_N_ACCOUNTS" | "ALL_ELIGIBLE" | "CHALLENGE_ONLY" | "FUNDED_ONLY" | "STRATEGY_TAGGED";

export interface SetupPolicyConfig {
  setupKey: string;
  policy: AllocationPolicy;
  maxAccounts: number;
  requiredTags: string[];
  excludedTags: string[];
  allowedPhaseKinds: string[];
  allowedAccountModes: string[];
}

/**
 * Per-candidate × per-account allocation view. `OK` accounts are
 * eligible for execution; `BLOCK` accounts are skipped with a
 * persistent RuleViolation; `DEGRADE` accounts are eligible but the
 * decision engine will apply a stricter size / quality gate.
 */
export interface AllocationDecisionRow {
  account: AccountContext;
  summary: "OK" | "BLOCK" | "DEGRADE";
  ruleResults: RuleEvaluationResult[];
  blockingCodes: string[];
  fitScore: number;
  fitComponents: {
    healthFit: number;
    modeFit: number;
    drawdownHeadroom: number;
    utilizationFit: number;
    validationFit: number;
  };
  fitExplanation: string;
}

export interface AllocationForCandidate {
  candidateContext: CandidateContext;
  setupKey: string;
  policy: AllocationPolicy;
  accounts: AllocationDecisionRow[];
  eligible: AllocationDecisionRow[]; // summary === "OK" or "DEGRADE"
  blocked: AllocationDecisionRow[];  // summary === "BLOCK"
  selected: AllocationDecisionRow[];
}

export interface AllocationInputs {
  candidates: CandidateContext[];
  accounts: AccountContext[];
  /** Active news items relevant to any of the candidate symbols. */
  news: NewsIntelligenceRecord[];
  /** Evaluation timestamp. */
  now: Date;
  /** Optional setup-level policy map keyed by strategy/setup key. */
  setupPolicies?: Record<string, SetupPolicyConfig>;
}

/**
 * For every candidate, evaluate every active account against the
 * deterministic rule engine. Returns a structured per-candidate view
 * the downstream flow can iterate over.
 *
 * This is the "wide" step of the pipeline. Actual allocation policy
 * (ONE_ACCOUNT_ONLY, MAX_N_ACCOUNTS, etc.) is applied in Phase C.
 */
export const allocateCandidates = (inputs: AllocationInputs): AllocationForCandidate[] => {
  const out: AllocationForCandidate[] = [];

  for (const candidateCtx of inputs.candidates) {
    const setupKey = (candidateCtx.candidate.strategyType || "default").trim() || "default";
    const policyConfig = inputs.setupPolicies?.[setupKey] ?? inputs.setupPolicies?.default ?? {
      setupKey,
      policy: "ONE_ACCOUNT_ONLY",
      maxAccounts: 1,
      requiredTags: [],
      excludedTags: [],
      allowedPhaseKinds: [],
      allowedAccountModes: [],
    };
    const rows: AllocationDecisionRow[] = [];

    for (const account of inputs.accounts) {
      // Bridge gate takes precedence. If we can't safely reach MT5
      // we never open a new position against this account.
      if (!account.bridgeAllowOpen) {
        rows.push({
          account,
          summary: "BLOCK",
          ruleResults: [
            {
              code: ACCOUNT_RULE_CODES.ACCOUNT_BRIDGE_STALE,
              category: "ACCOUNT",
              severity: "critical",
              pass: false,
              message: account.bridgeReasons.join("; ") || "Bridge unavailable.",
            },
          ],
          blockingCodes: [ACCOUNT_RULE_CODES.ACCOUNT_BRIDGE_STALE],
          fitScore: 0,
          fitComponents: {
            healthFit: -100,
            modeFit: -100,
            drawdownHeadroom: 0,
            utilizationFit: 0,
            validationFit: 0,
          },
          fitExplanation: account.bridgeReasons.join("; ") || "Bridge unavailable.",
        });
        continue;
      }

      // Proposed per-trade risk USD = balance × maxRiskPerTradePct,
      // clamped by the absolute maxRiskPerTradeUsd cap.
      const proposedRiskUsd = Math.min(
        account.snapshot.balance * account.ruleProfile.maxRiskPerTradePct,
        account.ruleProfile.maxRiskPerTradeUsd,
      );

      const ruleResults = evaluateCandidateAgainstAccount({
        ruleProfile: account.ruleProfile,
        snapshot: account.snapshot,
        phaseKind: account.snapshot.phaseKind,
        mode: account.mode,
        candidate: {
          ...candidateCtx.candidate,
          assetClass: inferAssetClass(candidateCtx.candidate.symbol),
        },
        openPositions: account.openPositions.map((p) => ({
          id: p.symbol, // best-effort: symbol serves as a stable id here
          symbol: p.symbol,
          direction: p.direction,
          correlationGroup: p.correlationTags[0] ?? null,
          riskUsd: 0, // hydrated in Phase D from Position.currentRiskUsd
        })),
        news: inputs.news,
        now: inputs.now,
        proposedRiskUsd,
        bridgeFresh: account.bridgeAllowOpen,
      });

      const summary = summarizeEvaluation(ruleResults);
      const blocking = blockingResults(ruleResults).map((r: RuleEvaluationResult) => r.code);
      const fit = computeFitScore(account, candidateCtx, summary);
      rows.push({
        account,
        summary,
        ruleResults,
        blockingCodes: blocking,
        fitScore: fit.score,
        fitComponents: fit.components,
        fitExplanation: fit.explanation,
      });
    }

    const eligible = rows.filter((r) => r.summary !== "BLOCK");
    const blocked = rows.filter((r) => r.summary === "BLOCK");
    const selected = applyPolicy(eligible, policyConfig, candidateCtx);

    out.push({
      candidateContext: candidateCtx,
      setupKey: policyConfig.setupKey,
      policy: policyConfig.policy,
      accounts: rows,
      eligible,
      blocked,
      selected,
    });
  }

  return out;
};

const applyPolicy = (
  eligibleRows: AllocationDecisionRow[],
  policy: SetupPolicyConfig,
  candidateCtx: CandidateContext,
): AllocationDecisionRow[] => {
  const sorted = [...eligibleRows]
    .filter((row) => policy.allowedPhaseKinds.length === 0 || policy.allowedPhaseKinds.includes(row.account.snapshot.phaseKind))
    .filter((row) => policy.allowedAccountModes.length === 0 || policy.allowedAccountModes.includes(row.account.mode))
    .filter((row) => policy.requiredTags.length === 0 || policy.requiredTags.every((tag) => row.account.tags.includes(tag)))
    .filter((row) => policy.excludedTags.length === 0 || policy.excludedTags.every((tag) => !row.account.tags.includes(tag)))
    .sort((a, b) => b.fitScore - a.fitScore);

  switch (policy.policy) {
    case "ALL_ELIGIBLE":
      return sorted;
    case "MAX_N_ACCOUNTS":
      return sorted.slice(0, Math.max(1, policy.maxAccounts));
    case "CHALLENGE_ONLY": {
      const challenge = sorted.filter((row) => row.account.snapshot.phaseKind === "EVALUATION" || row.account.snapshot.phaseKind === "VERIFICATION");
      return challenge.slice(0, Math.max(1, policy.maxAccounts));
    }
    case "FUNDED_ONLY": {
      const funded = sorted.filter((row) => row.account.snapshot.phaseKind === "FUNDED" || row.account.snapshot.phaseKind === "PAYOUT_PROTECT" || row.account.snapshot.phaseKind === "SCALE_UP");
      return funded.slice(0, Math.max(1, policy.maxAccounts));
    }
    case "STRATEGY_TAGGED": {
      const strategyKey = (candidateCtx.candidate.strategyType || "").toLowerCase();
      const tagged = sorted.filter((row) => row.account.tags.some((tag) => tag.toLowerCase() === strategyKey));
      if (tagged.length > 0) {
        return tagged.slice(0, Math.max(1, policy.maxAccounts));
      }
      return sorted.slice(0, 1);
    }
    case "ONE_ACCOUNT_ONLY":
    default:
      return sorted.slice(0, 1);
  }
};

const computeFitScore = (
  account: AccountContext,
  candidateCtx: CandidateContext,
  summary: "OK" | "BLOCK" | "DEGRADE",
): {
  score: number;
  components: {
    healthFit: number;
    modeFit: number;
    drawdownHeadroom: number;
    utilizationFit: number;
    validationFit: number;
  };
  explanation: string;
} => {
  if (summary === "BLOCK") {
    return {
      score: 0,
      components: {
        healthFit: -100,
        modeFit: -100,
        drawdownHeadroom: 0,
        utilizationFit: 0,
        validationFit: 0,
      },
      explanation: "Blocked by deterministic account rules.",
    };
  }

  const healthFit =
    account.snapshot.accountHealth === "HEALTHY"
      ? 26
      : account.snapshot.accountHealth === "WARNING"
        ? 10
        : account.snapshot.accountHealth === "CRITICAL"
          ? -30
          : -100;

  const modeFit =
    account.mode === "NORMAL"
      ? 18
      : account.mode === "CAUTIOUS"
        ? 10
        : account.mode === "TARGET_NEAR"
          ? 6
          : account.mode === "RECOVERY"
            ? -6
            : account.mode === "PAYOUT_PROTECT"
              ? -10
              : -100;

  const usedPct = Math.max(account.snapshot.dailyLossUsedPct, account.snapshot.totalLossUsedPct);
  const headroomPct = Math.max(0, 100 - usedPct);
  const drawdownHeadroom = Math.round((headroomPct / 100) * 24);

  const utilizationRatio = account.ruleProfile.maxOpenPositions > 0
    ? account.snapshot.openPositionCount / account.ruleProfile.maxOpenPositions
    : 1;
  const utilizationFit = Math.max(-16, Math.round(14 - utilizationRatio * 20));

  const validationConfidence = candidateCtx.validation?.confidenceScore ?? candidateCtx.candidate.confidenceScore;
  const validationFit = Math.round(Math.max(0, Math.min(1, validationConfidence)) * 18);

  const raw = 42 + healthFit + modeFit + drawdownHeadroom + utilizationFit + validationFit + (summary === "DEGRADE" ? -8 : 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return {
    score,
    components: {
      healthFit,
      modeFit,
      drawdownHeadroom,
      utilizationFit,
      validationFit,
    },
    explanation: `health=${healthFit}, mode=${modeFit}, headroom=${drawdownHeadroom}, utilization=${utilizationFit}, validation=${validationFit}`,
  };
};

/**
 * Coarse asset class inference from ticker. Matches the conventions
 * used in MT5 symbol tables. Phase C will push this into a proper
 * SymbolRegistry once we have per-symbol metadata rows.
 */
const inferAssetClass = (ticker: string): string => {
  const t = ticker.toUpperCase();
  if (t.includes("BTC") || t.includes("ETH") || t.includes("SOL") || t.includes("LTC")) return "CRYPTO";
  if (t.includes("XAU") || t.includes("GOLD")) return "METAL";
  if (t.includes("XAG") || t.includes("SILVER")) return "METAL";
  if (t.includes("US30") || t.includes("US500") || t.includes("NAS") || t.includes("DAX") || t.includes("SPX")) return "INDEX";
  if (/^[A-Z]{6}$/.test(t)) return "FOREX";
  return "EQUITY";
};
