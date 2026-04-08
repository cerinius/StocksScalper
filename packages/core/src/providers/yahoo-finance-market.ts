/**
 * Yahoo Finance Market Data Provider
 *
 * Uses Yahoo Finance's public chart API — free, no API key required.
 * Supports all timeframes: 1m, 5m, 15m, 1h, 4h (aggregated), 1d.
 * Handles stocks, ETFs, forex, commodities, and crypto with symbol mapping.
 *
 * Rate note: Yahoo Finance is generally tolerant of reasonable request rates.
 * We enforce a minimum 150ms gap between requests to avoid triggering blocks.
 */

import type { DailyBar, PriceBar, Timeframe, UniverseCandidate } from "../types";
import type { MarketDataProvider } from "./market-data";

// ─── Yahoo Finance API Types ──────────────────────────────────────────────────

interface YFChartResponse {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        regularMarketPrice: number;
        currency: string;
        exchangeTimezoneName: string;
        regularMarketTime: number;
        dataGranularity: string;
        range: string;
      };
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }> | null;
    error: { code: string; description: string } | null;
  };
}

// ─── Timeframe → Yahoo Finance interval/range mapping ─────────────────────────

const YF_INTERVAL: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "60m",
  "4h": "60m", // Aggregate 4 × 1h bars in post-processing
  "1d": "1d",
};

const YF_RANGE: Record<Timeframe, string> = {
  "1m": "2d",   // Max 7 days for 1m on free tier; use 2d for freshness
  "5m": "5d",
  "15m": "60d",
  "1h": "60d",
  "4h": "60d",
  "1d": "2y",
};

// ─── Symbol resolution ────────────────────────────────────────────────────────

/**
 * Maps internal symbols to Yahoo Finance ticker format.
 *
 * Examples:
 *   BTCUSD  → BTC-USD
 *   ETHUSD  → ETH-USD
 *   EURUSD  → EURUSD=X
 *   GBPUSD  → GBPUSD=X
 *   XAUUSD  → GC=F  (Gold Futures)
 *   XAGUSD  → SI=F  (Silver Futures)
 *   AAPL    → AAPL  (unchanged)
 *   SPY     → SPY   (unchanged)
 */
const toYahooSymbol = (symbol: string): string => {
  // Commodity overrides
  const commodityMap: Record<string, string> = {
    XAUUSD: "GC=F",  // Gold
    XAGUSD: "SI=F",  // Silver
    WTIUSD: "CL=F",  // Crude Oil
    BRENTUSD: "BZ=F", // Brent Oil
    NATGAS: "NG=F",  // Natural Gas
  };
  if (commodityMap[symbol]) return commodityMap[symbol];

  // Crypto: symbols ending in USD (excluding forex pairs)
  const knownForex = new Set(["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "NZDUSD", "USDCAD"]);
  if (!knownForex.has(symbol) && /^[A-Z]{3,5}USD$/.test(symbol)) {
    const base = symbol.slice(0, -3); // Remove "USD"
    return `${base}-USD`;
  }

  // Forex: 6-char currency pairs
  if (/^[A-Z]{6}$/.test(symbol)) {
    return `${symbol}=X`;
  }

  // Default: use as-is (stocks, ETFs)
  return symbol;
};

// ─── 4h bar aggregation from 1h bars ─────────────────────────────────────────

const aggregate4hBars = (hourBars: PriceBar[]): PriceBar[] => {
  const result: PriceBar[] = [];
  for (let i = 0; i + 3 < hourBars.length; i += 4) {
    const chunk = hourBars.slice(i, i + 4);
    result.push({
      symbol: chunk[0].symbol,
      timeframe: "4h",
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  return result;
};

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface YahooFinanceMarketDataProviderOptions {
  watchlistSymbols?: string[];
  fetchImpl?: typeof fetch;
  /** Minimum milliseconds between API requests. Default: 200ms */
  rateLimitMs?: number;
}

export class YahooFinanceMarketDataProvider implements MarketDataProvider {
  private readonly watchlistSymbols: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimitMs: number;
  private lastRequestAt = 0;

  constructor(options: YahooFinanceMarketDataProviderOptions = {}) {
    this.watchlistSymbols = options.watchlistSymbols ?? [];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.rateLimitMs = options.rateLimitMs ?? 200;
  }

  async getUniverse(): Promise<UniverseCandidate[]> {
    // Yahoo Finance doesn't expose a screener via this API; universe management
    // is handled by the watchlist configuration.
    return [];
  }

  async getDailyBars(symbol: string, days: number): Promise<DailyBar[]> {
    const bars = await this.getPriceBars(symbol, "1d", days);
    return bars.map((bar) => ({
      date: bar.timestamp.slice(0, 10),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }

  async getIntradayBars(symbol: string, timeframe: "1m" | "5m", days: number): Promise<DailyBar[]> {
    const barsPerDay = timeframe === "1m" ? 390 : 78;
    const bars = await this.getPriceBars(symbol, timeframe, days * barsPerDay);
    return bars.map((bar) => ({
      date: bar.timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }

  async getPriceBars(symbol: string, timeframe: Timeframe, bars: number): Promise<PriceBar[]> {
    const yahooSymbol = toYahooSymbol(symbol);

    // For 4h we fetch 1h data and aggregate
    const fetchTimeframe: Timeframe = timeframe === "4h" ? "1h" : timeframe;
    const fetchBars = timeframe === "4h" ? bars * 4 : bars;

    const interval = YF_INTERVAL[fetchTimeframe];
    const range = YF_RANGE[fetchTimeframe];

    await this.throttle();

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}&includePrePost=false`;

    let data: YFChartResponse;
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      data = (await response.json()) as YFChartResponse;
    } catch (error) {
      throw new Error(
        `Yahoo Finance request failed for ${symbol} (${yahooSymbol}) [${fetchTimeframe}]: ${(error as Error).message}`,
      );
    }

    if (data.chart.error) {
      throw new Error(`Yahoo Finance API error for ${symbol}: ${data.chart.error.description}`);
    }

    const result = data.chart.result?.[0];
    if (!result?.timestamp?.length || !result.indicators.quote[0]) {
      return [];
    }

    const { timestamp, indicators } = result;
    const quote = indicators.quote[0];

    // Parse and filter out null/invalid candles
    const priceBars: PriceBar[] = [];
    for (let i = 0; i < timestamp.length; i++) {
      const open = quote.open[i];
      const high = quote.high[i];
      const low = quote.low[i];
      const close = quote.close[i];
      const volume = quote.volume[i];

      // Skip bars with missing OHLC (Yahoo sometimes returns null for off-market hours)
      if (open == null || high == null || low == null || close == null) continue;
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
      if (close <= 0) continue;

      priceBars.push({
        symbol,
        timeframe: fetchTimeframe,
        timestamp: new Date(timestamp[i] * 1000).toISOString(),
        open,
        high,
        low,
        close,
        volume: volume ?? 0,
      });
    }

    // Aggregate 1h → 4h if needed
    const finalBars = timeframe === "4h" ? aggregate4hBars(priceBars) : priceBars;

    return finalBars.slice(-Math.max(fetchBars, bars));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.rateLimitMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.rateLimitMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}
