import type { DailyBar, SetupCandidate } from "../types";

interface ScalpContext {
  symbol: string;
  bars: DailyBar[];
  vwap: number;
  openingRangeHigh: number;
  openingRangeLow: number;
  yesterdayHigh: number;
  yesterdayLow: number;
}

const baseCandidate = (symbol: string, setupType: SetupCandidate["setupType"]): SetupCandidate => ({
  symbol,
  setupType,
  timeframe: "scalp",
  confidence: 50,
  trigger: {},
  invalidation: {},
  targets: {},
  explanation: "",
});

export const detectOpeningRangeBreakout = (context: ScalpContext): SetupCandidate | null => {
  const latest = context.bars[0];
  if (!latest) return null;
  if (latest.close <= context.openingRangeHigh) return null;
  return {
    ...baseCandidate(context.symbol, "opening_range_breakout"),
    confidence: 73,
    trigger: { level: context.openingRangeHigh, note: "Break OR high with RVOL." },
    invalidation: { level: context.openingRangeLow, note: "Fail back into OR." },
    targets: { atrMultiple: 0.8 },
    explanation: "Opening range breakout with volume expansion.",
  };
};

export const detectVwapReclaim = (context: ScalpContext): SetupCandidate | null => {
  const latest = context.bars[0];
  if (!latest) return null;
  if (latest.close <= context.vwap) return null;
  return {
    ...baseCandidate(context.symbol, "vwap_reclaim"),
    confidence: 66,
    trigger: { level: context.vwap, note: "Reclaim and hold VWAP." },
    invalidation: { level: context.vwap * 0.99, note: "Lose VWAP." },
    targets: { atrMultiple: 0.6 },
    explanation: "VWAP reclaim with momentum.",
  };
};

export const detectLiquiditySweepReclaim = (context: ScalpContext): SetupCandidate | null => {
  const latest = context.bars[0];
  if (!latest) return null;
  if (latest.low >= context.yesterdayLow) return null;
  return {
    ...baseCandidate(context.symbol, "liquidity_sweep_reclaim"),
    confidence: 60,
    trigger: { level: context.yesterdayLow, note: "Reclaim sweep low." },
    invalidation: { level: context.yesterdayLow * 0.995, note: "Lose sweep reclaim." },
    targets: { atrMultiple: 0.7 },
    explanation: "Liquidity sweep below yesterday low then reclaim.",
  };
};

export const detectScalpSetups = (context: ScalpContext): SetupCandidate[] => {
  return [
    detectOpeningRangeBreakout(context),
    detectVwapReclaim(context),
    detectLiquiditySweepReclaim(context),
  ].filter((item): item is SetupCandidate => Boolean(item));
};
