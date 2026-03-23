import type { NewsIntelligenceRecord, PriceBar, Timeframe, TradeCandidateRecord, TradeDirection } from "@stock-radar/types";
import { buildReasoningLog, clamp, percentChange } from "@stock-radar/shared";
import { calculateIndicatorSnapshot } from "./indicators";

const classifyVolatility = (atrPct: number) => {
  if (atrPct >= 4) return "high";
  if (atrPct >= 2) return "medium";
  return "low";
};

const inferDirection = (momentumScore: number, news: NewsIntelligenceRecord[]): TradeDirection => {
  const bullishSignals = news.filter((item) => item.directionalBias === "BULLISH").length;
  const bearishSignals = news.filter((item) => item.directionalBias === "BEARISH").length;
  if (bearishSignals > bullishSignals && momentumScore < 0) return "SHORT";
  return "LONG";
};

export const analyzeMarketCandidate = (
  symbol: string,
  timeframe: Timeframe,
  bars: PriceBar[],
  relevantNews: NewsIntelligenceRecord[],
): TradeCandidateRecord | null => {
  if (bars.length < 40) return null;

  const latest = bars.at(-1);
  const oldest = bars.at(-20);
  if (!latest || !oldest) return null;

  const indicatorSnapshot = calculateIndicatorSnapshot(bars);
  const priceMomentumPct = percentChange(oldest.close, latest.close);
  const direction = inferDirection(indicatorSnapshot.momentumScore, relevantNews);
  const confluenceScore =
    indicatorSnapshot.momentumScore * 0.35 +
    indicatorSnapshot.trendStrength * 0.25 +
    (indicatorSnapshot.volumeRatio - 1) * 20 +
    relevantNews.reduce((total, item) => total + item.relevanceScore, 0) * 0.05;

  const setupScore = clamp(55 + confluenceScore, 1, 100);
  if (setupScore < 60) return null;

  const strategyType =
    direction === "LONG"
      ? indicatorSnapshot.rsi14 > 60
        ? "breakout_continuation"
        : "trend_pullback"
      : "reversal_major_level";
  const currentPrice = latest.close;
  const stopDistance = Math.max(indicatorSnapshot.atr14 * 1.1, currentPrice * 0.008);
  const proposedEntry = currentPrice;
  const stopLoss = direction === "LONG" ? currentPrice - stopDistance : currentPrice + stopDistance;
  const takeProfit = direction === "LONG" ? currentPrice + stopDistance * 1.9 : currentPrice - stopDistance * 1.9;
  const riskReward = Math.abs((takeProfit - proposedEntry) / Math.max(Math.abs(proposedEntry - stopLoss), 0.0001));
  const confidenceScore = clamp(setupScore * 0.7 + Math.abs(priceMomentumPct) * 1.4, 1, 100);

  return {
    symbol,
    timeframe,
    direction,
    strategyType,
    detectedAt: new Date().toISOString(),
    currentPrice,
    proposedEntry,
    stopLoss,
    takeProfit,
    riskReward,
    confidenceScore,
    setupScore,
    featureValues: {
      priceMomentumPct,
      atrPct: indicatorSnapshot.atrPct,
      volumeRatio: indicatorSnapshot.volumeRatio,
      trendStrength: indicatorSnapshot.trendStrength,
      newsScore: relevantNews.reduce((total, item) => total + item.relevanceScore, 0),
    },
    indicatorSnapshot,
    reasoningLog: buildReasoningLog([
      {
        title: "Trend and momentum confluence",
        detail: `Momentum scored ${indicatorSnapshot.momentumScore.toFixed(1)} with RSI ${indicatorSnapshot.rsi14.toFixed(
          1,
        )} and trend strength ${indicatorSnapshot.trendStrength.toFixed(1)}.`,
        weight: 0.74,
        tags: ["trend", timeframe],
      },
      {
        title: "Volume confirmation",
        detail: `Relative volume was ${indicatorSnapshot.volumeRatio.toFixed(2)}x over the rolling baseline.`,
        weight: 0.58,
        tags: ["volume"],
      },
      {
        title: "Context overlay",
        detail: `${relevantNews.length} relevant news item(s) were linked to ${symbol}, influencing directional confidence.`,
        weight: relevantNews.length > 0 ? 0.66 : 0.35,
        tags: ["news", direction.toLowerCase()],
      },
    ]),
    status: "NEW",
    correlationTags: [symbol.slice(0, 3), direction === "LONG" ? "risk_on" : "risk_off"],
    volatilityClassification: classifyVolatility(indicatorSnapshot.atrPct),
  };
};
