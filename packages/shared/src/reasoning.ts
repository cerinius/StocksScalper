/**
 * Structured reason codes and decision-journal helpers.
 *
 * Every non-trivial decision made by the platform (an idea being created,
 * a validation passing or failing, an execution being skipped, a risk block
 * firing, etc.) should be recorded using a {@link DecisionRecord} built via
 * {@link buildDecisionRecord}.
 *
 * The goal is that a human reviewer looking at any row in the audit trail
 * can answer, without reading code:
 *
 *   1. What happened?            -> `title`
 *   2. Why did it happen?        -> `explanation` + `rule`
 *   3. What numbers were seen?   -> `observed`
 *   4. What would have been ok?  -> `expected`
 *   5. What would fix it?        -> `remediation`
 *
 * The catalogue below is the single source of truth for reason codes.
 * Adding a new code here is intentional: it forces the author to supply
 * a human-readable title and explanation up front.
 */

export type DecisionSeverity = "info" | "notice" | "warning" | "critical";

export type DecisionCategory =
  | "idea"
  | "validation"
  | "execution"
  | "risk"
  | "broker"
  | "session"
  | "data"
  | "system";

/**
 * Every machine-readable reason code the platform can record.
 * These strings are stable: persisted data and tests reference them.
 */
export const DECISION_CODES = {
  // Idea lifecycle
  IDEA_CREATED: "idea.created",
  IDEA_DUPLICATE_HOUR: "idea.duplicate_hour",
  IDEA_CONFLUENCE_BELOW_THRESHOLD: "idea.confluence_below_threshold",
  IDEA_NO_AGREEMENT: "idea.no_group_agreement",

  // Validation lifecycle
  VALIDATION_PASSED: "validation.passed",
  VALIDATION_FAILED_SCORE: "validation.failed_score",
  VALIDATION_FAILED_SAMPLE: "validation.failed_sample",
  VALIDATION_FAILED_EXPECTANCY: "validation.failed_expectancy",
  VALIDATION_STALE: "validation.stale",
  VALIDATION_SYNTHETIC_FALLBACK: "validation.synthetic_fallback",

  // Execution outcomes
  EXECUTION_ENTERED: "execution.entered",
  EXECUTION_SKIPPED: "execution.skipped",
  EXECUTION_HELD: "execution.held",
  EXECUTION_INVALIDATED: "execution.invalidated",
  EXECUTION_MANUAL_APPROVAL: "execution.manual_approval",

  // Risk blocks
  RISK_KILL_SWITCH: "risk.kill_switch",
  RISK_DAILY_LOSS: "risk.daily_loss",
  RISK_MAX_ACTIVE_TRADES: "risk.max_active_trades",
  RISK_TOTAL_EXPOSURE: "risk.total_exposure",
  RISK_SYMBOL_EXPOSURE: "risk.symbol_exposure",
  RISK_CORRELATED_EXPOSURE: "risk.correlated_exposure",
  RISK_RR_NOT_ACCEPTABLE: "risk.rr_not_acceptable",
  RISK_VOLATILITY_TOO_HIGH: "risk.volatility_too_high",
  RISK_LIQUIDITY_POOR: "risk.liquidity_poor",
  RISK_CONFIDENCE_BELOW_THRESHOLD: "risk.confidence_below_threshold",
  RISK_DUPLICATE_SIGNAL: "risk.duplicate_signal",
  RISK_COOLDOWN_ACTIVE: "risk.cooldown_active",
  RISK_HIGHER_TIMEFRAME_DISAGREES: "risk.higher_timeframe_disagrees",
  RISK_CONFLICTING_SIGNAL: "risk.conflicting_signal",

  // Session / environment
  SESSION_BLOCKED: "session.blocked",
  REGIME_BLOCKED: "regime.blocked",
  SPREAD_TOO_WIDE: "spread.too_wide",
  SIGNAL_STALE: "signal.stale",
  MISSING_TRIGGER_CONFIRMATION: "signal.missing_trigger",

  // Broker / order
  ORDER_REJECTED_BROKER: "broker.order_rejected",
  ORDER_CANCELLED: "broker.order_cancelled",
  ORDER_TIMEOUT: "broker.order_timeout",
  ORDER_AUTO_CLOSE: "broker.auto_close",
} as const;

export type DecisionCode = (typeof DECISION_CODES)[keyof typeof DECISION_CODES];

export interface ReasonCatalogEntry {
  code: DecisionCode;
  category: DecisionCategory;
  severity: DecisionSeverity;
  /** Short (<=6 words) title suitable for a pill or table cell. */
  title: string;
  /** One-sentence plain-English description (no jargon, no numbers). */
  summary: string;
  /** Short hint describing what would be needed for a different outcome. */
  remediation?: string;
  /** Whether this code is something an end-user should be shown vs internal-only. */
  userFacing: boolean;
}

const catalog: Record<DecisionCode, ReasonCatalogEntry> = {
  [DECISION_CODES.IDEA_CREATED]: {
    code: DECISION_CODES.IDEA_CREATED,
    category: "idea",
    severity: "info",
    title: "Idea recorded",
    summary: "A new candidate setup was detected and stored for validation.",
    userFacing: true,
  },
  [DECISION_CODES.IDEA_DUPLICATE_HOUR]: {
    code: DECISION_CODES.IDEA_DUPLICATE_HOUR,
    category: "idea",
    severity: "notice",
    title: "Duplicate within the same hour",
    summary: "A very similar setup was already recorded in the last hour, so this one was skipped to avoid double-counting.",
    remediation: "Wait for the next hour bucket or adjust the dedupe window.",
    userFacing: false,
  },
  [DECISION_CODES.IDEA_CONFLUENCE_BELOW_THRESHOLD]: {
    code: DECISION_CODES.IDEA_CONFLUENCE_BELOW_THRESHOLD,
    category: "idea",
    severity: "info",
    title: "Setup confluence too low",
    summary: "Not enough independent signals agreed on direction, so the setup was not turned into an idea.",
    remediation: "Wait for additional confirmation or relax the confluence threshold.",
    userFacing: true,
  },
  [DECISION_CODES.IDEA_NO_AGREEMENT]: {
    code: DECISION_CODES.IDEA_NO_AGREEMENT,
    category: "idea",
    severity: "info",
    title: "Signal groups disagree",
    summary: "Indicator families disagreed on the most likely direction, so no idea was generated.",
    userFacing: true,
  },

  [DECISION_CODES.VALIDATION_PASSED]: {
    code: DECISION_CODES.VALIDATION_PASSED,
    category: "validation",
    severity: "info",
    title: "Validation passed",
    summary: "Historical analogs supported this setup with enough quality and sample size.",
    userFacing: true,
  },
  [DECISION_CODES.VALIDATION_FAILED_SCORE]: {
    code: DECISION_CODES.VALIDATION_FAILED_SCORE,
    category: "validation",
    severity: "warning",
    title: "Validation score too low",
    summary: "Historical analogs were not convincing enough to clear the validation bar.",
    remediation: "Wait for a cleaner setup or reduce the minimum validation score.",
    userFacing: true,
  },
  [DECISION_CODES.VALIDATION_FAILED_SAMPLE]: {
    code: DECISION_CODES.VALIDATION_FAILED_SAMPLE,
    category: "validation",
    severity: "warning",
    title: "Not enough historical analogs",
    summary: "We could not find enough real past situations similar to this one to trust the outcome.",
    remediation: "Expand the history window or accept a smaller sample with lower confidence.",
    userFacing: true,
  },
  [DECISION_CODES.VALIDATION_FAILED_EXPECTANCY]: {
    code: DECISION_CODES.VALIDATION_FAILED_EXPECTANCY,
    category: "validation",
    severity: "warning",
    title: "Expected value too low",
    summary: "Even when it worked in the past, the average return per unit of risk was not high enough.",
    userFacing: true,
  },
  [DECISION_CODES.VALIDATION_STALE]: {
    code: DECISION_CODES.VALIDATION_STALE,
    category: "validation",
    severity: "notice",
    title: "Validation is stale",
    summary: "Underlying market data has moved since this was validated; a fresh run is needed.",
    remediation: "Re-run validation for this candidate.",
    userFacing: true,
  },
  [DECISION_CODES.VALIDATION_SYNTHETIC_FALLBACK]: {
    code: DECISION_CODES.VALIDATION_SYNTHETIC_FALLBACK,
    category: "validation",
    severity: "warning",
    title: "Synthetic analogs used",
    summary: "Too few real historical analogs were available, so modeled (synthetic) outcomes were used as a fallback. Treat the confidence as reduced.",
    userFacing: true,
  },

  [DECISION_CODES.EXECUTION_ENTERED]: {
    code: DECISION_CODES.EXECUTION_ENTERED,
    category: "execution",
    severity: "info",
    title: "Order submitted",
    summary: "All quality and risk checks passed, and an order was sent to the broker.",
    userFacing: true,
  },
  [DECISION_CODES.EXECUTION_SKIPPED]: {
    code: DECISION_CODES.EXECUTION_SKIPPED,
    category: "execution",
    severity: "notice",
    title: "Execution skipped",
    summary: "One or more pre-trade checks prevented an entry on this candidate.",
    userFacing: true,
  },
  [DECISION_CODES.EXECUTION_HELD]: {
    code: DECISION_CODES.EXECUTION_HELD,
    category: "execution",
    severity: "info",
    title: "Holding for confirmation",
    summary: "The setup is valid but did not cross the threshold for automatic entry; it is being monitored.",
    userFacing: true,
  },
  [DECISION_CODES.EXECUTION_INVALIDATED]: {
    code: DECISION_CODES.EXECUTION_INVALIDATED,
    category: "execution",
    severity: "warning",
    title: "Setup invalidated",
    summary: "The setup aged past its useful window or a precondition broke, so it will not be entered.",
    userFacing: true,
  },
  [DECISION_CODES.EXECUTION_MANUAL_APPROVAL]: {
    code: DECISION_CODES.EXECUTION_MANUAL_APPROVAL,
    category: "execution",
    severity: "info",
    title: "Waiting for approval",
    summary: "Manual approval mode is on; this idea needs an operator to authorise the trade.",
    userFacing: true,
  },

  [DECISION_CODES.RISK_KILL_SWITCH]: {
    code: DECISION_CODES.RISK_KILL_SWITCH,
    category: "risk",
    severity: "critical",
    title: "Kill switch active",
    summary: "Trading is globally paused. No new entries will be taken.",
    remediation: "Clear the kill switch from the control panel.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_DAILY_LOSS]: {
    code: DECISION_CODES.RISK_DAILY_LOSS,
    category: "risk",
    severity: "critical",
    title: "Daily loss limit hit",
    summary: "Account drawdown for today crossed the configured cap.",
    remediation: "Wait for the next trading day or raise the daily loss cap.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_MAX_ACTIVE_TRADES]: {
    code: DECISION_CODES.RISK_MAX_ACTIVE_TRADES,
    category: "risk",
    severity: "notice",
    title: "Max open trades reached",
    summary: "The portfolio is already holding the maximum allowed number of positions.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_TOTAL_EXPOSURE]: {
    code: DECISION_CODES.RISK_TOTAL_EXPOSURE,
    category: "risk",
    severity: "warning",
    title: "Portfolio exposure too high",
    summary: "Total exposure across open positions is above the configured ceiling.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_SYMBOL_EXPOSURE]: {
    code: DECISION_CODES.RISK_SYMBOL_EXPOSURE,
    category: "risk",
    severity: "warning",
    title: "Symbol exposure capped",
    summary: "We already carry the maximum allowed exposure in this symbol.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_CORRELATED_EXPOSURE]: {
    code: DECISION_CODES.RISK_CORRELATED_EXPOSURE,
    category: "risk",
    severity: "warning",
    title: "Correlated exposure too high",
    summary: "Existing positions are already heavily exposed to the same correlation bucket as this idea.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_RR_NOT_ACCEPTABLE]: {
    code: DECISION_CODES.RISK_RR_NOT_ACCEPTABLE,
    category: "risk",
    severity: "warning",
    title: "Risk / reward not acceptable",
    summary: "The distance to the stop was too large compared to the target for this setup to be worth taking.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_VOLATILITY_TOO_HIGH]: {
    code: DECISION_CODES.RISK_VOLATILITY_TOO_HIGH,
    category: "risk",
    severity: "warning",
    title: "Volatility too high",
    summary: "Market volatility is above the safe band for this strategy, so entries are paused.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_LIQUIDITY_POOR]: {
    code: DECISION_CODES.RISK_LIQUIDITY_POOR,
    category: "risk",
    severity: "warning",
    title: "Liquidity conditions poor",
    summary: "Recent volume and spread suggest the symbol is not liquid enough to enter cleanly.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_CONFIDENCE_BELOW_THRESHOLD]: {
    code: DECISION_CODES.RISK_CONFIDENCE_BELOW_THRESHOLD,
    category: "risk",
    severity: "notice",
    title: "Confidence below threshold",
    summary: "Combined setup and validation confidence did not clear the bar for an automatic entry.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_DUPLICATE_SIGNAL]: {
    code: DECISION_CODES.RISK_DUPLICATE_SIGNAL,
    category: "risk",
    severity: "notice",
    title: "Duplicate signal",
    summary: "A very similar entry was already taken or queued recently. Skipping to avoid over-concentration.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_COOLDOWN_ACTIVE]: {
    code: DECISION_CODES.RISK_COOLDOWN_ACTIVE,
    category: "risk",
    severity: "notice",
    title: "Cooldown active",
    summary: "A recent loss or event triggered a cooldown window; new entries are paused for the remainder.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_HIGHER_TIMEFRAME_DISAGREES]: {
    code: DECISION_CODES.RISK_HIGHER_TIMEFRAME_DISAGREES,
    category: "risk",
    severity: "notice",
    title: "Higher timeframe disagrees",
    summary: "The trend on the higher timeframe points the other way, so this setup is treated as counter-trend.",
    userFacing: true,
  },
  [DECISION_CODES.RISK_CONFLICTING_SIGNAL]: {
    code: DECISION_CODES.RISK_CONFLICTING_SIGNAL,
    category: "risk",
    severity: "notice",
    title: "Conflicting signal",
    summary: "Another indicator family contradicts this setup. Entry is held until the conflict clears.",
    userFacing: true,
  },

  [DECISION_CODES.SESSION_BLOCKED]: {
    code: DECISION_CODES.SESSION_BLOCKED,
    category: "session",
    severity: "notice",
    title: "Outside trading window",
    summary: "The current session is outside the allowed trading window for this strategy.",
    userFacing: true,
  },
  [DECISION_CODES.REGIME_BLOCKED]: {
    code: DECISION_CODES.REGIME_BLOCKED,
    category: "session",
    severity: "notice",
    title: "Unfavourable regime",
    summary: "The detected market regime is not one this strategy is approved to trade.",
    userFacing: true,
  },
  [DECISION_CODES.SPREAD_TOO_WIDE]: {
    code: DECISION_CODES.SPREAD_TOO_WIDE,
    category: "execution",
    severity: "warning",
    title: "Spread too wide",
    summary: "The bid / ask spread is too wide for this entry to be cost-effective.",
    userFacing: true,
  },
  [DECISION_CODES.SIGNAL_STALE]: {
    code: DECISION_CODES.SIGNAL_STALE,
    category: "execution",
    severity: "warning",
    title: "Signal is stale",
    summary: "The candidate is older than its useful lifetime and can no longer be entered safely.",
    userFacing: true,
  },
  [DECISION_CODES.MISSING_TRIGGER_CONFIRMATION]: {
    code: DECISION_CODES.MISSING_TRIGGER_CONFIRMATION,
    category: "execution",
    severity: "info",
    title: "Waiting for trigger",
    summary: "The setup is valid, but the specific trigger condition that arms the entry has not fired yet.",
    userFacing: true,
  },

  [DECISION_CODES.ORDER_REJECTED_BROKER]: {
    code: DECISION_CODES.ORDER_REJECTED_BROKER,
    category: "broker",
    severity: "critical",
    title: "Broker rejected the order",
    summary: "The broker refused the order. Common causes: margin, contract size, or instrument restrictions.",
    userFacing: true,
  },
  [DECISION_CODES.ORDER_CANCELLED]: {
    code: DECISION_CODES.ORDER_CANCELLED,
    category: "broker",
    severity: "warning",
    title: "Order cancelled",
    summary: "The order was cancelled before it was filled.",
    userFacing: true,
  },
  [DECISION_CODES.ORDER_TIMEOUT]: {
    code: DECISION_CODES.ORDER_TIMEOUT,
    category: "broker",
    severity: "warning",
    title: "Order timed out",
    summary: "The broker did not respond in time and the order was abandoned.",
    userFacing: true,
  },
  [DECISION_CODES.ORDER_AUTO_CLOSE]: {
    code: DECISION_CODES.ORDER_AUTO_CLOSE,
    category: "broker",
    severity: "info",
    title: "Position auto-closed",
    summary: "A protective rule closed the position automatically.",
    userFacing: true,
  },
};

export const getReasonCatalogEntry = (code: string): ReasonCatalogEntry | null =>
  (catalog as Record<string, ReasonCatalogEntry>)[code] ?? null;

export const listReasonCatalog = (): ReasonCatalogEntry[] => Object.values(catalog);

/**
 * A structured, human-readable record of a single decision, reason, or event.
 *
 * This is what you write to the AuditLog `data` column, to a validation
 * `reasonsFor` / `reasonsAgainst` entry, and to an execution decision's
 * `reasons` / `blockingReasons` field. Keep it stable — treat the shape as
 * part of the API contract.
 */
export interface DecisionRecord {
  code: DecisionCode;
  category: DecisionCategory;
  severity: DecisionSeverity;
  title: string;
  explanation: string;
  rule?: string;
  observed?: Record<string, number | string | boolean | null>;
  expected?: Record<string, number | string | boolean | null>;
  remediation?: string;
  tags: string[];
  userFacing: boolean;
  symbol?: string;
  strategy?: string;
  timeframe?: string;
  confidence?: number;
  riskScore?: number;
  parentIdeaId?: string;
  parentValidationId?: string;
  parentExecutionId?: string;
  at: string;
}

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? value.toString() : value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
};

/**
 * Turn a map of observed-vs-expected values into a single readable sentence,
 * e.g. "observed score 59.7 vs required 65; observed sample 14 vs required 30."
 */
export const describeObservation = (
  observed: DecisionRecord["observed"],
  expected: DecisionRecord["expected"],
): string => {
  if (!observed || Object.keys(observed).length === 0) return "";
  const parts: string[] = [];
  for (const key of Object.keys(observed)) {
    const left = formatValue(observed[key]);
    const right = expected && key in expected ? formatValue(expected[key]) : null;
    parts.push(right === null ? `${key} ${left}` : `${key} ${left} (needed ${right})`);
  }
  return parts.join("; ");
};

/**
 * Build a DecisionRecord from a known code. The catalog provides sane defaults
 * for title / explanation / severity; callers supply the concrete numbers.
 */
export const buildDecisionRecord = (
  code: DecisionCode,
  extras: Partial<Omit<DecisionRecord, "code" | "category" | "severity" | "title" | "explanation" | "tags" | "userFacing" | "at">> & {
    /** Override the catalog title, for example to say "Validation passed for BTCUSD". */
    title?: string;
    /** Extra sentence appended to the catalog summary. */
    detail?: string;
    tags?: string[];
    at?: string;
  } = {},
): DecisionRecord => {
  const entry = getReasonCatalogEntry(code);
  if (!entry) {
    throw new Error(`Unknown decision code: ${code}`);
  }

  const observationSentence = describeObservation(extras.observed, extras.expected);
  const explanationParts = [entry.summary];
  if (extras.detail) explanationParts.push(extras.detail);
  if (observationSentence) explanationParts.push(`Details: ${observationSentence}.`);

  return {
    code,
    category: entry.category,
    severity: entry.severity,
    title: extras.title ?? entry.title,
    explanation: explanationParts.join(" "),
    rule: extras.rule,
    observed: extras.observed,
    expected: extras.expected,
    remediation: extras.remediation ?? entry.remediation,
    tags: extras.tags ?? [entry.category, code],
    userFacing: entry.userFacing,
    symbol: extras.symbol,
    strategy: extras.strategy,
    timeframe: extras.timeframe,
    confidence: extras.confidence,
    riskScore: extras.riskScore,
    parentIdeaId: extras.parentIdeaId,
    parentValidationId: extras.parentValidationId,
    parentExecutionId: extras.parentExecutionId,
    at: extras.at ?? new Date().toISOString(),
  };
};

/** Render a DecisionRecord as a single-line human-readable string. */
export const renderDecisionLine = (record: DecisionRecord): string => {
  const where = [record.symbol, record.timeframe, record.strategy].filter(Boolean).join(" · ");
  const base = where ? `${record.title} — ${where}` : record.title;
  const obs = describeObservation(record.observed, record.expected);
  return obs ? `${base}. ${obs}.` : `${base}.`;
};
