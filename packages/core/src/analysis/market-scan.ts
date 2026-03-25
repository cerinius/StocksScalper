import type { NewsIntelligenceRecord, PriceBar, Timeframe, TradeCandidateRecord, TradeDirection } from "@stock-radar/types";
import { buildReasoningLog, clamp, percentChange } from "@stock-radar/shared";
import { calculateIndicatorSnapshot } from "./indicators";
import { detectMarketRegime } from "./regime";

const inferDirection = (
  momentumScore: number,
  news: NewsIntelligenceRecord[],
  regimeBias: TradeDirection | "NEUTRAL",
): TradeDirection => {
  const bullishSignals = news.filter((item) => item.directionalBias === "BULLISH").length;
  const bearishSignals = news.filter((item) => item.directionalBias === "BEARISH").length;
  if (regimeBias !== "NEUTRAL" && Math.abs(bullishSignals - bearishSignals) <= 1) {
    return regimeBias;
  }
  if (bearishSignals > bullishSignals && momentumScore < 0) return "SHORT";
  return "LONG";
};

const selectStrategyType = (
  direction: TradeDirection,
  rsi14: number,
  preferredStrategy: "trend" | "mean_reversion" | "breakout" | "reversal",
) => {
  if (preferredStrategy === "breakout") {
    return direction === "LONG" ? "breakout_continuation" : "breakdown_continuation";
  }

  if (preferredStrategy === "mean_reversion") {
    return direction === "LONG" ? "vwap_reclaim" : "range_fade_short";
  }

  if (preferredStrategy === "reversal") {
    return direction === "LONG" ? "liquidity_sweep_reclaim" : "reversal_major_level";
  }

  return direction === "LONG" ? (rsi14 > 60 ? "breakout_continuation" : "trend_pullback") : "breakdown_continuation";
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
  const regime = detectMarketRegime(bars, indicatorSnapshot);
  const priceMomentumPct = percentChange(oldest.close, latest.close);
  const direction = inferDirection(indicatorSnapshot.momentumScore, relevantNews, regime.directionBias);
  const regimeAlignmentScore =
    (regime.directionBias === "NEUTRAL" ? 0 : regime.directionBias === direction ? 6 : -6) +
    regime.confidence * 0.08;
  const confluenceScore =
    indicatorSnapshot.momentumScore * 0.35 +
    indicatorSnapshot.trendStrength * 0.25 +
    (indicatorSnapshot.volumeRatio - 1) * 20 +
    relevantNews.reduce((total, item) => total + item.relevanceScore, 0) * 0.05 +
    regimeAlignmentScore;

  const setupScore = clamp(55 + confluenceScore, 1, 100);
  if (setupScore < 60) return null;

  const strategyType = selectStrategyType(direction, indicatorSnapshot.rsi14, regime.preferredStrategy);
  const currentPrice = latest.close;
  const stopDistanceMultiplier = regime.preferredStrategy === "breakout" ? 1.35 : regime.preferredStrategy === "reversal" ? 0.95 : 1.1;
  const stopDistance = Math.max(indicatorSnapshot.atr14 * stopDistanceMultiplier, currentPrice * 0.008);
  const proposedEntry = currentPrice;
  const stopLoss = direction === "LONG" ? currentPrice - stopDistance : currentPrice + stopDistance;
  const targetMultiple = regime.preferredStrategy === "breakout" ? 2.3 : regime.preferredStrategy === "mean_reversion" ? 1.6 : 1.9;
  const takeProfit = direction === "LONG" ? currentPrice + stopDistance * targetMultiple : currentPrice - stopDistance * targetMultiple;
  const riskReward = Math.abs((takeProfit - proposedEntry) / Math.max(Math.abs(proposedEntry - stopLoss), 0.0001));
  const confidenceScore = clamp(setupScore * 0.68 + Math.abs(priceMomentumPct) * 1.25 + regime.confidence * 0.18, 1, 100);
  const newsScore = relevantNews.reduce((total, item) => total + item.relevanceScore, 0);

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
      newsScore,
      regimeConfidence: regime.confidence,
      regimeBiasScore: regimeAlignmentScore,
    },
    indicatorSnapshot,
    reasoningLog: buildReasoningLog([
      {
        title: "Regime classification",
        detail: `${symbol} is currently classified as ${regime.regime} with ${regime.confidence.toFixed(
          1,
        )}% confidence. ${regime.summary}`,
        weight: clamp(regime.confidence / 100, 0.35, 0.95),
        tags: ["regime", regime.regime, regime.preferredStrategy],
      },
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
    correlationTags: [symbol.slice(0, 3), regime.regime, direction === "LONG" ? "risk_on" : "risk_off"],
    volatilityClassification: regime.regime,
  };
};
