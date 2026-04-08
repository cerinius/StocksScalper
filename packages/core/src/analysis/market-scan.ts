/**
 * Market Candidate Analyser — Enhanced
 *
 * Builds trade candidates from price bars by combining:
 *   • Market regime detection (trend/mean-reversion/breakout/reversal)
 *   • Multi-indicator confluence (RSI, MACD, BB, Stoch RSI, OBV, VWAP, ADX, Williams %R, CCI)
 *   • News directional bias
 *   • Dynamic entry/stop/target sizing
 *
 * A candidate is only created when the overall confluence score clears 62/100
 * AND at least two independent signal groups agree on direction.
 */

import type { NewsIntelligenceRecord, PriceBar, Timeframe, TradeCandidateRecord, TradeDirection } from "@stock-radar/types";
import { buildReasoningLog, clamp, percentChange } from "@stock-radar/shared";
import { calculateIndicatorSnapshot } from "./indicators";
import { detectMarketRegime } from "./regime";
import { checkSessionQuality, computeDynamicTakeProfit, type AssetClass } from "./intelligence";

/** Map a symbol ticker to its broad asset class for session filtering */
const resolveAssetClass = (symbol: string): AssetClass => {
  if (/^[A-Z]{3,5}USD$/.test(symbol) && !["EURUSD","GBPUSD","AUDUSD","NZDUSD","USDCAD","USDCHF","USDJPY"].includes(symbol)) return "CRYPTO";
  if (/^[A-Z]{6}$/.test(symbol)) return "FX";
  if (["XAUUSD","XAGUSD","WTIUSD","BRENTUSD","NATGAS"].includes(symbol)) return "COMMODITY";
  if (["SPY","QQQ","IWM","DIA","VXX"].includes(symbol)) return "ETF";
  return "EQUITY";
};

// ─── Direction inference ──────────────────────────────────────────────────────

interface DirectionVote {
  direction: TradeDirection;
  weight: number;
  reason: string;
}

const inferDirectionFromIndicators = (
  ind: ReturnType<typeof calculateIndicatorSnapshot>,
  bars: PriceBar[],
  news: NewsIntelligenceRecord[],
  regimeBias: TradeDirection | "NEUTRAL",
): { direction: TradeDirection; votes: DirectionVote[]; agreement: number } => {
  const votes: DirectionVote[] = [];

  // 1. Regime bias
  if (regimeBias !== "NEUTRAL") {
    votes.push({ direction: regimeBias, weight: 2.0, reason: "Regime bias" });
  }

  // 2. Trend (EMA alignment)
  if (ind.ema21 > ind.ema50 && ind.ema21 > ind.sma20) {
    votes.push({ direction: "LONG", weight: 1.5, reason: "EMA21 > EMA50 + SMA20" });
  } else if (ind.ema21 < ind.ema50 && ind.ema21 < ind.sma20) {
    votes.push({ direction: "SHORT", weight: 1.5, reason: "EMA21 < EMA50 + SMA20" });
  }

  // 3. MACD cross/histogram
  if (ind.macdHistogram !== undefined) {
    if (ind.macd > ind.macdSignal && ind.macdHistogram > 0) {
      votes.push({ direction: "LONG", weight: 1.0, reason: "MACD bullish cross" });
    } else if (ind.macd < ind.macdSignal && ind.macdHistogram < 0) {
      votes.push({ direction: "SHORT", weight: 1.0, reason: "MACD bearish cross" });
    }
  }

  // 4. RSI momentum
  if (ind.rsi14 > 55) {
    votes.push({ direction: "LONG", weight: 0.8, reason: `RSI ${ind.rsi14.toFixed(0)} > 55` });
  } else if (ind.rsi14 < 45) {
    votes.push({ direction: "SHORT", weight: 0.8, reason: `RSI ${ind.rsi14.toFixed(0)} < 45` });
  }

  // 5. Stochastic RSI
  if (ind.stochRsiK !== undefined && ind.stochRsiD !== undefined) {
    if (ind.stochRsiK > ind.stochRsiD && ind.stochRsiK < 80) {
      votes.push({ direction: "LONG", weight: 0.7, reason: "StochRSI K crossed above D (not overbought)" });
    } else if (ind.stochRsiK < ind.stochRsiD && ind.stochRsiK > 20) {
      votes.push({ direction: "SHORT", weight: 0.7, reason: "StochRSI K crossed below D (not oversold)" });
    }
  }

  // 6. Price vs VWAP
  const latest = bars.at(-1)!;
  if (ind.vwap && ind.vwap > 0) {
    if (latest.close > ind.vwap * 1.001) {
      votes.push({ direction: "LONG", weight: 0.9, reason: "Price above VWAP" });
    } else if (latest.close < ind.vwap * 0.999) {
      votes.push({ direction: "SHORT", weight: 0.9, reason: "Price below VWAP" });
    }
  }

  // 7. Bollinger Band position
  if (ind.bbPercentB !== undefined) {
    if (ind.bbPercentB > 0.6 && ind.bbPercentB <= 1.0) {
      votes.push({ direction: "LONG", weight: 0.6, reason: `BB %B ${(ind.bbPercentB * 100).toFixed(0)}% (upper half)` });
    } else if (ind.bbPercentB < 0.4 && ind.bbPercentB >= 0) {
      votes.push({ direction: "SHORT", weight: 0.6, reason: `BB %B ${(ind.bbPercentB * 100).toFixed(0)}% (lower half)` });
    }
  }

  // 8. OBV trend (accumulation/distribution)
  if (ind.obvTrend !== undefined) {
    if (ind.obvTrend > 10) {
      votes.push({ direction: "LONG", weight: 0.8, reason: `OBV rising (trend: ${ind.obvTrend.toFixed(0)})` });
    } else if (ind.obvTrend < -10) {
      votes.push({ direction: "SHORT", weight: 0.8, reason: `OBV falling (trend: ${ind.obvTrend.toFixed(0)})` });
    }
  }

  // 9. ADX trend strength + DI direction
  if (ind.adx14 !== undefined && ind.plusDI !== undefined && ind.minusDI !== undefined) {
    if (ind.adx14 > 20) {
      if (ind.plusDI > ind.minusDI) {
        votes.push({ direction: "LONG", weight: 1.1, reason: `ADX ${ind.adx14.toFixed(0)} + DI bullish` });
      } else {
        votes.push({ direction: "SHORT", weight: 1.1, reason: `ADX ${ind.adx14.toFixed(0)} + DI bearish` });
      }
    }
  }

  // 10. News bias
  const bullNews = news.filter((n) => n.directionalBias === "BULLISH").length;
  const bearNews = news.filter((n) => n.directionalBias === "BEARISH").length;
  if (bullNews > bearNews && bullNews >= 1) {
    votes.push({ direction: "LONG", weight: 0.5 * bullNews, reason: `${bullNews} bullish news item(s)` });
  } else if (bearNews > bullNews && bearNews >= 1) {
    votes.push({ direction: "SHORT", weight: 0.5 * bearNews, reason: `${bearNews} bearish news item(s)` });
  }

  // Tally
  let longWeight = 0;
  let shortWeight = 0;
  for (const v of votes) {
    if (v.direction === "LONG") longWeight += v.weight;
    else shortWeight += v.weight;
  }

  const direction: TradeDirection = longWeight >= shortWeight ? "LONG" : "SHORT";
  const total = longWeight + shortWeight;
  const agreement = total === 0 ? 0.5 : Math.max(longWeight, shortWeight) / total;

  return { direction, votes, agreement };
};

// ─── Strategy selection ───────────────────────────────────────────────────────

const selectStrategy = (
  direction: TradeDirection,
  ind: ReturnType<typeof calculateIndicatorSnapshot>,
  regime: ReturnType<typeof detectMarketRegime>,
): string => {
  const { preferredStrategy } = regime;

  // Bollinger Band squeeze breakout
  if (ind.bbWidth !== undefined && ind.bbWidth < 0.02) {
    return direction === "LONG" ? "breakout_continuation" : "breakdown_continuation";
  }

  // BB lower-band bounce (mean reversion)
  if (ind.bbPercentB !== undefined && ind.bbPercentB < 0.1 && direction === "LONG") {
    return "vwap_reclaim";
  }

  // BB upper-band rejection (mean reversion short)
  if (ind.bbPercentB !== undefined && ind.bbPercentB > 0.9 && direction === "SHORT") {
    return "range_fade_short";
  }

  // Strong trend with ADX
  if (ind.adx14 !== undefined && ind.adx14 > 30) {
    return direction === "LONG" ? "trend_pullback" : "breakdown_continuation";
  }

  switch (preferredStrategy) {
    case "breakout":
      return direction === "LONG" ? "breakout_continuation" : "breakdown_continuation";
    case "mean_reversion":
      return direction === "LONG" ? "vwap_reclaim" : "range_fade_short";
    case "reversal":
      return direction === "LONG" ? "liquidity_sweep_reclaim" : "reversal_major_level";
    default:
      return direction === "LONG" ? (ind.rsi14 > 55 ? "breakout_continuation" : "trend_pullback") : "breakdown_continuation";
  }
};

// ─── Confluence scoring ───────────────────────────────────────────────────────

const computeConfluenceScore = (
  ind: ReturnType<typeof calculateIndicatorSnapshot>,
  regime: ReturnType<typeof detectMarketRegime>,
  news: NewsIntelligenceRecord[],
  direction: TradeDirection,
  agreementRatio: number,
): number => {
  let score = 0;

  // Momentum (25%)
  score += clamp(Math.abs(ind.momentumScore) * 0.25, 0, 25);

  // Trend alignment (20%)
  score += clamp(Math.abs(ind.trendStrength) * 0.2, 0, 20);

  // Volume confirmation (15%)
  score += clamp((ind.volumeRatio - 1) * 15, 0, 15);

  // Direction agreement across signal groups (25%)
  score += agreementRatio * 25;

  // News confluence (5%)
  const newsBoost = news.reduce((total, item) => total + item.relevanceScore, 0) * 0.05;
  score += clamp(newsBoost, 0, 5);

  // Regime alignment (10%)
  const regimeAlignScore =
    regime.directionBias === "NEUTRAL" ? 3 :
    regime.directionBias === direction ? 10 : 0;
  score += regimeAlignScore * 0.1;

  // Bonus: ADX confirms strong trend
  if (ind.adx14 !== undefined && ind.adx14 > 25) score += 3;

  // Bonus: OBV confirms direction
  if (ind.obvTrend !== undefined) {
    if ((direction === "LONG" && ind.obvTrend > 15) || (direction === "SHORT" && ind.obvTrend < -15)) {
      score += 3;
    }
  }

  // Bonus: StochRSI in favourable zone
  if (ind.stochRsiK !== undefined) {
    if (direction === "LONG" && ind.stochRsiK > 40 && ind.stochRsiK < 80) score += 2;
    if (direction === "SHORT" && ind.stochRsiK < 60 && ind.stochRsiK > 20) score += 2;
  }

  return clamp(score, 0, 100);
};

// ─── Entry / Stop / Target ────────────────────────────────────────────────────

const computeLevels = (
  direction: TradeDirection,
  currentPrice: number,
  atr: number,
  strategy: string,
  ind: ReturnType<typeof calculateIndicatorSnapshot>,
): { stopLoss: number; takeProfit: number; stopDistance: number } => {
  // ATR multiplier by strategy
  const stopMultiplier =
    strategy.includes("breakout") ? 1.4 :
    strategy === "reversal_major_level" || strategy === "liquidity_sweep_reclaim" ? 0.9 :
    strategy === "vwap_reclaim" || strategy === "range_fade_short" ? 1.0 :
    1.15;

  // Minimum stop: 0.8% of price for low-volatility assets
  const minStopPct = 0.008;
  const stopDistance = Math.max(atr * stopMultiplier, currentPrice * minStopPct);

  // Risk:Reward target
  const rrMultiple =
    strategy.includes("breakout") ? 2.5 :
    strategy === "trend_pullback" ? 2.0 :
    strategy === "vwap_reclaim" ? 1.8 :
    1.9;

  const stopLoss =
    direction === "LONG" ? currentPrice - stopDistance : currentPrice + stopDistance;
  const takeProfit =
    direction === "LONG"
      ? currentPrice + stopDistance * rrMultiple
      : currentPrice - stopDistance * rrMultiple;

  return { stopLoss, takeProfit, stopDistance };
};

// ─── Main entry point ─────────────────────────────────────────────────────────

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

  // ── Session quality gate ───────────────────────────────────────────────────
  // Skip low-liquidity windows where spreads blow out and signals are noisy.
  // Crypto is exempt (24/7). On the 1d timeframe, session timing doesn't apply.
  if (timeframe !== "1d") {
    const assetClass = resolveAssetClass(symbol);
    const session = checkSessionQuality(assetClass);
    if (!session.allowed) {
      return null; // silent reject — logged at worker level if needed
    }
  }

  const ind = calculateIndicatorSnapshot(bars);
  const regime = detectMarketRegime(bars, ind);
  const priceMomentumPct = percentChange(oldest.close, latest.close);

  const { direction, votes, agreement } = inferDirectionFromIndicators(ind, bars, relevantNews, regime.directionBias);

  // Require at least 3 signal votes total for a candidate to proceed
  if (votes.length < 3) return null;

  const confluenceScore = computeConfluenceScore(ind, regime, relevantNews, direction, agreement);
  const setupScore = clamp(50 + confluenceScore * 0.5, 1, 100);

  // Quality gate: must exceed 62 and have at least 60% directional agreement
  if (setupScore < 62) return null;
  if (agreement < 0.60) return null;

  const strategyType = selectStrategy(direction, ind, regime);
  const currentPrice = latest.close;

  const { stopLoss, stopDistance } = computeLevels(
    direction,
    currentPrice,
    ind.atr14,
    strategyType,
    ind,
  );

  // ── Dynamic take profit (volatility-adjusted) ──────────────────────────────
  const volClass = (regime.regime === "bull_trend" || regime.regime === "bear_trend") ? "high"
    : regime.regime === "breakout_expansion" ? "high"
    : regime.regime === "range_mean_reversion" ? "low"
    : regime.regime === "volatile_reversal" ? "extreme"
    : "medium";
  const dynamicTP = computeDynamicTakeProfit(
    currentPrice,
    stopLoss,
    direction,
    ind.atr14,
    volClass,
  );
  const takeProfit = dynamicTP.takeProfit;
  const riskReward = dynamicTP.riskReward;

  // Confidence considers agreement + regime alignment + MACD histogram
  const macdBoost = ind.macdHistogram !== undefined ? clamp(Math.abs(ind.macdHistogram) * 0.5, 0, 5) : 0;
  const confidenceScore = clamp(
    setupScore * 0.6 + Math.abs(priceMomentumPct) * 1.0 + regime.confidence * 0.15 + agreement * 15 + macdBoost,
    1,
    100,
  );

  const newsScore = relevantNews.reduce((t, n) => t + n.relevanceScore, 0);
  const regimeAlignmentScore = regime.directionBias === direction ? regime.confidence * 0.08 : -6;

  // Build reasoning summaries from votes
  const longVotes = votes.filter((v) => v.direction === "LONG").map((v) => v.reason).join(", ");
  const shortVotes = votes.filter((v) => v.direction === "SHORT").map((v) => v.reason).join(", ");

  return {
    symbol,
    timeframe,
    direction,
    strategyType,
    detectedAt: new Date().toISOString(),
    currentPrice,
    proposedEntry: currentPrice,
    stopLoss,
    takeProfit,
    riskReward,
    confidenceScore,
    setupScore,
    featureValues: {
      priceMomentumPct,
      atrPct: ind.atrPct,
      volumeRatio: ind.volumeRatio,
      trendStrength: ind.trendStrength,
      newsScore,
      regimeConfidence: regime.confidence,
      regimeBiasScore: regimeAlignmentScore,
      directionAgreement: agreement,
      adx: ind.adx14 ?? 0,
      bbPercentB: ind.bbPercentB ?? 0.5,
      stochRsiK: ind.stochRsiK ?? 50,
      obvTrend: ind.obvTrend ?? 0,
      macdHistogram: ind.macdHistogram ?? 0,
    },
    indicatorSnapshot: ind,
    reasoningLog: buildReasoningLog([
      {
        title: "Market regime",
        detail: `${symbol} classified as ${regime.regime} (${regime.confidence.toFixed(0)}% confidence). ${regime.summary}`,
        weight: clamp(regime.confidence / 100, 0.35, 0.95),
        tags: ["regime", regime.regime, regime.preferredStrategy],
      },
      {
        title: "Directional consensus",
        detail: `${(agreement * 100).toFixed(0)}% vote agreement for ${direction}. Bullish signals: ${longVotes || "none"}. Bearish signals: ${shortVotes || "none"}.`,
        weight: clamp(agreement, 0.3, 0.95),
        tags: ["direction", direction.toLowerCase(), "confluence"],
      },
      {
        title: "Technical confluence",
        detail: `RSI ${ind.rsi14.toFixed(1)} | MACD ${ind.macd.toFixed(4)} (hist ${(ind.macdHistogram ?? 0).toFixed(4)}) | ADX ${(ind.adx14 ?? 0).toFixed(1)} | BB%B ${((ind.bbPercentB ?? 0.5) * 100).toFixed(0)}% | StochRSI K=${(ind.stochRsiK ?? 50).toFixed(0)}`,
        weight: 0.80,
        tags: ["technical", "rsi", "macd", "adx", "bollinger"],
      },
      {
        title: "Volume & OBV",
        detail: `Relative volume ${ind.volumeRatio.toFixed(2)}x | OBV trend ${(ind.obvTrend ?? 0).toFixed(1)} (${(ind.obvTrend ?? 0) > 0 ? "accumulation" : "distribution"})`,
        weight: 0.62,
        tags: ["volume", "obv"],
      },
      {
        title: "News context",
        detail: `${relevantNews.length} linked news item(s) for ${symbol}.`,
        weight: relevantNews.length > 0 ? 0.66 : 0.30,
        tags: ["news", direction.toLowerCase()],
      },
    ]),
    status: "NEW",
    correlationTags: [symbol.slice(0, 3), regime.regime, direction === "LONG" ? "risk_on" : "risk_off"],
    volatilityClassification: regime.regime,
  };
};
