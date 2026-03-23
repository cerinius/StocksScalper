import type { TradeCandidateRecord, ValidationMetrics } from "@stock-radar/types";
import { average, buildReasoningLog, clamp, standardDeviation } from "@stock-radar/shared";

export interface HistoricalAnalog {
  similarity: number;
  outcomeR: number;
  returnPct: number;
  holdBars: number;
}

export interface ValidationResultBundle {
  metrics: ValidationMetrics;
  reasonsFor: ReturnType<typeof buildReasoningLog>;
  reasonsAgainst: ReturnType<typeof buildReasoningLog>;
  analogs: HistoricalAnalog[];
  finalScore: number;
}

const confidenceInterval = (values: number[]) => {
  if (values.length === 0) return { low: 0, high: 0 };
  const mean = average(values);
  const deviation = standardDeviation(values);
  const margin = values.length < 2 ? 0 : (1.96 * deviation) / Math.sqrt(values.length);
  return {
    low: mean - margin,
    high: mean + margin,
  };
};

const sumPositive = (values: number[]) => values.filter((value) => value > 0).reduce((total, value) => total + value, 0);
const sumNegative = (values: number[]) => values.filter((value) => value < 0).reduce((total, value) => total + value, 0);

export const validateCandidate = (candidate: TradeCandidateRecord, analogs: HistoricalAnalog[]): ValidationResultBundle => {
  const outcomes = analogs.map((analog) => analog.outcomeR);
  const positiveReturns = analogs.filter((analog) => analog.outcomeR > 0);
  const negativeReturns = analogs.filter((analog) => analog.outcomeR <= 0);
  const winRateEstimate = analogs.length === 0 ? 0 : positiveReturns.length / analogs.length;
  const averageReturn = average(analogs.map((analog) => analog.returnPct));
  const averageAdverseExcursion = Math.abs(average(negativeReturns.map((analog) => analog.outcomeR)));
  const averageFavorableExcursion = average(positiveReturns.map((analog) => analog.outcomeR));
  const profitFactor =
    Math.abs(sumNegative(outcomes)) < 0.0001 ? positiveReturns.length : Math.abs(sumPositive(outcomes)) / Math.abs(sumNegative(outcomes));
  const expectancy = average(outcomes);
  const interval = confidenceInterval(outcomes);
  const confidenceScore = clamp(
    candidate.confidenceScore * 0.35 +
      winRateEstimate * 40 +
      Math.max(expectancy, 0) * 18 +
      Math.min(analogs.length, 40) * 0.6,
    1,
    100,
  );
  const finalScore = clamp(confidenceScore * 0.7 + candidate.setupScore * 0.3, 1, 100);

  return {
    metrics: {
      winRateEstimate,
      averageReturn,
      averageAdverseExcursion,
      averageFavorableExcursion,
      maxDrawdown: Math.abs(Math.min(...outcomes, 0)),
      profitFactor,
      expectancy,
      confidenceScore,
      confidenceIntervalLow: interval.low,
      confidenceIntervalHigh: interval.high,
      historicalSampleSize: analogs.length,
      dataQualityNotes:
        analogs.length < 12
          ? ["Small analog sample; treat with caution."]
          : ["Analog sample size is adequate for initial rule-based validation."],
    },
    reasonsFor: buildReasoningLog([
      {
        title: "Pattern confirmation",
        detail: `Historical analog set found ${positiveReturns.length} favorable outcomes out of ${analogs.length}.`,
        weight: winRateEstimate,
        tags: ["validation", candidate.strategyType],
      },
      {
        title: "Risk reward support",
        detail: `Current candidate risk/reward is ${candidate.riskReward.toFixed(2)}R with expectancy ${expectancy.toFixed(2)}R.`,
        weight: clamp(candidate.riskReward / 3, 0.2, 0.9),
        tags: ["risk_reward"],
      },
    ]),
    reasonsAgainst: buildReasoningLog([
      {
        title: "Sample concentration",
        detail:
          analogs.length < 12
            ? "Historical analog count is thin for a confident live allocation."
            : "Loss analogs still exist and require position sizing discipline.",
        weight: analogs.length < 12 ? 0.75 : 0.45,
        tags: ["sample"],
      },
      {
        title: "Adverse excursion risk",
        detail: `Average adverse excursion measured ${averageAdverseExcursion.toFixed(2)}R.`,
        weight: clamp(averageAdverseExcursion / 3, 0.2, 0.85),
        tags: ["risk"],
      },
    ]),
    analogs,
    finalScore,
  };
};
