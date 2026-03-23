export * from "@stock-radar/types";

export type SetupTimeframe = "swing" | "scalp";

export type SetupType =
  | "breakout_retest"
  | "pullback_continuation"
  | "gap_and_go"
  | "reversal_major_level"
  | "relative_strength_leader"
  | "opening_range_breakout"
  | "vwap_reclaim"
  | "liquidity_sweep_reclaim"
  | "trend_pullback"
  | "breakout_continuation";

export type SetupStatus = "watch" | "triggered" | "invalidated" | "expired";

export interface SymbolQuote {
  symbol: string;
  price: number;
  volume: number;
  dollarVolume: number;
}

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface NewsItem {
  symbol: string;
  publishedAt: string;
  headline: string;
  source: string;
  url: string;
  summary?: string;
  tags?: string[];
}

export interface UniverseCandidate {
  symbol: string;
  metrics: {
    price: number;
    dollarVolume: number;
    avgVolume: number;
    atrPct: number;
    rvol: number;
    trendScore: number;
    catalystScore: number;
  };
}

export interface ScoreWeights {
  liquidity: number;
  volatility: number;
  volume: number;
  trend: number;
  catalyst: number;
}

export interface ScoredCandidate {
  symbol: string;
  totalScore: number;
  components: {
    liquidityScore: number;
    volatilityScore: number;
    volumeScore: number;
    trendScore: number;
    catalystScore: number;
  };
  metrics: UniverseCandidate["metrics"];
}

export interface SetupCandidate {
  symbol: string;
  setupType: SetupType;
  timeframe: SetupTimeframe;
  confidence: number;
  trigger: Record<string, unknown>;
  invalidation: Record<string, unknown>;
  targets: Record<string, unknown>;
  explanation: string;
}
