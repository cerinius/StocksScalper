import type {
  AccountRuleProfile,
  AccountSnapshotExtended,
  AccountPhaseKind,
  AccountMode,
  RuleEvaluationResult,
  TradeCandidateRecord,
  NewsIntelligenceRecord,
} from "@stock-radar/types";
import { ACCOUNT_RULE_CODES } from "./reason-codes";
import { modeMinSetupScore, modePermitsOpen } from "./modes";

export interface CandidateEvaluationContext {
  /** The account's current rule profile (frozen for this evaluation). */
  ruleProfile: AccountRuleProfile;
  /** Latest account snapshot, extended with derived metrics. */
  snapshot: AccountSnapshotExtended;
  /** Current phase kind. */
  phaseKind: AccountPhaseKind;
  /** Current mode as last computed. */
  mode: AccountMode;
  /** The candidate being evaluated. */
  candidate: TradeCandidateRecord & { id?: string; correlationGroup?: string | null; assetClass?: string | null; sessionName?: string | null };
  /** Already-open positions on THIS account. */
  openPositions: Array<{
    id: string;
    symbol: string;
    direction: "LONG" | "SHORT";
    correlationGroup: string | null;
    riskUsd: number;
  }>;
  /** Active news items relevant to the symbol. */
  news: NewsIntelligenceRecord[];
  /** Evaluation time (UTC). */
  now: Date;
  /** The proposed risk for this trade, in USD. */
  proposedRiskUsd: number;
  /** True if the bridge has been heard-from recently. */
  bridgeFresh: boolean;
}

/**
 * The deterministic evaluator. Produces a flat list of rule
 * evaluations (pass/fail) that the decision engine turns into
 * reasons, blocking reasons, and a final ExecutionDecision.
 *
 * This function is pure: same inputs → same outputs. No side
 * effects. No AI calls.
 */
export function evaluateCandidateAgainstAccount(ctx: CandidateEvaluationContext): RuleEvaluationResult[] {
  const results: RuleEvaluationResult[] = [];

  // 1. LOCKED / BREACHED guard
  if (!modePermitsOpen(ctx.mode)) {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_MODE_LOCKED, "critical",
      `Account mode is ${ctx.mode}; new trades are blocked.`,
      { mode: ctx.mode }));
    return results; // no point evaluating anything else
  }
  if (ctx.snapshot.killSwitchActive) {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_KILL_SWITCH, "critical",
      `Account kill switch is active.`, {}));
    return results;
  }
  if (ctx.phaseKind === "BREACHED") {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_BREACHED, "critical",
      `Account phase BREACHED. No new trades allowed.`, {}));
    return results;
  }

  // 2. Bridge freshness
  if (!ctx.bridgeFresh) {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_BRIDGE_STALE, "critical",
      "MT5 bridge has not reported recently. Refusing to place new orders.",
      {}));
    return results;
  }

  // 3. Drawdown guard rails (hard — these are THE funded-account rules)
  const dailyRemaining = ctx.snapshot.dailyLossRemainingUsd;
  const totalRemaining = ctx.snapshot.totalLossRemainingUsd;

  if (dailyRemaining <= 0) {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_DAILY_DD_BREACH, "critical",
      `Daily drawdown breached. Remaining=$${dailyRemaining.toFixed(2)}.`,
      { dailyLossRemainingUsd: dailyRemaining }));
    return results;
  }
  if (totalRemaining <= 0) {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_TOTAL_DD_BREACH, "critical",
      `Total drawdown breached. Remaining=$${totalRemaining.toFixed(2)}.`,
      { totalLossRemainingUsd: totalRemaining }));
    return results;
  }

  // Block if the proposed risk would push us past the hard limit.
  if (ctx.proposedRiskUsd > dailyRemaining) {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_DAILY_DD_NEAR, "critical",
      `Proposed risk $${ctx.proposedRiskUsd.toFixed(2)} exceeds remaining daily DD $${dailyRemaining.toFixed(2)}.`,
      { proposedRiskUsd: ctx.proposedRiskUsd, dailyLossRemainingUsd: dailyRemaining }));
  } else {
    results.push(pass("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_DAILY_DD_NEAR,
      `Proposed risk fits within daily DD headroom ($${dailyRemaining.toFixed(2)}).`));
  }
  if (ctx.proposedRiskUsd > totalRemaining) {
    results.push(fail("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_TOTAL_DD_NEAR, "critical",
      `Proposed risk $${ctx.proposedRiskUsd.toFixed(2)} exceeds remaining total DD $${totalRemaining.toFixed(2)}.`,
      { proposedRiskUsd: ctx.proposedRiskUsd, totalLossRemainingUsd: totalRemaining }));
  } else {
    results.push(pass("ACCOUNT", ACCOUNT_RULE_CODES.ACCOUNT_TOTAL_DD_NEAR,
      `Proposed risk fits within total DD headroom ($${totalRemaining.toFixed(2)}).`));
  }

  // 4. Per-trade risk cap
  const rp = ctx.ruleProfile;
  if (ctx.proposedRiskUsd > rp.maxRiskPerTradeUsd) {
    results.push(fail("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_RISK_TOO_HIGH, "critical",
      `Per-trade risk $${ctx.proposedRiskUsd.toFixed(2)} exceeds cap $${rp.maxRiskPerTradeUsd.toFixed(2)}.`,
      { proposedRiskUsd: ctx.proposedRiskUsd, cap: rp.maxRiskPerTradeUsd }));
  } else {
    results.push(pass("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_RISK_TOO_HIGH,
      `Per-trade risk within cap.`));
  }

  // 5. Min R:R
  if (ctx.candidate.riskReward < rp.minRiskRewardRatio) {
    results.push(fail("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_RR_TOO_LOW, "warning",
      `R:R ${ctx.candidate.riskReward.toFixed(2)} below min ${rp.minRiskRewardRatio.toFixed(2)}.`,
      { observed: ctx.candidate.riskReward, min: rp.minRiskRewardRatio }));
  } else {
    results.push(pass("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_RR_TOO_LOW,
      `R:R ${ctx.candidate.riskReward.toFixed(2)} meets minimum.`));
  }

  // 6. Setup-quality gate driven by mode
  const minScore = modeMinSetupScore(ctx.mode);
  if (ctx.candidate.setupScore < minScore) {
    results.push(fail("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_MODE_LOCKED, "warning",
      `Setup score ${ctx.candidate.setupScore.toFixed(1)} below mode (${ctx.mode}) threshold ${minScore}.`,
      { setupScore: ctx.candidate.setupScore, minScore, mode: ctx.mode }));
  }

  // 7. Max open positions
  if (ctx.openPositions.length >= rp.maxOpenPositions) {
    results.push(fail("PORTFOLIO", ACCOUNT_RULE_CODES.ACCOUNT_MAX_POSITIONS, "warning",
      `Account already holds ${ctx.openPositions.length} positions (cap=${rp.maxOpenPositions}).`,
      { openPositions: ctx.openPositions.length, cap: rp.maxOpenPositions }));
  }

  // 8. Correlation cap — per-correlation-group on this account
  const cg = ctx.candidate.correlationGroup ?? null;
  if (cg) {
    const correlated = ctx.openPositions.filter((p) => p.correlationGroup === cg);
    if (correlated.length >= rp.maxCorrelatedPositions) {
      results.push(fail("PORTFOLIO", ACCOUNT_RULE_CODES.ACCOUNT_CORRELATION_CAP, "warning",
        `Correlation group '${cg}' already at cap (${correlated.length}/${rp.maxCorrelatedPositions}).`,
        { group: cg, count: correlated.length, cap: rp.maxCorrelatedPositions }));
    }
  }

  // 9. Concurrent risk cap (sum of open-position risk as % of equity)
  const openRiskUsd = ctx.openPositions.reduce((sum, p) => sum + (p.riskUsd || 0), 0);
  const combinedRiskUsd = openRiskUsd + ctx.proposedRiskUsd;
  const equity = ctx.snapshot.equity || rp.startingBalance;
  const concurrentRiskPct = combinedRiskUsd / equity;
  if (concurrentRiskPct > rp.maxConcurrentRiskPct) {
    results.push(fail("PORTFOLIO", ACCOUNT_RULE_CODES.ACCOUNT_CONCURRENT_RISK_CAP, "warning",
      `Concurrent risk ${(concurrentRiskPct * 100).toFixed(2)}% exceeds cap ${(rp.maxConcurrentRiskPct * 100).toFixed(2)}%.`,
      { combinedRiskUsd, equity, concurrentRiskPct, cap: rp.maxConcurrentRiskPct }));
  }

  // 10. Hedge / duplicate position guard
  const sameSymbol = ctx.openPositions.filter((p) => p.symbol === ctx.candidate.symbol);
  if (sameSymbol.length > 0) {
    const sameDirection = sameSymbol.find((p) => p.direction === ctx.candidate.direction);
    const oppositeDirection = sameSymbol.find((p) => p.direction !== ctx.candidate.direction);
    if (sameDirection) {
      results.push(fail("PORTFOLIO", ACCOUNT_RULE_CODES.ACCOUNT_DUPLICATE_POSITION, "warning",
        `Account already has a ${ctx.candidate.direction} position in ${ctx.candidate.symbol}.`,
        { symbol: ctx.candidate.symbol, direction: ctx.candidate.direction }));
    }
    if (oppositeDirection && !rp.allowHedging) {
      results.push(fail("PORTFOLIO", ACCOUNT_RULE_CODES.ACCOUNT_HEDGE_FORBIDDEN, "warning",
        `Hedging is disabled but an opposite ${ctx.candidate.symbol} position exists.`,
        { symbol: ctx.candidate.symbol }));
    }
  }

  // 11. Asset class filter
  const allowedClasses = readJsonArray(rp.allowedAssetClasses);
  const forbiddenClasses = readJsonArray(rp.forbiddenAssetClasses);
  const cls = ctx.candidate.assetClass ?? null;
  if (cls) {
    if (allowedClasses.length > 0 && !allowedClasses.includes(cls)) {
      results.push(fail("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_ASSET_CLASS_FORBIDDEN, "warning",
        `Asset class ${cls} not in account's allowed list.`,
        { cls, allowed: allowedClasses.join(",") }));
    }
    if (forbiddenClasses.includes(cls)) {
      results.push(fail("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_ASSET_CLASS_FORBIDDEN, "warning",
        `Asset class ${cls} is explicitly forbidden.`,
        { cls, forbidden: forbiddenClasses.join(",") }));
    }
  }

  // 12. Session filter
  const allowedSessions = readJsonArray(rp.allowedSessions);
  const forbiddenSessions = readJsonArray(rp.forbiddenSessions);
  const session = ctx.candidate.sessionName ?? null;
  if (session) {
    if (allowedSessions.length > 0 && !allowedSessions.includes(session)) {
      results.push(fail("SESSION", ACCOUNT_RULE_CODES.ACCOUNT_SESSION_FORBIDDEN, "warning",
        `Session '${session}' not in allowed list.`,
        { session, allowed: allowedSessions.join(",") }));
    }
    if (forbiddenSessions.includes(session)) {
      results.push(fail("SESSION", ACCOUNT_RULE_CODES.ACCOUNT_SESSION_FORBIDDEN, "warning",
        `Session '${session}' is explicitly forbidden.`,
        { session }));
    }
  }

  // 13. Timeframe filter
  const allowedTimeframes = readJsonArray(rp.allowedTimeframes);
  if (allowedTimeframes.length > 0 && !allowedTimeframes.includes(ctx.candidate.timeframe)) {
    results.push(fail("CANDIDATE", ACCOUNT_RULE_CODES.ACCOUNT_TIMEFRAME_FORBIDDEN, "warning",
      `Timeframe ${ctx.candidate.timeframe} not in allowed list.`,
      { timeframe: ctx.candidate.timeframe, allowed: allowedTimeframes.join(",") }));
  }

  // 14. Time-of-day windows
  if (rp.noTradeBeforeUtc || rp.noTradeAfterUtc) {
    const hhmm = toHHMM(ctx.now);
    if (rp.noTradeBeforeUtc && hhmm < rp.noTradeBeforeUtc) {
      results.push(fail("SESSION", ACCOUNT_RULE_CODES.ACCOUNT_TIME_WINDOW_FORBIDDEN, "info",
        `Current UTC ${hhmm} before account's no-trade-before ${rp.noTradeBeforeUtc}.`,
        { hhmm, threshold: rp.noTradeBeforeUtc }));
    }
    if (rp.noTradeAfterUtc && hhmm > rp.noTradeAfterUtc) {
      results.push(fail("SESSION", ACCOUNT_RULE_CODES.ACCOUNT_TIME_WINDOW_FORBIDDEN, "info",
        `Current UTC ${hhmm} after account's no-trade-after ${rp.noTradeAfterUtc}.`,
        { hhmm, threshold: rp.noTradeAfterUtc }));
    }
  }

  // 15. News blackout
  const blackoutUrgencies = readJsonArray(rp.newsBlackoutUrgencies);
  if (blackoutUrgencies.length > 0 && (rp.newsBlackoutMinutesBefore > 0 || rp.newsBlackoutMinutesAfter > 0)) {
    const nowMs = ctx.now.getTime();
    const before = rp.newsBlackoutMinutesBefore * 60_000;
    const after = rp.newsBlackoutMinutesAfter * 60_000;
    const relevant = ctx.news.filter((n) => blackoutUrgencies.includes(n.urgency));
    for (const n of relevant) {
      const t = new Date(n.originalTimestamp).getTime();
      if (t - nowMs <= before && nowMs - t <= after) {
        results.push(fail("NEWS", ACCOUNT_RULE_CODES.ACCOUNT_NEWS_BLACKOUT, "warning",
          `Within news blackout for '${n.headline}' (${n.urgency}).`,
          { headline: n.headline, urgency: n.urgency }));
        break;
      }
    }
  }

  // 16. Weekend hold
  if (rp.blockWeekendHold) {
    const day = ctx.now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
    const hour = ctx.now.getUTCHours();
    if ((day === 5 && hour >= 20) || day === 6 || (day === 0 && hour < 22)) {
      results.push(fail("SESSION", ACCOUNT_RULE_CODES.ACCOUNT_WEEKEND_HOLD_FORBIDDEN, "warning",
        `Weekend-hold is forbidden; trading is blocked near weekend close.`,
        { day, hour }));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// helpers

function pass(
  category: RuleEvaluationResult["category"],
  code: string,
  message: string,
): RuleEvaluationResult {
  return { code, category, severity: "info", pass: true, message };
}

function fail(
  category: RuleEvaluationResult["category"],
  code: string,
  severity: RuleEvaluationResult["severity"],
  message: string,
  observed: Record<string, string | number | boolean | null> = {},
): RuleEvaluationResult {
  return { code, category, severity, pass: false, message, observed };
}

function readJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toHHMM(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Convenience: extract the blocking (non-pass) results from a rule
 * evaluation output.
 */
export function blockingResults(results: RuleEvaluationResult[]): RuleEvaluationResult[] {
  return results.filter((r) => !r.pass && (r.severity === "critical" || r.severity === "warning"));
}

/**
 * Convenience: decide the overall outcome given an array of results.
 * If any critical failure is present → BLOCK. Else if any warning →
 * DEGRADE (caller may still place but with caution). Else → OK.
 */
export function summarizeEvaluation(results: RuleEvaluationResult[]): "BLOCK" | "DEGRADE" | "OK" {
  let anyWarning = false;
  for (const r of results) {
    if (r.pass) continue;
    if (r.severity === "critical") return "BLOCK";
    if (r.severity === "warning") anyWarning = true;
  }
  return anyWarning ? "DEGRADE" : "OK";
}
