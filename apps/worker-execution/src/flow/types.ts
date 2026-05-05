import type {
  AccountMode,
  AccountRuleProfile,
  AccountSnapshotExtended,
  StructuredDecision,
  TradeCandidateRecord,
  TradeDirection,
  ValidationMetrics,
  ExecutionPositionSnapshot,
} from "@stock-radar/types";

/**
 * Lean view of an account the execution pipeline needs at runtime.
 * This is the joined projection of Account + active AccountRuleProfile
 * + most-recent AccountSnapshot + live open positions on that account.
 */
export interface AccountContext {
  accountId: string;
  displayName: string;
  kind: "PROP" | "PERSONAL" | "DEMO";
  integrationId: string;
  tradingMode: "paper" | "live";
  tags: string[];
  mode: AccountMode;
  ruleProfile: AccountRuleProfile;
  snapshot: AccountSnapshotExtended;
  openPositions: ExecutionPositionSnapshot[];
  /** consecutive losing positions at close — drives RECOVERY mode. */
  consecutiveLosers: number;
  /** bridge staleness flag — pipeline won't place on STALE bridges. */
  bridgeAllowOpen: boolean;
  bridgeAllowManage: boolean;
  bridgeReasons: string[];
}

export interface CandidateContext {
  candidate: TradeCandidateRecord;
  validation: ValidationMetrics | null;
  /** Records we want to cite in the decision's supportingReferences. */
  references: Array<{ type: string; id: string; label: string }>;
  /** DB-facing IDs we need downstream for inserts. */
  dbIds: {
    candidateId: string;
    validationRunId: string | null;
    symbolId: string;
  };
  /** Ticker-level market context (spread, correlation). */
  market: {
    spreadPct: number | null;
    correlatedExposurePct: number;
    correlatedSymbols: string[];
  };
}

/**
 * Per (candidate, account) pair outcome after rule evaluation +
 * decision engine + optional AI critic. `placed` is only true when
 * the MT5 adapter acknowledged the order.
 */
export interface PipelineDecision {
  candidateContext: CandidateContext;
  account: AccountContext;
  decision: StructuredDecision;
  ruleBlocked: boolean;
  ruleBlockingCodes: string[];
  aiReduceMultiplier: number | null;
  aiVerdict: "APPROVE" | "APPROVE_WITH_REDUCTION" | "REJECT" | "ABSTAIN" | null;
  aiReasonCodes: string[];
  placed: boolean;
}
