import type { DailyBar, UniverseCandidate } from "../types";

export interface MarketDataProvider {
  getUniverse(): Promise<UniverseCandidate[]>;
  getDailyBars(symbol: string, days: number): Promise<DailyBar[]>;
  getIntradayBars(symbol: string, timeframe: "1m" | "5m", days: number): Promise<DailyBar[]>;
}
