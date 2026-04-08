import { stableHash } from "@stock-radar/shared";
import type { NewsItem } from "../types";
import type { NewsProvider } from "./news";

type AlphaVantageArticle = {
  title: string;
  url: string;
  time_published: string;
  authors: string[];
  summary: string;
  banner_image: string;
  source: string;
  category_within_source: string;
  source_domain: string;
  topics: {
    topic: string;
    relevance_score: string;
  }[];
  overall_sentiment_score: number;
  overall_sentiment_label: string;
  ticker_sentiment: {
    ticker: string;
    relevance_score: string;
    ticker_sentiment_score: string;
    ticker_sentiment_label: string;
  }[];
};

type AlphaVantageNewsResponse = {
  feed?: AlphaVantageArticle[];
};

export interface AlphaVantageNewsProviderOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

const getSymbolTag = (value?: string) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().toUpperCase() : "UNKNOWN";

export class AlphaVantageNewsProvider implements NewsProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AlphaVantageNewsProviderOptions) {
    if (!options.apiKey) {
      throw new Error("Alpha Vantage API key is required");
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildItem(article: AlphaVantageArticle, symbol?: string): NewsItem {
    const tickerSentiment = symbol
      ? article.ticker_sentiment.find((t) => t.ticker === symbol)
      : article.ticker_sentiment[0];

    const publishedAt = new Date(
      `${article.time_published.slice(0, 4)}-${article.time_published.slice(4, 6)}-${article.time_published.slice(6, 8)}T${article.time_published.slice(9, 11)}:${article.time_published.slice(11, 13)}:${article.time_published.slice(13, 15)}Z`
    ).toISOString();

    return {
      symbol: tickerSentiment?.ticker ?? symbol ?? "UNKNOWN",
      publishedAt,
      headline: article.title,
      source: article.source,
      url: article.url,
      summary: article.summary,
      tags: article.topics.map((t) => t.topic),
      sentiment: tickerSentiment?.ticker_sentiment_label,
      sentimentScore: parseFloat(tickerSentiment?.ticker_sentiment_score ?? "0") || article.overall_sentiment_score,
      id: stableHash(article.url),
    };
  }

  private async request(path: string): Promise<AlphaVantageArticle[]> {
    const url = `https://www.alphavantage.co${path}&apikey=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetchImpl(url, { headers: { "User-Agent": "StocksScalper" } });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Alpha Vantage API error ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as AlphaVantageNewsResponse;
    if (!payload.feed) {
      // Alpha Vantage returns a success response with an error message in the payload
      // for invalid requests or API limits.
      const anyPayload = payload as any;
      if (anyPayload.Information || anyPayload.Note) {
        throw new Error(`Alpha Vantage API error: ${anyPayload.Information || anyPayload.Note}`);
      }
    }
    return payload.feed ?? [];
  }

  async getNews(symbol: string, days: number): Promise<NewsItem[]> {
    const limit = Math.max(20, Math.min(days * 15, 200));
    const articles = await this.request(
      `/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(symbol)}&limit=${limit}`
    );
    return articles.map((article) => this.buildItem(article, symbol));
  }

  async getNewsForSymbols(symbols: string[], limitPerSymbol: number): Promise<NewsItem[]> {
    const allNews: NewsItem[] = [];
    for (const symbol of symbols) {
      try {
        const news = await this.getNews(symbol, limitPerSymbol);
        allNews.push(...news);
        // Add a delay to avoid hitting the rate limit.
        // This is a simple solution. A more robust solution would use a proper rate-limiting library.
        await new Promise((resolve) => setTimeout(resolve, 15000)); // 15 seconds
      } catch (error) {
        console.error(`Failed to fetch news for symbol ${symbol}:`, error);
      }
    }
    return allNews;
  }

  async getMacroNews(limit: number): Promise<NewsItem[]> {
    const articles = await this.request(`/query?function=NEWS_SENTIMENT&limit=${limit}`);
    return articles.map((article) => this.buildItem(article));
  }
}
