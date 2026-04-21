import type {
  AccountStateSnapshot,
  ExecutionPositionSnapshot,
  StructuredDecision,
  SupportingReference,
  TradeCandidateRecord,
  ValidationMetrics,
} from "@stock-radar/types";
import { DECISION_CODES, buildDecisionRecord, buildReasoningLog, clamp, type DecisionRecord } from "@stock-radar/shared";
import { calculateHalfKellyMultiplier } from "../risk/kelly";

export interface DecisionContext {
  candidate: TradeCandidateRecord;
  validation: ValidationMetrics | null;
  account: AccountStateSnapshot;
  openPositions: ExecutionPositionSnapshot[];
  riskLimits: {
    maxActiveTrades: number;
    maxDailyLossPct: number;
    maxRiskPerTradePct: number;
    maxTotalExposurePct: number;
    maxSymbolExposurePct: number;
    maxCorrelatedExposurePct: number;
    maxEntrySpreadPct: number;
    staleSignalSeconds: number;
    manualApprovalMode: boolean;
    dynamicRiskPerTradePct?: number;
  };
  marketContext?: {
    spreadPct?: number | null;
    correlatedExposurePct?: number;
    correlatedSymbols?: string[];
  };
  references: SupportingReference[];
}

const computePortfolioExposure = (positions: ExecutionPositionSnapshot[]) =>
  positions.reduce((total, position) => total + position.exposurePct, 0);

const computeCorrelationExposure = (positions: ExecutionPositionSnapshot[], tags: string[]) =>
  positions
    .filter((position) => position.correlationTags.some((tag) => tags.includes(tag)))
    .reduce((total, position) => total + position.exposurePct, 0);

const secondsSince = (dateValue: string) => (Date.now() - new Date(dateValue).getTime()) / 1_000;

export const makeExecutionDecision = (context: DecisionContext): StructuredDecision => {
  const { candidate, validation, account, openPositions, riskLimits, marketContext } = context;
  const blockingReasons: Array<{ title: string; detail: string; weight: number; tags: string[] }> = [];
  const structuredBlockingReasons: DecisionRecord[] = [];

  const pushBlocker = (
    legacy: { title: string; detail: string; weight: number; tags: string[] },
    structured: DecisionRecord,
  ) => {
    blockingReasons.push(legacy);
    structuredBlockingReasons.push(structured);
  };

  if (account.killSwitchActive) {
    pushBlocker(
      {
        title: "Kill switch active",
        detail: "Trading is globally paused until the kill switch is cleared.",
        weight: 1,
        tags: ["kill_switch"],
      },
      buildDecisionRecord(DECISION_CODES.RISK_KILL_SWITCH, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: { killSwitchActive: true },
      }),
    );
  }

  if (account.drawdownPct >= riskLimits.maxDailyLossPct) {
    pushBlocker(
      {
        title: "Daily loss threshold breached",
        detail: `Drawdown is ${account.drawdownPct.toFixed(2)}%, above the ${riskLimits.maxDailyLossPct.toFixed(2)}% limit.`,
        weight: 0.95,
        tags: ["drawdown"],
      },
      buildDecisionRecord(DECISION_CODES.RISK_DAILY_LOSS, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: { drawdownPct: Number(account.drawdownPct.toFixed(2)) },
        expected: { drawdownPct: Number(riskLimits.maxDailyLossPct.toFixed(2)) },
        rule: "account.drawdownPct < riskLimits.maxDailyLossPct",
      }),
    );
  }

  if (openPositions.length >= riskLimits.maxActiveTrades) {
    pushBlocker(
      {
        title: "Max active trades reached",
        detail: `${openPositions.length} positions are already open.`,
        weight: 0.82,
        tags: ["portfolio"],
      },
      buildDecisionRecord(DECISION_CODES.RISK_MAX_ACTIVE_TRADES, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: { openPositions: openPositions.length },
        expected: { openPositions: riskLimits.maxActiveTrades },
      }),
    );
  }

  const totalExposure = computePortfolioExposure(openPositions);
  if (totalExposure >= riskLimits.maxTotalExposurePct) {
    pushBlocker(
      {
        title: "Total exposure too high",
        detail: `Portfolio exposure is ${totalExposure.toFixed(2)}%, above the configured cap.`,
        weight: 0.85,
        tags: ["portfolio", "exposure"],
      },
      buildDecisionRecord(DECISION_CODES.RISK_TOTAL_EXPOSURE, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: { totalExposurePct: Number(totalExposure.toFixed(2)) },
        expected: { totalExposurePct: riskLimits.maxTotalExposurePct },
      }),
    );
  }

  const symbolExposure = openPositions
    .filter((position) => position.symbol === candidate.symbol)
    .reduce((total, position) => total + position.exposurePct, 0);
  if (symbolExposure >= riskLimits.maxSymbolExposurePct) {
    pushBlocker(
      {
        title: "Symbol exposure cap reached",
        detail: `${candidate.symbol} already carries ${symbolExposure.toFixed(2)}% exposure.`,
        weight: 0.75,
        tags: ["symbol", candidate.symbol],
      },
      buildDecisionRecord(DECISION_CODES.RISK_SYMBOL_EXPOSURE, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: { symbolExposurePct: Number(symbolExposure.toFixed(2)) },
        expected: { symbolExposurePct: riskLimits.maxSymbolExposurePct },
      }),
    );
  }

  const tagCorrelatedExposure = computeCorrelationExposure(openPositions, candidate.correlationTags);
  const observedCorrelatedExposure = marketContext?.correlatedExposurePct ?? 0;
  const correlatedExposure = Math.max(tagCorrelatedExposure, observedCorrelatedExposure);
  if (correlatedExposure >= riskLimits.maxCorrelatedExposurePct) {
    pushBlocker(
      {
        title: "Correlated exposure too high",
        detail:
          observedCorrelatedExposure > tagCorrelatedExposure && (marketContext?.correlatedSymbols?.length ?? 0) > 0
            ? `Observed exposure against ${marketContext?.correlatedSymbols?.join(", ")} is ${correlatedExposure.toFixed(2)}%.`
            : `Correlation bucket exposure is ${correlatedExposure.toFixed(2)}%.`,
        weight: 0.76,
        tags: ["correlation"],
      },
      buildDecisionRecord(DECISION_CODES.RISK_CORRELATED_EXPOSURE, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: {
          correlatedExposurePct: Number(correlatedExposure.toFixed(2)),
          correlatedSymbols: marketContext?.correlatedSymbols?.join(",") ?? "",
        },
        expected: { correlatedExposurePct: riskLimits.maxCorrelatedExposurePct },
      }),
    );
  }

  if ((marketContext?.spreadPct ?? 0) >= riskLimits.maxEntrySpreadPct) {
    pushBlocker(
      {
        title: "Entry spread too wide",
        detail: `Estimated spread is ${marketContext?.spreadPct?.toFixed(3)}%, above the ${riskLimits.maxEntrySpreadPct.toFixed(
          3,
        )}% cap.`,
        weight: 0.78,
        tags: ["spread", "execution_cost"],
      },
      buildDecisionRecord(DECISION_CODES.SPREAD_TOO_WIDE, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: { spreadPct: Number((marketContext?.spreadPct ?? 0).toFixed(3)) },
        expected: { spreadPct: Number(riskLimits.maxEntrySpreadPct.toFixed(3)) },
      }),
    );
  }

  if (secondsSince(candidate.detectedAt) > riskLimits.staleSignalSeconds) {
    pushBlocker(
      {
        title: "Signal is stale",
        detail: `Candidate is older than ${riskLimits.staleSignalSeconds} seconds and requires a refresh.`,
        weight: 0.72,
        tags: ["stale_signal"],
      },
      buildDecisionRecord(DECISION_CODES.SIGNAL_STALE, {
        symbol: candidate.symbol,
        strategy: candidate.strategyType,
        timeframe: candidate.timeframe,
        observed: { signalAgeSeconds: Math.floor(secondsSince(candidate.detectedAt)) },
        expected: { signalAgeSeconds: riskLimits.staleSignalSeconds },
      }),
    );
  }

  const validationScore = validation?.confidenceScore ?? 0;
  const expectancy = validation?.expectancy ?? 0;
  const evidenceScore =
    candidate.setupScore * 0.35 +
    candidate.confidenceScore * 0.25 +
    validationScore * 0.3 +
    Math.max(expectancy, 0) * 12;
  const riskScore = clamp(
    account.drawdownPct * 10 + Math.max(totalExposure - 10, 0) + Math.max(correlatedExposure - 5, 0) * 1.5,
    0,
    100,
  );
  const kellyMultiplier = calculateHalfKellyMultiplier({
    winRateEstimate: validation?.winRateEstimate,
    riskReward: candidate.riskReward,
    confidenceScore: validation?.confidenceScore ?? candidate.confidenceScore,
  });
  const effectiveRiskPerTradePct = Math.min(
    riskLimits.dynamicRiskPerTradePct ?? riskLimits.maxRiskPerTradePct,
    riskLimits.maxRiskPerTradePct,
  );
  const sizedRiskPerTradePct = effectiveRiskPerTradePct * kellyMultiplier;

  const action =
    blockingReasons.length > 0
      ? secondsSince(candidate.detectedAt) > riskLimits.staleSignalSeconds
        ? "INVALIDATE"
        : "SKIP"
      : riskLimits.manualApprovalMode
        ? "HOLD"
        : evidenceScore >= 68 && expectancy >= -0.1
          ? "PLACE"
          : "HOLD";

  // Build a structured outcome record that mirrors the chosen action so the
  // audit trail, UI, and downstream consumers can render it without having
  // to re-parse free-text strings.
  const outcomeCode =
    action === "PLACE"
      ? DECISION_CODES.EXECUTION_ENTERED
      : action === "INVALIDATE"
        ? DECISION_CODES.EXECUTION_INVALIDATED
        : action === "SKIP"
          ? DECISION_CODES.EXECUTION_SKIPPED
          : riskLimits.manualApprovalMode
            ? DECISION_CODES.EXECUTION_MANUAL_APPROVAL
            : DECISION_CODES.EXECUTION_HELD;

  const outcomeRecord: DecisionRecord = buildDecisionRecord(outcomeCode, {
    symbol: candidate.symbol,
    strategy: candidate.strategyType,
    timeframe: candidate.timeframe,
    confidence: clamp(evidenceScore, 1, 100),
    riskScore,
    observed: {
      evidenceScore: Number(evidenceScore.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      openPositions: openPositions.length,
      totalExposurePct: Number(totalExposure.toFixed(2)),
      drawdownPct: Number(account.drawdownPct.toFixed(2)),
    },
    expected:
      action === "HOLD" && !riskLimits.manualApprovalMode
        ? { evidenceScore: 68, expectancy: -0.1 }
        : undefined,
  });

  // Calculate MT5 lot size correctly:
  // lotSize = riskAmount / (stopDistance × contractSize)
  // where contractSize depends on asset class
  const riskAmountUsd = account.balance * (sizedRiskPerTradePct / 100);
  const stopDistance = Math.abs((candidate.proposedEntry ?? candidate.currentPrice) - candidate.stopLoss);

  // Determine contract size per asset class
  // Forex standard lot = 100,000 units of base currency
  // Gold (XAUUSD) = 100 oz per lot
  // Crypto (BTCUSD etc) = 1 coin per lot on most MT5 brokers
  // Indices (US500 etc) = 1 point per lot
  const sym = candidate.symbol.toUpperCase();
  let contractSize: number;
  if (sym.includes("BTC") || sym.includes("ETH") || sym.includes("SOL") || sym.includes("LTC")) {
    contractSize = 1;           // Crypto: 1 lot = 1 coin
  } else if (sym.includes("XAU") || sym.includes("GOLD")) {
    contractSize = 100;         // Gold: 100 oz per lot
  } else if (sym.includes("XAG") || sym.includes("SILVER")) {
    contractSize = 5000;        // Silver: 5000 oz per lot
  } else if (sym.includes("US30") || sym.includes("US500") || sym.includes("NAS") || sym.includes("DAX") || sym.includes("SPX")) {
    contractSize = 1;           // Indices: 1 lot = 1 index unit
  } else {
    contractSize = 100_000;     // Standard forex lot
  }

  // Compute lot size, clamp to broker limits (0.01 min, 50 max)
  const rawLots = stopDistance > 0
    ? riskAmountUsd / (stopDistance * contractSize)
    : riskAmountUsd / (candidate.currentPrice * contractSize * 0.01);

  // Round to 2 decimal places (standard MT5 lot precision), clamp to safe range
  const quantity = Number(Math.max(0.01, Math.min(50, rawLots)).toFixed(2));

  return {
    action,
    confidence: clamp(evidenceScore, 1, 100),
    riskScore,
    evidenceSummary:
      action === "PLACE"
        ? "Validation, setup quality, and account state are aligned enough to allow a controlled order."
        : "One or more portfolio or quality checks prevented automatic execution.",
    reasons: buildReasoningLog([
      {
        title: "Setup quality",
        detail: `Setup scored ${candidate.setupScore.toFixed(1)} with ${candidate.confidenceScore.toFixed(1)} confidence.`,
        weight: clamp(candidate.setupScore / 100, 0.3, 0.9),
        tags: ["candidate", candidate.strategyType],
      },
      {
        title: "Validation context",
        detail: validation
          ? `Validation confidence ${validation.confidenceScore.toFixed(1)}, expectancy ${validation.expectancy.toFixed(2)}R, sample ${validation.historicalSampleSize}.`
          : "Validation data is not yet available, so the engine falls back to setup strength and risk posture.",
        weight: validation ? clamp(validation.confidenceScore / 100, 0.2, 0.9) : 0.25,
        tags: ["validation"],
      },
      {
        title: "Portfolio state",
        detail: `Account drawdown ${account.drawdownPct.toFixed(2)}%, open positions ${openPositions.length}, total exposure ${totalExposure.toFixed(
          2,
        )}%.`,
        weight: clamp(1 - riskScore / 100, 0.2, 0.9),
        tags: ["portfolio", account.riskState.toLowerCase()],
      },
      {
        title: "Position sizing",
        detail: `Sizing uses ${sizedRiskPerTradePct.toFixed(3)}% risk per trade after dynamic throttle and half-Kelly adjustment.`,
        weight: clamp(sizedRiskPerTradePct / Math.max(riskLimits.maxRiskPerTradePct, 0.01), 0.25, 0.8),
        tags: ["sizing", "kelly"],
      },
    ]),
    blockingReasons: buildReasoningLog(blockingReasons),
    structuredReasons: [outcomeRecord].map((record) => ({
      code: record.code,
      category: record.category,
      severity: record.severity,
      title: record.title,
      explanation: record.explanation,
      observed: record.observed,
      expected: record.expected,
      remediation: record.remediation,
      userFacing: record.userFacing,
      tags: record.tags,
      at: record.at,
    })),
    structuredBlockingReasons: structuredBlockingReasons.map((record) => ({
      code: record.code,
      category: record.category,
      severity: record.severity,
      title: record.title,
      explanation: record.explanation,
      observed: record.observed,
      expected: record.expected,
      remediation: record.remediation,
      userFacing: record.userFacing,
      tags: record.tags,
      at: record.at,
    })),
    supportingReferences: context.references,
    executionParameters:
      action === "PLACE"
        ? {
            symbol: candidate.symbol,
            direction: candidate.direction,
            quantity,
            entry: candidate.proposedEntry,
            stopLoss: candidate.stopLoss,
            takeProfit: candidate.takeProfit,
            timeInForce: "GTC",
          }
        : null,
    createdAt: new Date().toISOString(),
  };
};
