import { createHash } from "node:crypto";
import type { PriceBar, ReasoningEntry, Timeframe } from "@stock-radar/types";

export const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMD", "TSLA", "SPY", "QQQ", "EURUSD", "XAUUSD"];

export const nowIso = () => new Date().toISOString();

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const stableHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const average = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((total, current) => total + current, 0) / values.length;

export const standardDeviation = (values: number[]) => {
  if (values.length === 0) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
};

export const buildReasoningLog = (entries: Array<{ title: string; detail: string; weight?: number; tags?: string[] }>) =>
  entries.map<ReasoningEntry>((entry) => ({
    title: entry.title,
    detail: entry.detail,
    weight: clamp(entry.weight ?? 0.5, 0, 1),
    tags: entry.tags ?? [],
  }));

export const percentChange = (start: number, end: number) => {
  if (start === 0) return 0;
  return ((end - start) / start) * 100;
};

export const createMockBars = (symbol: string, timeframe: Timeframe, count: number, seed = 1): PriceBar[] => {
  const intervalMsByTimeframe: Record<Timeframe, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };

  return Array.from({ length: count }).map((_, index) => {
    const trend = seed * 0.2 + index * 0.15;
    const base = 100 + trend + Math.sin(index / 5) * 2;
    const high = base + 1.4 + Math.cos(index / 6) * 0.8;
    const low = base - 1.3 - Math.sin(index / 7) * 0.7;
    const close = base + Math.sin(index / 4) * 0.9;
    const open = base - Math.cos(index / 3) * 0.6;

    return {
      symbol,
      timeframe,
      timestamp: new Date(Date.now() - (count - index) * intervalMsByTimeframe[timeframe]).toISOString(),
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: 100_000 + index * 4_000 + seed * 800,
    };
  });
};

export const createMockHeadline = (symbol: string, index: number) =>
  [
    `${symbol} rallies after revenue beat and raised guidance`,
    `${symbol} fades as macro yields climb ahead of CPI`,
    `${symbol} attracts unusual options flow into the close`,
    `${symbol} trades firmly after sector upgrade`,
  ][index % 4];
