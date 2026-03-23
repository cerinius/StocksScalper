import type { NewsItem } from "../types";

export interface NewsProvider {
  getNews(symbol: string, days: number): Promise<NewsItem[]>;
  getMacroNews(limit: number): Promise<NewsItem[]>;
}
