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
  indicatorSnapshot: MarketIndicatorSnapshot,
): MarketRegimeAssessment => {
  const latest = bars.at(-1);
  const anchor = bars.at(-20);
  const priceMomentumPct = latest && anchor ? percentChange(anchor.close, latest.close) : 0;
  const realizedRangePct = averageRangePct(bars.slice(-12));
  const trendStrength = indicatorSnapshot.trendStrength;
  const isTrending = Math.abs(trendStrength) >= 24;
  const isHighVolatility = indicatorSnapshot.atrPct >= 2.8 || realizedRangePct >= 1.9;
  const isRangeBound = Math.abs(trendStrength) <= 12 && indicatorSnapshot.rsi14 >= 38 && indicatorSnapshot.rsi14 <= 62;
  const isBreakout =
    indicatorSnapshot.volumeRatio >= 1.12 &&
    Math.abs(indicatorSnapshot.momentumScore) >= 45 &&
    (Math.abs(priceMomentumPct) >= 1.4 || isHighVolatility);

  if (isTrending && !isHighVolatility) {
    const bullish = trendStrength >= 0;
    return {
      regime: bullish ? "bull_trend" : "bear_trend",
      confidence: clamp(Math.abs(trendStrength) * 1.1 + Math.abs(priceMomentumPct) * 6, 35, 95),
      preferredStrategy: "trend",
      directionBias: bullish ? "LONG" : "SHORT",
      summary: bullish
        ? "Steady directional trend with contained volatility."
        : "Persistent downside trend with orderly volatility.",
    };
  }

  if (isBreakout) {
    return {
      regime: "breakout_expansion",
      confidence: clamp(Math.abs(indicatorSnapshot.momentumScore) * 0.9 + indicatorSnapshot.volumeRatio * 18, 40, 97),
      preferredStrategy: "breakout",
      directionBias: trendStrength >= 0 ? "LONG" : "SHORT",
      summary: "Momentum and volume are expanding together, favoring continuation or range escape.",
    };
  }

  if (isRangeBound) {
    return {
      regime: "range_mean_reversion",
      confidence: clamp(62 - Math.abs(trendStrength) + (65 - Math.abs(indicatorSnapshot.rsi14 - 50)), 30, 88),
      preferredStrategy: "mean_reversion",
      directionBias: "NEUTRAL",
      summary: "Trend is muted and the tape is behaving like a mean-reversion range.",
    };
  }

  return {
    regime: "volatile_reversal",
    confidence: clamp(indicatorSnapshot.atrPct * 16 + Math.abs(indicatorSnapshot.momentumScore) * 0.35, 30, 92),
    preferredStrategy: "reversal",
    directionBias: indicatorSnapshot.rsi14 <= 45 ? "LONG" : indicatorSnapshot.rsi14 >= 55 ? "SHORT" : "NEUTRAL",
    summary: "Volatility is elevated enough that reversals and failed breaks matter more than smooth trends.",
  };
};
