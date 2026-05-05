import { z } from "zod";
import { tradingModes, riskStates } from "./index";

/**
 * Broker / funded-trading classification.
 * - PROP: funded / prop-firm account (FTMO, MFF, Topstep, etc.)
 * - PERSONAL: user's own live account
 * - DEMO: any demo / paper account
 */
export const accountKinds = ["PROP", "PERSONAL", "DEMO"] as const;
export type AccountKind = (typeof accountKinds)[number];

/**
 * Phase lifecycle for funded/prop accounts.
 * - EVALUATION: challenge phase 1 (pass or fail)
 * - VERIFICATION: challenge phase 2 (pass or fail)
 * - FUNDED: live funded account, payouts active
 * - PAYOUT_PROTECT: within N days of payout, extra-conservative
 * - SCALE_UP: account has been scaled up after consistent performance
 * - BREACHED: rule-violated, locked
 * - PASSED: evaluation passed, awaiting funding
 * - PERSONAL: permanent non-phased mode for personal accounts
 */
export const accountPhaseKinds = [
  "EVALUATION",
  "VERIFICATION",
  "FUNDED",
  "PAYOUT_PROTECT",
  "SCALE_UP",
  "BREACHED",
  "PASSED",
  "PERSONAL",
] as const;
export type AccountPhaseKind = (typeof accountPhaseKinds)[number];

/**
 * Runtime mode per account, derived from phase + realtime health.
 * - NORMAL: standard trading
 * - CAUTIOUS: scale down size, widen filters (near daily DD)
 * - RECOVERY: post-drawdown; only A+ setups, half size
 * - TARGET_NEAR: within X% of profit target — don't blow it
 * - PAYOUT_PROTECT: payout window approaching — defensive
 * - LOCKED: do not place new trades (breached/suspended/manual)
 */
export const accountModes = [
  "NORMAL",
  "CAUTIOUS",
  "RECOVERY",
  "TARGET_NEAR",
  "PAYOUT_PROTECT",
  "LOCKED",
] as const;
export type AccountMode = (typeof accountModes)[number];

/**
 * Rollup health status used in dashboards and allocation.
 */
export const accountHealthLevels = ["HEALTHY", "WARNING", "CRITICAL", "BREACHED"] as const;
export type AccountHealth = (typeof accountHealthLevels)[number];

/**
 * The canonical per-account rule profile — every hard rule the engine
 * cares about lives here, in dollars and percentages. This is the
 * source of truth the deterministic engine evaluates; AI can only read
 * these values, never change them.
 */
export const accountRuleProfileSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  version: z.number().int().positive(),
  isActive: z.boolean(),

  // Capital
  startingBalance: z.number().positive(),

  // Hard rules (absolute dollar values derived from % × startingBalance)
  dailyLossLimitUsd: z.number().nonnegative(),
  totalLossLimitUsd: z.number().nonnegative(),
  trailingDrawdownUsd: z.number().nonnegative().nullable(), // null if not applicable
  profitTargetUsd: z.number().nonnegative().nullable(), // null for funded accounts

  // Per-trade risk caps
  maxRiskPerTradePct: z.number().positive().max(0.1), // e.g. 0.01 for 1%
  maxRiskPerTradeUsd: z.number().positive(),
  minRiskRewardRatio: z.number().positive(), // e.g. 1.5

  // Portfolio caps
  maxOpenPositions: z.number().int().positive(),
  maxConcurrentRiskPct: z.number().positive(), // total of open position risk
  maxCorrelatedPositions: z.number().int().positive(), // per correlation group

  // Instrument / session constraints
  allowedAssetClasses: z.array(z.string()),
  forbiddenAssetClasses: z.array(z.string()),
  allowedSessions: z.array(z.string()), // e.g. ["london","newyork"]
  forbiddenSessions: z.array(z.string()),
  allowedTimeframes: z.array(z.string()),
  noTradeBeforeUtc: z.string().nullable(), // "HH:MM" — no new trades before
  noTradeAfterUtc: z.string().nullable(), // "HH:MM" — no new trades after

  // News blackout
  newsBlackoutMinutesBefore: z.number().int().nonnegative(),
  newsBlackoutMinutesAfter: z.number().int().nonnegative(),
  newsBlackoutUrgencies: z.array(z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])),

  // Weekend / holiday
  blockWeekendHold: z.boolean(),

  // Hedging
  allowHedging: z.boolean(),

  // Mode thresholds (fraction of startingBalance)
  cautiousLossFraction: z.number().min(0).max(1), // e.g. 0.5 means 50% of daily DD used
  recoveryLossFraction: z.number().min(0).max(1), // e.g. 0.75
  targetNearFraction: z.number().min(0).max(1).nullable(), // distance from target

  // Payout
  payoutEligibleAfter: z.number().int().nonnegative(), // days
  payoutProtectWindowDays: z.number().int().nonnegative(),

  // Notes
  providerName: z.string(),
  providerRulesUrl: z.string().url().nullable(),

  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AccountRuleProfile = z.infer<typeof accountRuleProfileSchema>;

/**
 * Represents a single funded/personal/demo trading account as modeled
 * in the control plane. Each Account has its own MT5 integration, its
 * own rule profile (the hard contract), and its own phase lifecycle.
 */
export const accountSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  kind: z.enum(accountKinds),
  providerName: z.string(),
  brokerAccountLogin: z.string().nullable(),
  integrationId: z.string(), // the MT5 Integration row
  currency: z.string().default("USD"),
  startingBalance: z.number().positive(),
  mode: z.enum(accountModes),
  health: z.enum(accountHealthLevels),
  isActive: z.boolean(),
  currentPhaseId: z.string().nullable(),
  activeRuleProfileId: z.string().nullable(),
  tradingMode: z.enum(tradingModes), // paper | live
  tags: z.array(z.string()).default([]),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Account = z.infer<typeof accountSchema>;

/**
 * Phase entry for an Account — there is exactly one active phase per
 * account at a time (isActive=true). Past phases are retained for
 * history.
 */
export const accountPhaseSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  kind: z.enum(accountPhaseKinds),
  isActive: z.boolean(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  // target / limits carried from the rule profile snapshot at phase start
  startingBalance: z.number().positive(),
  profitTargetUsd: z.number().nonnegative().nullable(),
  dailyLossLimitUsd: z.number().nonnegative(),
  totalLossLimitUsd: z.number().nonnegative(),
  // outcome (filled when ended)
  outcome: z.enum(["IN_PROGRESS", "PASSED", "FAILED", "WITHDRAWN"]),
  reason: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AccountPhase = z.infer<typeof accountPhaseSchema>;

/**
 * Daily rollup of per-account metrics. Populated by supervisor on a
 * daily cadence and whenever an AccountSnapshot arrives. Drives mode
 * transitions and dashboard summaries.
 */
export const accountDailyMetricSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string(), // YYYY-MM-DD (account's trading day, usually UTC)
  startingBalance: z.number(),
  startingEquity: z.number(),
  endingBalance: z.number(),
  endingEquity: z.number(),
  highWaterMark: z.number(),
  lowWaterMark: z.number(),
  realizedPnl: z.number(),
  unrealizedPnlClose: z.number(),
  totalFees: z.number(),
  tradesOpened: z.number().int().nonnegative(),
  tradesClosed: z.number().int().nonnegative(),
  winners: z.number().int().nonnegative(),
  losers: z.number().int().nonnegative(),
  dailyLossUsedPct: z.number(), // % of daily DD used
  totalLossUsedPct: z.number(), // % of total DD used
  distanceToTargetPct: z.number().nullable(),
  rulesViolated: z.array(z.string()).default([]), // RuleViolation ids
  modeEnded: z.enum(accountModes),
  healthEnded: z.enum(accountHealthLevels),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AccountDailyMetric = z.infer<typeof accountDailyMetricSchema>;

/**
 * Extended AccountSnapshot shape used across the execution path.
 * Superset of the existing AccountStateSnapshot: adds accountId,
 * phase/mode context, and distance-to-limit calculations.
 */
export const accountSnapshotExtendedSchema = z.object({
  id: z.string().optional(),
  accountId: z.string(),
  capturedAt: z.string(),
  balance: z.number(),
  equity: z.number(),
  freeMargin: z.number(),
  usedMargin: z.number(),
  marginLevel: z.number(),
  openPnl: z.number(),
  realizedPnlDaily: z.number(),
  drawdownPct: z.number(),
  maxDrawdownPct: z.number(),
  riskState: z.enum(riskStates),
  killSwitchActive: z.boolean(),
  mode: z.enum(tradingModes),
  // multi-account extensions
  accountMode: z.enum(accountModes),
  accountHealth: z.enum(accountHealthLevels),
  phaseKind: z.enum(accountPhaseKinds),
  dailyLossUsedUsd: z.number(),
  dailyLossUsedPct: z.number(),
  dailyLossRemainingUsd: z.number(),
  totalLossUsedUsd: z.number(),
  totalLossUsedPct: z.number(),
  totalLossRemainingUsd: z.number(),
  distanceToTargetUsd: z.number().nullable(),
  distanceToTargetPct: z.number().nullable(),
  consecutiveLosers: z.number().int().nonnegative(),
  openPositionCount: z.number().int().nonnegative(),
  concurrentRiskUsd: z.number().nonnegative(),
  concurrentRiskPct: z.number().nonnegative(),
});
export type AccountSnapshotExtended = z.infer<typeof accountSnapshotExtendedSchema>;

/**
 * Result of evaluating a single rule against an account snapshot +
 * proposed candidate. Deterministic — AI does not produce these.
 */
export const ruleEvaluationResultSchema = z.object({
  code: z.string(), // e.g. ACCOUNT_DAILY_DD_BREACH
  category: z.enum(["ACCOUNT", "PORTFOLIO", "CANDIDATE", "SESSION", "NEWS", "HEDGE"]),
  severity: z.enum(["info", "notice", "warning", "critical"]),
  pass: z.boolean(),
  message: z.string(),
  observed: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  expected: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  remediation: z.string().optional(),
});
export type RuleEvaluationResult = z.infer<typeof ruleEvaluationResultSchema>;

/**
 * Rule violation ledger entry — recorded every time a hard rule is hit,
 * regardless of whether a trade was blocked (audit trail for funded
 * providers).
 */
export const ruleViolationOutcomes = [
  "BLOCKED",
  "REDUCED",
  "WARNED",
  "RECORDED",
  "FORCED_CLOSE",
] as const;
export type RuleViolationOutcome = (typeof ruleViolationOutcomes)[number];
