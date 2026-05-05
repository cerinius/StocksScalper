import { z } from "zod";
import { accountModes, accountPhaseKinds } from "./accounts";

/**
 * Allocation policy for a setup/strategy: governs how many accounts
 * a single candidate may be routed to and under what constraints.
 *
 * - ONE_ACCOUNT_ONLY: only the single best-fit account takes the trade
 * - MAX_N_ACCOUNTS: up to N accounts may take it (N from setupMaxAccounts)
 * - ALL_ELIGIBLE: every eligible account takes it
 * - CHALLENGE_ONLY: only EVALUATION/VERIFICATION accounts
 * - FUNDED_ONLY: only FUNDED accounts
 * - STRATEGY_TAGGED: use the setup's tag list to pick matching accounts
 */
export const allocationPolicies = [
  "ONE_ACCOUNT_ONLY",
  "MAX_N_ACCOUNTS",
  "ALL_ELIGIBLE",
  "CHALLENGE_ONLY",
  "FUNDED_ONLY",
  "STRATEGY_TAGGED",
] as const;
export type AllocationPolicy = (typeof allocationPolicies)[number];

/**
 * Per-candidate allocation decision status.
 */
export const allocationStatuses = [
  "PENDING",
  "ALLOCATED",
  "SKIPPED",
  "PARTIAL",
  "FAILED",
] as const;
export type AllocationStatus = (typeof allocationStatuses)[number];

/**
 * Reason code for why an individual account was or was not chosen.
 * Pure enumerations — kept alongside the generic DECISION_CODES in
 * packages/shared so the allocator's logs stay structured.
 */
export const allocationReasonCodes = [
  "ACCOUNT_LOCKED",
  "ACCOUNT_BREACHED",
  "ACCOUNT_WRONG_PHASE",
  "ACCOUNT_WRONG_KIND",
  "ACCOUNT_DAILY_DD_NEAR",
  "ACCOUNT_TOTAL_DD_NEAR",
  "ACCOUNT_SYMBOL_FORBIDDEN",
  "ACCOUNT_SESSION_FORBIDDEN",
  "ACCOUNT_HEDGE_FORBIDDEN",
  "ACCOUNT_MAX_POSITIONS",
  "ACCOUNT_CORRELATION_CAP",
  "ACCOUNT_POLICY_MISMATCH",
  "ACCOUNT_MODE_LOCKED",
  "ACCOUNT_SETUP_TAG_MISMATCH",
  "ACCOUNT_BRIDGE_STALE",
  "ACCOUNT_KILL_SWITCH",
  "ACCOUNT_ELIGIBLE",
  "ACCOUNT_SELECTED",
  "ACCOUNT_POLICY_LIMIT_REACHED",
  "ACCOUNT_DUPLICATE_POSITION",
] as const;
export type AllocationReasonCode = (typeof allocationReasonCodes)[number];

/**
 * Setup / strategy allocation policy (configured on a SystemSetting
 * row per-strategy, or via UI). Used by the allocator to decide which
 * accounts should get a given candidate.
 */
export const setupAllocationPolicySchema = z.object({
  setupKey: z.string(), // e.g. "ict-ote-london"
  policy: z.enum(allocationPolicies),
  maxAccounts: z.number().int().positive(), // used by MAX_N_ACCOUNTS
  requiredTags: z.array(z.string()).default([]),
  excludedTags: z.array(z.string()).default([]),
  allowedPhaseKinds: z.array(z.enum(accountPhaseKinds)).default([]),
  allowedAccountModes: z.array(z.enum(accountModes)).default([]),
  preferHigherHealth: z.boolean().default(true),
  preferLowerUtilization: z.boolean().default(true),
  notes: z.string().nullable(),
});
export type SetupAllocationPolicy = z.infer<typeof setupAllocationPolicySchema>;

/**
 * Per-account fit score computed during allocation. The higher, the
 * better this account "fits" the current candidate. Components are
 * exposed individually so the rationale is transparent.
 */
export const accountFitScoreSchema = z.object({
  accountId: z.string(),
  totalScore: z.number(), // 0..100
  components: z.object({
    phaseFit: z.number(), // 0..30
    healthFit: z.number(), // 0..20
    drawdownHeadroom: z.number(), // 0..20
    tagMatch: z.number(), // 0..10
    correlationHeadroom: z.number(), // 0..10
    sessionFit: z.number(), // 0..5
    riskBudgetFit: z.number(), // 0..5
  }),
  explanation: z.string(),
});
export type AccountFitScore = z.infer<typeof accountFitScoreSchema>;

/**
 * Result entry for a single account considered by the allocator.
 */
export const accountAllocationResultSchema = z.object({
  accountId: z.string(),
  selected: z.boolean(),
  fitScore: accountFitScoreSchema.nullable(),
  reasonCodes: z.array(z.enum(allocationReasonCodes)),
  message: z.string(),
  proposedRiskUsd: z.number().nullable(),
  proposedQuantity: z.number().nullable(),
  proposedStopLoss: z.number().nullable(),
  proposedTakeProfit: z.number().nullable(),
});
export type AccountAllocationResult = z.infer<typeof accountAllocationResultSchema>;

/**
 * The full allocation output for a single candidate — one of these per
 * TradeCandidate that reaches allocation.
 */
export const allocationDecisionSchema = z.object({
  id: z.string().optional(),
  candidateId: z.string(),
  policy: z.enum(allocationPolicies),
  setupKey: z.string(),
  status: z.enum(allocationStatuses),
  selectedAccountIds: z.array(z.string()),
  results: z.array(accountAllocationResultSchema),
  idempotencyKey: z.string(),
  createdAt: z.string(),
});
export type AllocationDecisionRecord = z.infer<typeof allocationDecisionSchema>;
