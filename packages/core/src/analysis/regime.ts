/**
 * Market Regime Detection — Enhanced
 *
 * Uses EMA alignment, ATR/volatility, volume, momentum, ADX, and Bollinger
 * Band width to classify market conditions and select the best strategy type.
 *
 * Regimes:
 *   bull_trend           → Uptrend with contained volatility
 *   bear_trend           → Downtrend with contained volatility
 *   range_mean_reversion → Sideways, oscillating between support/resistance
 *   breakout_expansion   → Price + volume surging out of consolidation
 *   volatile_reversal    → High volatility with directional exhaustion signals
 */

import type { MarketIndicatorSnapshot, PriceBar, TradeDirection } from "@stock-radar/types";
import { clamp, percentChange } from "@stock-radar/shared";

export interface MarketRegimeAssessment {
  regime: "bull_trend" | "bear_trend" | "range_mean_reversion" | "breakout_expansion" | "volatile_reversal";
  confidence: number;
  preferredStrategy: "trend" | "mean_reversion" | "breakout" | "reversal";
  directionBias: TradeDirection | "NEUTRAL";
  summary: string;
}

const averageRangePct = (bars: PriceBar[]) => {
  if (bars.length === 0) return 0;
  return bars.reduce((total, bar) => total + ((bar.high - bar.low) / Math.max(bar.close, 1)) * 100, 0) / bars.length;
};

export const detectMarketRegime = (
  bars: PriceBar[],
  ind: MarketIndicatorSnapshot,
): MarketRegimeAssessment => {
  const latest = bars.at(-1);
  const anchor = bars.at(-20);
  const priceMomentumPct = latest && anchor ? percentChange(anchor.close, latest.close) : 0;
  const realizedRangePct = averageRangePct(bars.slice(-12));

  // ── Signal extraction ──────────────────────────────────────────────────────

  const trendStrength = ind.trendStrength;

  // ADX: strong trend = >25, very strong = >40
  const adx = ind.adx14 ?? 0;
  const adxStrong = adx > 25;
  const adxVeryStrong = adx > 40;
  const plusDI = ind.plusDI ?? 0;
  const minusDI = ind.minusDI ?? 0;
  const diDirection: TradeDirection | "NEUTRAL" = adx > 15 ? (plusDI > minusDI ? "LONG" : "SHORT") : "NEUTRAL";

  // Bollinger Band width: tight = squeeze/consolidation, wide = expansion
  const bbWidth = ind.bbWidth ?? 0;
  const bbSqueeze = bbWidth > 0 && bbWidth < 0.015; // Very tight bands
  const bbExpansion = bbWidth > 0.04;               // Wide bands (expansion)

  // Volatility flags
  const isHighVolatility = ind.atrPct >= 2.8 || realizedRangePct >= 1.9;

  // OBV trend confirmation
  const obvTrend = ind.obvTrend ?? 0;
  const obvBullish = obvTrend > 15;
  const obvBearish = obvTrend < -15;

  // Trend detection: EMAs aligned + ADX confirms
  const isTrendingByEma = Math.abs(trendStrength) >= 22;
  const isTrendingByAdx = adxStrong;
  const isTrending = (isTrendingByEma || isTrendingByAdx) && !isHighVolatility;

  // Range-bound: tight EMA spread + RSI mid-zone + BB not wide
  const isRangeBound =
    Math.abs(trendStrength) <= 14 &&
    ind.rsi14 >= 36 && ind.rsi14 <= 64 &&
    !bbExpansion;

  // Breakout: volume surging + momentum high + BB expanding or price at BB upper/lower
  const bbPercentB = ind.bbPercentB ?? 0.5;
  const atBbEdge = bbPercentB > 0.90 || bbPercentB < 0.10;
  const isBreakout =
    ind.volumeRatio >= 1.10 &&
    Math.abs(ind.momentumScore) >= 40 &&
    (Math.abs(priceMomentumPct) >= 1.2 || isHighVolatility || atBbEdge || bbSqueeze);

  // ── Classify ───────────────────────────────────────────────────────────────

  if (isTrending) {
    const bullish = adxStrong ? diDirection === "LONG" : trendStrength >= 0;
    const bullOBV = bullish ? obvBullish : obvBearish;
    const confidence = clamp(
      Math.abs(trendStrength) * 1.0 +
      Math.abs(priceMomentumPct) * 5 +
      (adxStrong ? adx * 0.4 : 0) +
      (bullOBV ? 8 : 0),
      35,
      96,
    );
    return {
      regime: bullish ? "bull_trend" : "bear_trend",
      confidence,
      preferredStrategy: "trend",
      directionBias: bullish ? "LONG" : "SHORT",
      summary: bullish
        ? `Uptrend confirmed — EMA aligned, ADX ${adx.toFixed(0)}, OBV ${obvTrend > 0 ? "accumulating" : "neutral"}.`
        : `Downtrend confirmed — EMA inverted, ADX ${adx.toFixed(0)}, OBV ${obvTrend < 0 ? "distributing" : "neutral"}.`,
    };
  }

  if (isBreakout) {
    const bullBreak = trendStrength >= 0;
    const confidence = clamp(
      Math.abs(ind.momentumScore) * 0.85 +
      ind.volumeRatio * 16 +
      (bbExpansion ? 10 : 0) +
      (atBbEdge ? 8 : 0),
      40,
      97,
    );
    return {
      regime: "breakout_expansion",
      confidence,
      preferredStrategy: "breakout",
      directionBias: bullBreak ? "LONG" : "SHORT",
      summary: `${bbSqueeze ? "Squeeze breakout" : "Momentum breakout"} — volume ${ind.volumeRatio.toFixed(2)}x, BB width ${(bbWidth * 100).toFixed(1)}%.`,
    };
  }

  if (isRangeBound) {
    const confidence = clamp(
      64 - Math.abs(trendStrength) +
      (65 - Math.abs(ind.rsi14 - 50)) +
      (bbSqueeze ? 5 : 0),
      30,
      88,
    );
    return {
      regime: "range_mean_reversion",
      confidence,
      preferredStrategy: "mean_reversion",
      directionBias: "NEUTRAL",
      summary: `Ranging market — BB width ${(bbWidth * 100).toFixed(1)}%, RSI ${ind.rsi14.toFixed(0)}, low ADX ${adx.toFixed(0)}.`,
    };
  }

  // Default: volatile/reversal
  const reversalBias: TradeDirection | "NEUTRAL" =
    diDirection !== "NEUTRAL" ? diDirection :
    ind.rsi14 <= 35 ? "LONG" :
    ind.rsi14 >= 65 ? "SHORT" :
    "NEUTRAL";

  return {
    regime: "volatile_reversal",
    confidence: clamp(
      ind.atrPct * 14 +
      Math.abs(ind.momentumScore) * 0.3 +
      (adxStrong ? 10 : 0),
      30,
      92,
    ),
    preferredStrategy: "reversal",
    directionBias: reversalBias,
    summary: `High-volatility environment — ATR ${ind.atrPct.toFixed(1)}%, ADX ${adx.toFixed(0)}, StochRSI K=${(ind.stochRsiK ?? 50).toFixed(0)}.`,
  };
};
