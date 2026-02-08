import type { DailyBar, NewsItem, SetupCandidate } from "../types";

interface SwingContext {
  symbol: string;
  bars: DailyBar[];
  news: NewsItem[];
  levels: {
    prevHigh: number;
    prevLow: number;
    weekHigh: number;
    weekLow: number;
  };
}

const baseCandidate = (symbol: string, setupType: SetupCandidate["setupType"]): SetupCandidate => ({
  symbol,
  setupType,
  timeframe: "swing",
  confidence: 50,
  trigger: {},
  invalidation: {},
  targets: {},
  explanation: "",
});

export const detectBreakoutRetest = (context: SwingContext): SetupCandidate | null => {
  const latest = context.bars[0];
  if (!latest) return null;
  if (latest.close <= context.levels.weekHigh) return null;
  return {
    ...baseCandidate(context.symbol, "breakout_retest"),
    confidence: 72,
    trigger: { level: context.levels.weekHigh, note: "Hold above breakout level." },
    invalidation: { level: context.levels.prevLow, note: "Break below prior support." },
    targets: { atrMultiple: 2 },
    explanation: "Break above multi-week resistance with room to retest on lighter volume.",
  };
};

export const detectPullbackContinuation = (context: SwingContext): SetupCandidate | null => {
  const latest = context.bars[0];
  if (!latest) return null;
  if (latest.close < context.levels.prevLow) return null;
  return {
    ...baseCandidate(context.symbol, "pullback_continuation"),
    confidence: 68,
    trigger: { level: context.levels.prevHigh, note: "Reclaim prior swing high." },
    invalidation: { level: context.levels.prevLow, note: "Lose pullback support." },
    targets: { atrMultiple: 1.5 },
    explanation: "Uptrend pullback holding prior support with contraction.",
  };
};

export const detectGapAndGo = (context: SwingContext): SetupCandidate | null => {
  if (context.news.length === 0) return null;
  return {
    ...baseCandidate(context.symbol, "gap_and_go"),
    confidence: 65,
    trigger: { level: context.levels.prevHigh, note: "Hold gap midpoint and push." },
    invalidation: { level: context.levels.prevLow, note: "Gap fails below midpoint." },
    targets: { atrMultiple: 2.2 },
    explanation: "Catalyst-backed gap holding key levels.",
  };
};

export const detectReversalMajorLevel = (context: SwingContext): SetupCandidate | null => {
  const latest = context.bars[0];
  if (!latest) return null;
  if (latest.low >= context.levels.weekLow) return null;
  return {
    ...baseCandidate(context.symbol, "reversal_major_level"),
    confidence: 62,
    trigger: { level: context.levels.weekLow, note: "Reclaim major low." },
    invalidation: { level: context.levels.weekLow * 0.98, note: "Lose reclaimed level." },
    targets: { atrMultiple: 2.5 },
    explanation: "Liquidity sweep below support with close strength.",
  };
};

export const detectRelativeStrengthLeader = (context: SwingContext): SetupCandidate | null => {
  const latest = context.bars[0];
  if (!latest) return null;
  if (latest.close <= context.levels.prevHigh) return null;
  return {
    ...baseCandidate(context.symbol, "relative_strength_leader"),
    confidence: 70,
    trigger: { level: context.levels.prevHigh, note: "Break from consolidation." },
    invalidation: { level: context.levels.prevLow, note: "Lose relative strength base." },
    targets: { atrMultiple: 1.8 },
    explanation: "Relative strength leader breaking above consolidation.",
  };
};

export const detectSwingSetups = (context: SwingContext): SetupCandidate[] => {
  return [
    detectBreakoutRetest(context),
    detectPullbackContinuation(context),
    detectGapAndGo(context),
    detectReversalMajorLevel(context),
    detectRelativeStrengthLeader(context),
  ].filter((item): item is SetupCandidate => Boolean(item));
};
