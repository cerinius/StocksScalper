import type { NewsItem } from "../types";
import type { NewsProvider } from "./news";

type PolygonNewsArticle = {
  id: string;
  title: string;
  article_url?: string;
  description?: string;
  image_url?: string;
  published_utc: string;
  tickers?: string[];
  keywords?: string[];
  publisher?: {
    name?: string;
  };
};

type PolygonNewsResponse = {
  results?: PolygonNewsArticle[];
};

export interface PolygonNewsProviderOptions {
  apiKey: string;
  restBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

const getSymbolTag = (value?: string) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().toUpperCase() : "UNKNOWN";

export class PolygonNewsProvider implements NewsProvider {
  private readonly apiKey: string;
  private readonly restBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PolygonNewsProviderOptions) {
    this.apiKey = options.apiKey;
    this.restBaseUrl = (options.restBaseUrl ?? "https://api.polygon.io").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private buildItem(article: PolygonNewsArticle): NewsItem {
    return {
      symbol: article.tickers && article.tickers.length > 0 ? getSymbolTag(article.tickers[0]) : "",
      publishedAt: article.published_utc,
      headline: article.title,
      source: article.publisher?.name ?? "Polygon",
      url: article.article_url ?? "",
      summary: article.description,
      tags: article.keywords ?? [],
    };
  }

  private async request(path: string): Promise<PolygonNewsArticle[]> {
    const url = `${this.restBaseUrl}${path}${path.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(this.apiKey)}`;
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Polygon API error ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as PolygonNewsResponse;
    return payload.results ?? [];
  }

  async getNews(symbol: string, days: number): Promise<NewsItem[]> {
    const limit = Math.max(20, Math.min(days * 15, 200));
    const articles = await this.request(`/v2/reference/news?tickers=${encodeURIComponent(symbol)}&limit=${limit}`);
    return articles.map((article) => this.buildItem(article));
  }

  async getMacroNews(limit: number): Promise<NewsItem[]> {
    const articles = await this.request(`/v2/reference/news?sort=published_utc&order=desc&limit=${limit}`);
    return articles.map((article) => this.buildItem(article));
  }
}
