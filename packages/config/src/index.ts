import { timeframes, tradingModes } from "@stock-radar/types";
import type { Timeframe, TradingMode } from "@stock-radar/types";
import { z } from "zod";

const booleanish = z.union([z.boolean(), z.string(), z.number()]).transform((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().default("stocks-scalper-platform"),
  DATABASE_URL: z.string().default("postgresql://stockradar:stockradar@localhost:55432/stockradar"),
  REDIS_URL: z.string().default("redis://localhost:56379"),
  API_PORT: z.coerce.number().int().positive().default(4210),
  WEB_PORT: z.coerce.number().int().positive().default(3210),
  GATEWAY_PORT: z.coerce.number().int().positive().default(4211),
  MT5_ADAPTER_PORT: z.coerce.number().int().positive().default(4310),
  POSTGRES_PORT: z.coerce.number().int().positive().default(55432),
  REDIS_PORT: z.coerce.number().int().positive().default(56379),
  API_BASE_URL: z.string().default("http://localhost:4210"),
  GATEWAY_BASE_URL: z.string().default("http://localhost:4211"),
  MT5_ADAPTER_URL: z.string().default("http://localhost:4310"),
  NEXT_PUBLIC_API_BASE: z.string().default("http://localhost:4210"),
  NEXT_PUBLIC_GATEWAY_BASE: z.string().default("http://localhost:4211"),
  DISCORD_WEBHOOK_URL: z.string().optional().default(""),
  TRADINGVIEW_WEBHOOK_SECRET: z.string().default("local-tv-secret"),
  WATCHLIST_SYMBOLS: z.string().default("AAPL,MSFT,NVDA,AMD,TSLA,SPY,QQQ,EURUSD,XAUUSD"),
  WATCHLIST_TIMEFRAMES: z.string().default("1m,5m,15m,1h,1d"),
  NEWS_URGENT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  NEWS_BROAD_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  MARKET_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  VALIDATION_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
  EXECUTION_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  SUPERVISOR_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
  DAILY_SUMMARY_CRON: z.string().default("55 23 * * *"),
  MT5_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  TRADING_MODE: z.enum(tradingModes).default("paper"),
  MANUAL_APPROVAL_MODE: booleanish.default(false),
  KILL_SWITCH: booleanish.default(false),
  MAX_ACTIVE_TRADES: z.coerce.number().int().positive().default(4),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),
  MAX_RISK_PER_TRADE_PCT: z.coerce.number().positive().default(0.75),
  MAX_TOTAL_EXPOSURE_PCT: z.coerce.number().positive().default(20),
  MAX_SYMBOL_EXPOSURE_PCT: z.coerce.number().positive().default(8),
  MAX_CORRELATED_EXPOSURE_PCT: z.coerce.number().positive().default(12),
  COOLDOWN_AFTER_LOSSES: z.coerce.number().int().positive().default(2),
  COOLDOWN_MINUTES: z.coerce.number().int().positive().default(45),
  STALE_SIGNAL_SECONDS: z.coerce.number().int().positive().default(300),
  LOCAL_ADMIN_EMAIL: z.string().default("admin@stockradar.local"),
  LOCAL_ADMIN_NAME: z.string().default("Local Admin")
});

export interface PlatformConfig {
  appName: string;
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  redisUrl: string;
  ports: {
    api: number;
    web: number;
    gateway: number;
    mt5Adapter: number;
    postgres: number;
    redis: number;
  };
  services: {
    apiBaseUrl: string;
    gatewayBaseUrl: string;
    mt5AdapterUrl: string;
    nextPublicApiBase: string;
    nextPublicGatewayBase: string;
  };
  discordWebhookUrl: string;
  tradingViewWebhookSecret: string;
  watchlistSymbols: string[];
  watchlistTimeframes: Timeframe[];
  schedules: {
    newsUrgentMs: number;
    newsBroadMs: number;
    marketScanMs: number;
    validationMs: number;
    executionMs: number;
    supervisorMs: number;
    dailySummaryCron: string;
    mt5SyncMs: number;
  };
  trading: {
    mode: TradingMode;
    manualApprovalMode: boolean;
    killSwitch: boolean;
  };
  risk: {
    maxActiveTrades: number;
    maxDailyLossPct: number;
    maxRiskPerTradePct: number;
    maxTotalExposurePct: number;
    maxSymbolExposurePct: number;
    maxCorrelatedExposurePct: number;
    cooldownAfterLosses: number;
    cooldownMinutes: number;
    staleSignalSeconds: number;
  };
  localAdmin: {
    email: string;
    name: string;
  };
}

const splitCsv = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseTimeframes = (value: string): Timeframe[] => {
  const items = splitCsv(value);
  return items.filter((item): item is Timeframe => (timeframes as readonly string[]).includes(item));
};

export const getPlatformConfig = (env: NodeJS.ProcessEnv = process.env): PlatformConfig => {
  const parsed = envSchema.parse(env);

  return {
    appName: parsed.APP_NAME,
    nodeEnv: parsed.NODE_ENV,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    ports: {
      api: parsed.API_PORT,
      web: parsed.WEB_PORT,
      gateway: parsed.GATEWAY_PORT,
      mt5Adapter: parsed.MT5_ADAPTER_PORT,
      postgres: parsed.POSTGRES_PORT,
      redis: parsed.REDIS_PORT,
    },
    services: {
      apiBaseUrl: parsed.API_BASE_URL,
      gatewayBaseUrl: parsed.GATEWAY_BASE_URL,
      mt5AdapterUrl: parsed.MT5_ADAPTER_URL,
      nextPublicApiBase: parsed.NEXT_PUBLIC_API_BASE,
      nextPublicGatewayBase: parsed.NEXT_PUBLIC_GATEWAY_BASE,
    },
    discordWebhookUrl: parsed.DISCORD_WEBHOOK_URL,
    tradingViewWebhookSecret: parsed.TRADINGVIEW_WEBHOOK_SECRET,
    watchlistSymbols: splitCsv(parsed.WATCHLIST_SYMBOLS),
    watchlistTimeframes: parseTimeframes(parsed.WATCHLIST_TIMEFRAMES),
    schedules: {
      newsUrgentMs: parsed.NEWS_URGENT_INTERVAL_MS,
      newsBroadMs: parsed.NEWS_BROAD_INTERVAL_MS,
      marketScanMs: parsed.MARKET_SCAN_INTERVAL_MS,
      validationMs: parsed.VALIDATION_INTERVAL_MS,
      executionMs: parsed.EXECUTION_INTERVAL_MS,
      supervisorMs: parsed.SUPERVISOR_INTERVAL_MS,
      dailySummaryCron: parsed.DAILY_SUMMARY_CRON,
      mt5SyncMs: parsed.MT5_SYNC_INTERVAL_MS,
    },
    trading: {
      mode: parsed.TRADING_MODE,
      manualApprovalMode: parsed.MANUAL_APPROVAL_MODE,
      killSwitch: parsed.KILL_SWITCH,
    },
    risk: {
      maxActiveTrades: parsed.MAX_ACTIVE_TRADES,
      maxDailyLossPct: parsed.MAX_DAILY_LOSS_PCT,
      maxRiskPerTradePct: parsed.MAX_RISK_PER_TRADE_PCT,
      maxTotalExposurePct: parsed.MAX_TOTAL_EXPOSURE_PCT,
      maxSymbolExposurePct: parsed.MAX_SYMBOL_EXPOSURE_PCT,
      maxCorrelatedExposurePct: parsed.MAX_CORRELATED_EXPOSURE_PCT,
      cooldownAfterLosses: parsed.COOLDOWN_AFTER_LOSSES,
      cooldownMinutes: parsed.COOLDOWN_MINUTES,
      staleSignalSeconds: parsed.STALE_SIGNAL_SECONDS,
    },
    localAdmin: {
      email: parsed.LOCAL_ADMIN_EMAIL,
      name: parsed.LOCAL_ADMIN_NAME,
    },
  };
};

export const getServicePort = (service: "api" | "web" | "gateway" | "mt5") => {
  const config = getPlatformConfig();
  if (service === "api") return config.ports.api;
  if (service === "web") return config.ports.web;
  if (service === "gateway") return config.ports.gateway;
  return config.ports.mt5Adapter;
};
