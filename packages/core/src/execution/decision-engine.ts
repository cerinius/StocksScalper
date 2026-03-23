import type {
  AccountStateSnapshot,
  ExecutionPositionSnapshot,
  StructuredDecision,
  SupportingReference,
  TradeCandidateRecord,
  ValidationMetrics,
} from "@stock-radar/types";
import { buildReasoningLog, clamp } from "@stock-radar/shared";

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
    staleSignalSeconds: number;
    manualApprovalMode: boolean;
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
  const { candidate, validation, account, openPositions, riskLimits } = context;
  const blockingReasons = [];

  if (account.killSwitchActive) {
    blockingReasons.push({
      title: "Kill switch active",
      detail: "Trading is globally paused until the kill switch is cleared.",
      weight: 1,
      tags: ["kill_switch"],
    });
  }

  if (account.drawdownPct >= riskLimits.maxDailyLossPct) {
    blockingReasons.push({
      title: "Daily loss threshold breached",
      detail: `Drawdown is ${account.drawdownPct.toFixed(2)}%, above the ${riskLimits.maxDailyLossPct.toFixed(2)}% limit.`,
      weight: 0.95,
      tags: ["drawdown"],
    });
  }

  if (openPositions.length >= riskLimits.maxActiveTrades) {
    blockingReasons.push({
      title: "Max active trades reached",
      detail: `${openPositions.length} positions are already open.`,
      weight: 0.82,
      tags: ["portfolio"],
    });
  }

  const totalExposure = computePortfolioExposure(openPositions);
  if (totalExposure >= riskLimits.maxTotalExposurePct) {
    blockingReasons.push({
      title: "Total exposure too high",
      detail: `Portfolio exposure is ${totalExposure.toFixed(2)}%, above the configured cap.`,
      weight: 0.85,
      tags: ["portfolio", "exposure"],
    });
  }

  const symbolExposure = openPositions
    .filter((position) => position.symbol === candidate.symbol)
    .reduce((total, position) => total + position.exposurePct, 0);
  if (symbolExposure >= riskLimits.maxSymbolExposurePct) {
    blockingReasons.push({
      title: "Symbol exposure cap reached",
      detail: `${candidate.symbol} already carries ${symbolExposure.toFixed(2)}% exposure.`,
      weight: 0.75,
      tags: ["symbol", candidate.symbol],
    });
  }

  const correlatedExposure = computeCorrelationExposure(openPositions, candidate.correlationTags);
  if (correlatedExposure >= riskLimits.maxCorrelatedExposurePct) {
    blockingReasons.push({
      title: "Correlated exposure too high",
      detail: `Correlation bucket exposure is ${correlatedExposure.toFixed(2)}%.`,
      weight: 0.76,
      tags: ["correlation"],
    });
  }

  if (secondsSince(candidate.detectedAt) > riskLimits.staleSignalSeconds) {
    blockingReasons.push({
      title: "Signal is stale",
      detail: `Candidate is older than ${riskLimits.staleSignalSeconds} seconds and requires a refresh.`,
      weight: 0.72,
      tags: ["stale_signal"],
    });
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

  const quantity = Number(((account.balance * (riskLimits.maxRiskPerTradePct / 100)) / Math.max(candidate.currentPrice * 0.01, 1)).toFixed(3));

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
    ]),
    blockingReasons: buildReasoningLog(blockingReasons),
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
