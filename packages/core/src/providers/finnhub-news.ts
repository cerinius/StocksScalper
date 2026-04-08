/**
 * Finnhub News Provider
 *
 * Uses the Finnhub.io REST API for financial news.
 * Free tier: 60 API calls/minute — plenty for the platform's polling schedule.
 *
 * Get a free API key at https://finnhub.io/register
 * Set FINNHUB_API_KEY in your .env.local
 *
 * Endpoints used:
 *   Company News:  GET /api/v1/company-news?symbol={}&from={}&to={}&token={}
 *   Market News:   GET /api/v1/news?category=general&minId={}&token={}
 *
 * Symbol mapping:
 *   Forex (EURUSD) and crypto (BTCUSD) news is fetched via market news with
 *   keyword filtering since Finnhub company-news only supports equities.
 */

import type { NewsItem } from "../types";
import type { NewsProvider } from "./news";

// ─── Finnhub API types ────────────────────────────────────────────────────────

interface FinnhubNewsArticle {
  category: string;
  datetime: number;   // Unix timestamp
  headline: string;
  id: number;
  image: string;
  related: string;    // comma-separated symbols
  source: string;
  summary: string;
  url: string;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export interface FinnhubNewsProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Days of news history to fetch. Default: 3 */
  lookbackDays?: number;
}

export class FinnhubNewsProvider implements NewsProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly lookbackDays: number;
  private readonly baseUrl = "https://finnhub.io/api/v1";
  private lastRequestAt = 0;
  private readonly minIntervalMs = 200; // Respect 60 req/min free tier

  constructor(options: FinnhubNewsProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookbackDays = options.lookbackDays ?? 3;
  }

  // ─── NewsProvider interface ─────────────────────────────────────────────────

  async getNews(symbol: string, days: number): Promise<NewsItem[]> {
    return this.fetchCompanyNews([symbol], days);
  }

  async getNewsForSymbols(symbols: string[], limitPerSymbol: number): Promise<NewsItem[]> {
    const equitySymbols = symbols.filter((s) => this.isEquity(s));
    const nonEquity = symbols.filter((s) => !this.isEquity(s));

    const all: NewsItem[] = [];

    // Fetch equity news symbol-by-symbol
    for (const symbol of equitySymbols) {
      const items = await this.fetchCompanyNews([symbol], this.lookbackDays);
      all.push(...items.slice(0, limitPerSymbol));
    }

    // For non-equity (forex, crypto, commodities), use market news with filtering
    if (nonEquity.length > 0) {
      const marketNews = await this.fetchMarketNews("forex");
      const cryptoNews = await this.fetchMarketNews("crypto");
      const general = await this.fetchMarketNews("general");

      const combined = [...marketNews, ...cryptoNews, ...general];

      for (const symbol of nonEquity) {
        const keyword = this.extractKeyword(symbol);
        const filtered = combined
          .filter((item) =>
            item.headline.toLowerCase().includes(keyword.toLowerCase()) ||
            item.summary?.toLowerCase().includes(keyword.toLowerCase()),
          )
          .slice(0, limitPerSymbol);
        all.push(...filtered);
      }
    }

    // Deduplicate by id
    const seen = new Set<string>();
    return all.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  async getMacroNews(limit: number): Promise<NewsItem[]> {
    const general = await this.fetchMarketNews("general");
    return general.slice(0, limit);
  }

  // ─── Internal helpers ───────────────────────────────────────────────────────

  private async fetchCompanyNews(symbols: string[], days: number): Promise<NewsItem[]> {
    const toDate = new Date();
    const fromDate = new Date(Date.now() - days * 86_400_000);
    const from = toDate.toISOString().slice(0, 10);
    const to = fromDate.toISOString().slice(0, 10);

    const all: NewsItem[] = [];
    for (const symbol of symbols) {
      if (!this.isEquity(symbol)) continue;
      try {
        await this.throttle();
        const url = `${this.baseUrl}/company-news?symbol=${encodeURIComponent(symbol)}&from=${to}&to=${from}&token=${this.apiKey}`;
        const data = await this.request<FinnhubNewsArticle[]>(url);
        all.push(...data.map((a) => this.toNewsItem(a, symbol)));
      } catch (err) {
        // Non-fatal: skip this symbol if Finnhub doesn't have data for it
      }
    }
    return all;
  }

  private async fetchMarketNews(category: "general" | "forex" | "crypto" | "merger"): Promise<NewsItem[]> {
    try {
      await this.throttle();
      const url = `${this.baseUrl}/news?category=${category}&token=${this.apiKey}`;
      const data = await this.request<FinnhubNewsArticle[]>(url);
      return data.map((a) => this.toNewsItem(a, ""));
    } catch {
      return [];
    }
  }

  private toNewsItem(article: FinnhubNewsArticle, defaultSymbol: string): NewsItem {
    const related = article.related ? article.related.split(",")[0].trim() : defaultSymbol;
    return {
      id: `finnhub-${article.id}`,
      symbol: related || defaultSymbol,
      publishedAt: new Date(article.datetime * 1000).toISOString(),
      headline: article.headline,
      source: article.source,
      url: article.url,
      summary: article.summary,
      tags: [article.category],
      sentiment: this.inferSentiment(article.headline + " " + article.summary),
    };
  }

  /** Very basic sentiment inference on the headline/summary text */
  private inferSentiment(text: string): string {
    const lower = text.toLowerCase();
    const bullishWords = ["surge", "soar", "gain", "rally", "beat", "exceed", "strong", "upgrade", "buy", "bullish", "grow", "rise", "record", "profit", "positive", "outperform"];
    const bearishWords = ["drop", "fall", "lose", "miss", "weak", "downgrade", "sell", "bearish", "decline", "crash", "loss", "negative", "underperform", "cut", "reduce", "risk", "warn"];

    let bullScore = 0;
    let bearScore = 0;
    for (const w of bullishWords) { if (lower.includes(w)) bullScore++; }
    for (const w of bearishWords) { if (lower.includes(w)) bearScore++; }

    if (bullScore > bearScore) return "positive";
    if (bearScore > bullScore) return "negative";
    return "neutral";
  }

  /** Returns true for US equity-style symbols (1-5 uppercase letters) */
  private isEquity(symbol: string): boolean {
    // Exclude forex (6 chars like EURUSD), crypto (7+ or ends USD like BTCUSD),
    // and commodities (contain =F)
    if (symbol.includes("=")) return false;
    if (/^[A-Z]{6}$/.test(symbol)) return false; // forex
    if (/^[A-Z]{3,5}USD$/.test(symbol)) return false; // crypto/commodity
    return /^[A-Z]{1,5}$/.test(symbol); // stock symbols
  }

  /** Extracts a search keyword from non-equity symbols */
  private extractKeyword(symbol: string): string {
    if (symbol === "EURUSD") return "EUR";
    if (symbol === "XAUUSD") return "gold";
    if (symbol === "BTCUSD") return "bitcoin";
    if (symbol === "ETHUSD") return "ethereum";
    // For other crypto: strip USD suffix
    if (symbol.endsWith("USD")) return symbol.slice(0, -3);
    return symbol;
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise<void>((r) => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  private async request<T>(url: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Finnhub request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Finnhub returns "You don't have access to this resource." as plain text on auth failure
    if (typeof data === "string") {
      throw new Error(`Finnhub API error: ${data}`);
    }

    return data as T;
  }
}
