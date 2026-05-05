/**
 * Deterministic helpers for computing "how close is this account to a
 * hard rule limit?" Used by modes.ts, health.ts, and the allocator to
 * rank accounts by headroom and to transition between modes.
 *
 * All math is in dollars (USD) and fractions (0..1).
 */

export interface DrawdownUsage {
  /** Dollars lost today vs account starting-of-day. */
  dailyLossUsd: number;
  /** Dollars drawdown from all-time equity peak (or starting balance, whichever higher). */
  totalLossUsd: number;
  /** Dollars drawdown from the trailing high-water mark, if applicable. Null means not tracked. */
  trailingDrawdownUsd: number | null;
}

export interface RuleLimits {
  dailyLossLimitUsd: number;
  totalLossLimitUsd: number;
  trailingDrawdownUsd: number | null;
  profitTargetUsd: number | null;
  startingBalance: number;
}

export interface DistanceSummary {
  /** Used / limit (0..1+). 1 = at the limit; >1 = breached. */
  dailyLossUsedPct: number;
  totalLossUsedPct: number;
  trailingLossUsedPct: number | null;

  /** Dollars remaining until hard stop. 0 = at limit; negative = breached. */
  dailyLossRemainingUsd: number;
  totalLossRemainingUsd: number;
  trailingLossRemainingUsd: number | null;

  /** Distance to profit target (0..1 fraction of balance, if target set). */
  distanceToTargetUsd: number | null;
  distanceToTargetPct: number | null;

  /** True if any hard limit has been violated. */
  dailyBreached: boolean;
  totalBreached: boolean;
  trailingBreached: boolean;
  anyBreached: boolean;
}

/**
 * Pure function: given current usage + limits, produce a flat summary
 * of how much headroom the account has.
 */
export function computeDistanceSummary(usage: DrawdownUsage, limits: RuleLimits, currentEquity: number): DistanceSummary {
  const dailyLossUsedPct = limits.dailyLossLimitUsd > 0 ? usage.dailyLossUsd / limits.dailyLossLimitUsd : 0;
  const totalLossUsedPct = limits.totalLossLimitUsd > 0 ? usage.totalLossUsd / limits.totalLossLimitUsd : 0;

  let trailingLossUsedPct: number | null = null;
  let trailingLossRemainingUsd: number | null = null;
  if (limits.trailingDrawdownUsd != null && usage.trailingDrawdownUsd != null) {
    trailingLossUsedPct = limits.trailingDrawdownUsd > 0 ? usage.trailingDrawdownUsd / limits.trailingDrawdownUsd : 0;
    trailingLossRemainingUsd = Math.max(0, limits.trailingDrawdownUsd - usage.trailingDrawdownUsd);
  }

  const dailyLossRemainingUsd = Math.max(0, limits.dailyLossLimitUsd - usage.dailyLossUsd);
  const totalLossRemainingUsd = Math.max(0, limits.totalLossLimitUsd - usage.totalLossUsd);

  let distanceToTargetUsd: number | null = null;
  let distanceToTargetPct: number | null = null;
  if (limits.profitTargetUsd != null && limits.profitTargetUsd > 0) {
    const progress = Math.max(0, currentEquity - limits.startingBalance);
    distanceToTargetUsd = Math.max(0, limits.profitTargetUsd - progress);
    distanceToTargetPct = limits.profitTargetUsd > 0 ? distanceToTargetUsd / limits.profitTargetUsd : null;
  }

  const dailyBreached = dailyLossUsedPct >= 1;
  const totalBreached = totalLossUsedPct >= 1;
  const trailingBreached = trailingLossUsedPct != null && trailingLossUsedPct >= 1;

  return {
    dailyLossUsedPct,
    totalLossUsedPct,
    trailingLossUsedPct,
    dailyLossRemainingUsd,
    totalLossRemainingUsd,
    trailingLossRemainingUsd,
    distanceToTargetUsd,
    distanceToTargetPct,
    dailyBreached,
    totalBreached,
    trailingBreached,
    anyBreached: dailyBreached || totalBreached || trailingBreached,
  };
}
