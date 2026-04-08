import type { DailyBar, PriceBar, Timeframe, UniverseCandidate } from "../types";
import type { MarketDataProvider } from "./market-data";

interface AlphaVantageIntradayResponse {
  "Meta Data": {
    "1. Information": string;
    "2. Symbol": string;
    "3. Last Refreshed": string;
    "4. Interval": string;
    "5. Output Size": string;
    "6. Time Zone": string;
  };
  "Time Series (1min)"?: Record<string, {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
  }>;
  "Time Series (5min)"?: Record<string, {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
  }>;
  "Time Series (15min)"?: Record<string, {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
  }>;
  "Time Series (30min)"?: Record<string, {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
  }>;
  "Time Series (60min)"?: Record<string, {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
  }>;
}

interface AlphaVantageDailyResponse {
  "Meta Data": {
    "1. Information": string;
    "2. Symbol": string;
    "3. Last Refreshed": string;
    "4. Output Size": string;
    "5. Time Zone": string;
  };
  "Time Series (Daily)": Record<string, {
    "1. open": string;
    "2. high": string;
    "3. low": string;
    "4. close": string;
    "5. volume": string;
  }>;
}

export interface AlphaVantageMarketDataProviderOptions {
  apiKey: string;
  watchlistSymbols?: string[];
  fetchImpl?: typeof fetch;
}

export class AlphaVantageMarketDataProvider implements MarketDataProvider {
  private readonly apiKey: string;
  private readonly watchlistSymbols: string[];
  private readonly fetchImpl: typeof fetch;

  constructor(options: AlphaVantageMarketDataProviderOptions) {
    this.apiKey = options.apiKey;
    this.watchlistSymbols = options.watchlistSymbols ?? [];
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  hasApiKey() {
    return this.apiKey.trim().length > 0;
  }

  async getUniverse(): Promise<UniverseCandidate[]> {
    // Alpha Vantage doesn't have a universe endpoint, so return empty or mock
    // For now, return empty array as universe is handled elsewhere
    return [];
  }

  async getDailyBars(symbol: string, days: number): Promise<DailyBar[]> {
    const response = await this.requestJson<AlphaVantageDailyResponse>(
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${encodeURIComponent(this.apiKey)}`
    );

    const timeSeries = response["Time Series (Daily)"];
    if (!timeSeries) return [];

    const entries = Object.entries(timeSeries)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-days);

    return entries.map(([date, data]) => ({
      date,
      open: parseFloat(data["1. open"]),
      high: parseFloat(data["2. high"]),
      low: parseFloat(data["3. low"]),
      close: parseFloat(data["4. close"]),
      volume: parseFloat(data["5. volume"]),
    }));
  }

  async getIntradayBars(symbol: string, timeframe: "1m" | "5m", days: number): Promise<DailyBar[]> {
    const interval = timeframe === "1m" ? "1min" : "5min";
    const response = await this.requestJson<AlphaVantageIntradayResponse>(
      `https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=full&apikey=${encodeURIComponent(this.apiKey)}`
    );

    const timeSeriesKey = `Time Series (${interval})` as keyof AlphaVantageIntradayResponse;
    const timeSeries = response[timeSeriesKey] as Record<string, any>;
    if (!timeSeries) return [];

    const entries = Object.entries(timeSeries)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(- (days * (timeframe === "1m" ? 1440 : 288))); // Approximate bars per day

    return entries.map(([timestamp, data]) => ({
      date: timestamp,
      open: parseFloat(data["1. open"]),
      high: parseFloat(data["2. high"]),
      low: parseFloat(data["3. low"]),
      close: parseFloat(data["4. close"]),
      volume: parseFloat(data["5. volume"]),
    }));
  }

  async getPriceBars(symbol: string, timeframe: Timeframe, bars: number): Promise<PriceBar[]> {
    this.assertApiKey();

    if (timeframe === "1d") {
      const dailyBars = await this.getDailyBars(symbol, Math.ceil(bars / 1));
      return dailyBars.slice(-bars).map((bar) => ({
        symbol,
        timeframe,
        timestamp: bar.date + "T00:00:00.000Z",
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    }

    if (timeframe === "1m" || timeframe === "5m") {
      const intradayBars = await this.getIntradayBars(symbol, timeframe, Math.ceil(bars / (timeframe === "1m" ? 1440 : 288)));
      return intradayBars.slice(-bars).map((bar) => ({
        symbol,
        timeframe,
        timestamp: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
    }

    // For other timeframes, we might need to aggregate, but for simplicity, use daily
    // Alpha Vantage doesn't have direct support for 15m, 1h, 4h
    // So fallback to daily for now
    const dailyBars = await this.getDailyBars(symbol, Math.ceil(bars / 1));
    return dailyBars.slice(-bars).map((bar) => ({
      symbol,
      timeframe,
      timestamp: bar.date + "T00:00:00.000Z",
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }

  private assertApiKey() {
    if (!this.hasApiKey()) {
      throw new Error("ALPHA_VANTAGE_API_KEY is required to use the Alpha Vantage market data provider.");
    }
  }

  private async requestJson<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Alpha Vantage request failed with ${response.status}: ${message.slice(0, 200)}`);
    }

    const payload = await response.json();
    if (payload["Error Message"]) {
      throw new Error(payload["Error Message"]);
    }
    if (payload["Note"]) {
      // API limit note
      throw new Error(payload["Note"]);
    }

    return payload as T;
  }
}