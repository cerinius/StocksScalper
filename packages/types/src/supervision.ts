import { z } from "zod";

/**
 * Actions the deterministic supervisor (not the AI) may take on open
 * positions. AI can only propose these via advisory review.
 */
export const supervisionActions = [
  "HOLD",
  "TIGHTEN_STOP",
  "MOVE_TO_BREAKEVEN",
  "SCALE_OUT",
  "CLOSE",
  "FORCE_CLOSE_BREACH",
  "BLOCK_NEW_TRADES",
  "LOCK_ACCOUNT",
  "ENABLE_CAUTIOUS",
  "ENABLE_RECOVERY",
  "ENABLE_PAYOUT_PROTECT",
] as const;
export type SupervisionAction = (typeof supervisionActions)[number];

export const supervisionActionOriginSchema = z.enum(["DETERMINISTIC", "AI_SUGGESTED", "MANUAL"]);
export type SupervisionActionOrigin = z.infer<typeof supervisionActionOriginSchema>;

/**
 * Single supervisor tick output — one per open position per cycle.
 */
export const positionSupervisionTickSchema = z.object({
  positionId: z.string(),
  accountId: z.string(),
  symbol: z.string(),
  asOf: z.string(),
  unrealizedPnlPct: z.number(),
  adversePct: z.number(), // max adverse excursion since open, %
  timeInTradeMinutes: z.number().int().nonnegative(),
  invalidationTriggered: z.boolean(),
  suggestedAction: z.enum(supervisionActions),
  origin: supervisionActionOriginSchema,
  reasonCodes: z.array(z.string()),
  reasonSummary: z.string(),
  aiAdvisoryVerdict: z.string().nullable(),
  aiAdvisoryReasoning: z.string().nullable(),
  executed: z.boolean(),
  executedAt: z.string().nullable(),
});
export type PositionSupervisionTick = z.infer<typeof positionSupervisionTickSchema>;

/**
 * Health snapshot for an individual worker or the whole pipeline.
 * Consumed by the supervisor to auto-flag pipeline degradation.
 */
export const pipelineHealthReasonCodes = [
  "WORKER_STALE",
  "WORKER_HIGH_LAG",
  "WORKER_REPEATED_FAILURES",
  "QUEUE_BACKLOG_HIGH",
  "MT5_BRIDGE_STALE",
  "MT5_BRIDGE_DISCONNECTED",
  "POSITION_DRIFT_DETECTED",
  "NEWS_PIPELINE_STALE",
  "DB_LATENCY_HIGH",
  "REDIS_LATENCY_HIGH",
  "AI_CRITIC_STALE",
  "DISK_LOW",
  "SYSTEM_OK",
] as const;
export type PipelineHealthReasonCode = (typeof pipelineHealthReasonCodes)[number];
