import { average } from "@stock-radar/shared";
import type { DailyBar, PriceBar, Timeframe, UniverseCandidate } from "../types";
import type { MarketDataProvider } from "./market-data";

const fiatCurrencies = new Set(["USD", "EUR", "JPY", "GBP", "CHF", "AUD", "NZD", "CAD"]);
const metalBases = new Set(["XAU", "XAG", "XPT", "XPD"]);
const knownEtfs = new Set(["SPY", "QQQ", "DIA", "IWM", "TLT", "GLD", "SLV", "USO"]);
const likelyCryptoBases = new Set([
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "ADA",
  "DOGE",
  "LTC",
  "BCH",
  "AVAX",
  "LINK",
  "DOT",
  "MATIC",
  "UNI",
  "ATOM",
  "TRX",
  "ETC",
]);
const pairQuoteCandidates = ["USDT", "USDC", "USD", "EUR", "JPY", "GBP", "CHF", "AUD", "NZD", "CAD", "BTC", "ETH"] as const;

type MassiveAssetType = "stocks" | "forex" | "crypto";
type DbAssetClass = "EQUITY" | "ETF" | "FX" | "COMMODITY" | "CRYPTO";

interface MassiveAggregateResult {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: number;
}

interface MassiveAggregateResponse {
  status?: string;
  error?: string;
  results?: MassiveAggregateResult[];
}

export interface MassiveMarketDataProviderOptions {
  apiKey: string;
  restBaseUrl?: string;
  watchlistSymbols?: string[];
  fetchImpl?: typeof fetch;
}

export interface MassiveSymbolDescriptor {
  inputSymbol: string;
  canonicalSymbol: string;
  assetType: MassiveAssetType;
  dbAssetClass: DbAssetClass;
  restTicker: string;
  websocketSubscriptions: string[];
  base?: string;
  quote?: string;
}

const stripPrefix = (symbol: string) => symbol.replace(/^(C:|X:)/, "");

const canonicalizeSymbol = (symbol: string) =>
  stripPrefix(symbol.trim().toUpperCase()).replace(/[/.:\-]/g, "");

const splitPair = (symbol: string) => {
  const canonical = canonicalizeSymbol(symbol);
  for (const quote of pairQuoteCandidates) {
    if (!canonical.endsWith(quote)) continue;
    const base = canonical.slice(0, -quote.length);
    if (base.length < 2) continue;
    return { base, quote };
  }

  return null;
};

const inferAssetType = (inputSymbol: string, pair: ReturnType<typeof splitPair>): MassiveAssetType => {
  if (inputSymbol.startsWith("C:")) return "forex";
  if (inputSymbol.startsWith("X:")) return "crypto";
  if (!pair) return "stocks";

  if (fiatCurrencies.has(pair.base) || metalBases.has(pair.base)) {
    return "forex";
  }

  if (likelyCryptoBases.has(pair.base)) {
    return "crypto";
  }

  if (["USD", "USDT", "USDC", "BTC", "ETH"].includes(pair.quote)) {
    return "crypto";
  }

  return "stocks";
};

const inferDbAssetClass = (canonicalSymbol: string, assetType: MassiveAssetType, pair: ReturnType<typeof splitPair>): DbAssetClass => {
  if (assetType === "crypto") return "CRYPTO";
  if (assetType === "forex") {
    return pair && metalBases.has(pair.base) ? "COMMODITY" : "FX";
  }

  return knownEtfs.has(canonicalSymbol) ? "ETF" : "EQUITY";
};

export const resolveMassiveSymbol = (inputSymbol: string): MassiveSymbolDescriptor => {
  const canonicalSymbol = canonicalizeSymbol(inputSymbol);
  const pair = splitPair(inputSymbol);
  const assetType = inferAssetType(inputSymbol.trim().toUpperCase(), pair);
  const dbAssetClass = inferDbAssetClass(canonicalSymbol, assetType, pair);

  if (assetType === "stocks") {
    return {
      inputSymbol,
      canonicalSymbol,
      assetType,
      dbAssetClass,
      restTicker: canonicalSymbol,
      websocketSubscriptions: [`A.${canonicalSymbol}`, `Q.${canonicalSymbol}`, `T.${canonicalSymbol}`],
    };
  }

  if (!pair) {
    throw new Error(`Unable to parse Massive pair symbol "${inputSymbol}".`);
  }

  if (assetType === "forex") {
    const pairWithSlash = `${pair.base}/${pair.quote}`;
    return {
      inputSymbol,
      canonicalSymbol,
      assetType,
      dbAssetClass,
      restTicker: `C:${pair.base}${pair.quote}`,
      websocketSubscriptions: [`CAS.${pairWithSlash}`, `C.${pairWithSlash}`],
      base: pair.base,
      quote: pair.quote,
    };
  }

  const pairWithDash = `${pair.base}-${pair.quote}`;
  return {
    inputSymbol,
    canonicalSymbol,
    assetType,
    dbAssetClass,
    restTicker: `X:${pair.base}${pair.quote}`,
    websocketSubscriptions: [`XAS.${pairWithDash}`, `XT.${pairWithDash}`],
    base: pair.base,
    quote: pair.quote,
  };
};

const timeframeConfig: Record<
  Timeframe,
  { multiplier: number; timespan: "minute" | "hour" | "day"; lookbackDays: number }
> = {
  "1m": { multiplier: 1, timespan: "minute", lookbackDays: 7 },
  "5m": { multiplier: 5, timespan: "minute", lookbackDays: 14 },
  "15m": { multiplier: 15, timespan: "minute", lookbackDays: 21 },
  "1h": { multiplier: 1, timespan: "hour", lookbackDays: 60 },
  "4h": { multiplier: 4, timespan: "hour", lookbackDays: 180 },
  "1d": { multiplier: 1, timespan: "day", lookbackDays: 400 },
};

const toIsoDate = (value: Date) => value.toISOString().slice(0, 10);

export class MassiveMarketDataProvider implements MarketDataProvider {
  private readonly apiKey: string;
  private readonly restBaseUrl: string;
  private readonly watchlistSymbols: string[];
  private readonly fetchImpl: typeof fetch;

  constructor(options: MassiveMarketDataProviderOptions) {
    this.apiKey = options.apiKey;
    this.restBaseUrl = (options.restBaseUrl ?? "https://api.massive.com").replace(/\/+$/, "");
    this.watchlistSymbols = options.watchlistSymbols ?? [];
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  hasApiKey() {
    return this.apiKey.trim().length > 0;
  }

  async getUniverse(): Promise<UniverseCandidate[]> {
    const symbols = this.watchlistSymbols.slice(0, 25);
    const universe = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const bars = await this.getPriceBars(symbol, "1d", 20);
          const latest = bars.at(-1);
          if (!latest) return null;

          const avgVolume = average(bars.map((bar) => bar.volume));
          const high = Math.max(...bars.map((bar) => bar.high));
          const low = Math.min(...bars.map((bar) => bar.low));
          const atrPct = latest.close === 0 ? 0 : ((high - low) / latest.close) * 100;

          return {
            symbol: resolveMassiveSymbol(symbol).canonicalSymbol,
            metrics: {
              price: latest.close,
              dollarVolume: latest.close * avgVolume,
              avgVolume,
              atrPct,
              rvol: 1,
              trendScore: 0.5,
              catalystScore: 0.2,
            },
          } satisfies UniverseCandidate;
        } catch {
          return null;
        }
      }),
    );

    return universe.filter((candidate): candidate is UniverseCandidate => candidate !== null);
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
    const bars = await this.getPriceBars(symbol, timeframe, Math.max(days * (timeframe === "1m" ? 120 : 48), 60));
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
    this.assertApiKey();

    const descriptor = resolveMassiveSymbol(symbol);
    const config = timeframeConfig[timeframe];
    const to = new Date();
    const from = new Date(to.getTime() - config.lookbackDays * 86_400_000);
    const limit = Math.min(Math.max(bars * 2, 200), 50_000);
    const response = await this.requestJson<MassiveAggregateResponse>(
      `/v2/aggs/ticker/${descriptor.restTicker}/range/${config.multiplier}/${config.timespan}/${toIsoDate(from)}/${toIsoDate(to)}?adjusted=true&sort=desc&limit=${limit}`,
    );
    const results = [...(response.results ?? [])].reverse().slice(-bars);

    return results.map((bar) => ({
      symbol: descriptor.canonicalSymbol,
      timeframe,
      timestamp: new Date(bar.t).toISOString(),
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
    }));
  }

  private assertApiKey() {
    if (!this.hasApiKey()) {
      throw new Error("MASSIVE_API_KEY is required to use the Massive market data provider.");
    }
  }

  private async requestJson<T>(pathWithQuery: string): Promise<T> {
    const separator = pathWithQuery.includes("?") ? "&" : "?";
    const response = await this.fetchImpl(`${this.restBaseUrl}${pathWithQuery}${separator}apiKey=${encodeURIComponent(this.apiKey)}`, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Massive REST request failed with ${response.status}: ${message.slice(0, 200)}`);
    }

    const payload = (await response.json()) as MassiveAggregateResponse;
    if (payload.error) {
      throw new Error(payload.error);
    }

    return payload as T;
  }
}
