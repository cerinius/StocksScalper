import { z } from "zod";

export const workerTypes = ["news", "market", "validation", "execution", "supervisor"] as const;
export type WorkerType = (typeof workerTypes)[number];

export const integrationKinds = ["discord", "tradingview", "mt5", "market_data", "news_data"] as const;
export type IntegrationKind = (typeof integrationKinds)[number];

export const severityLevels = ["info", "warning", "critical"] as const;
export type SeverityLevel = (typeof severityLevels)[number];

export const tradeDirections = ["LONG", "SHORT"] as const;
export type TradeDirection = (typeof tradeDirections)[number];

export const tradingModes = ["paper", "live"] as const;
export type TradingMode = (typeof tradingModes)[number];

export const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof timeframes)[number];

export const decisionActions = ["PLACE", "HOLD", "SKIP", "CLOSE", "REDUCE", "INVALIDATE"] as const;
export type DecisionAction = (typeof decisionActions)[number];

export const candidateStatuses = [
  "NEW",
  "SCANNED",
  "VALIDATING",
  "VALIDATED",
  "REJECTED",
  "EXECUTED",
  "CLOSED",
  "INVALIDATED",
] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

export const validationStatuses = ["PENDING", "PASSED", "FAILED", "STALE"] as const;
export type ValidationStatus = (typeof validationStatuses)[number];

export const newsUrgencies = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type NewsUrgency = (typeof newsUrgencies)[number];

export const directionalBiases = ["BULLISH", "BEARISH", "NEUTRAL"] as const;
export type DirectionalBias = (typeof directionalBiases)[number];

export const volatilityImpacts = ["LOW", "MEDIUM", "HIGH"] as const;
export type VolatilityImpact = (typeof volatilityImpacts)[number];

export const orderStatuses = ["PENDING", "SUBMITTED", "FILLED", "REJECTED", "CANCELED"] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const positionStatuses = ["OPEN", "REDUCED", "CLOSED"] as const;
export type PositionStatus = (typeof positionStatuses)[number];

export const riskStates = ["NORMAL", "CAUTION", "BLOCKED", "KILL_SWITCH"] as const;
export type RiskState = (typeof riskStates)[number];

export const notificationCategories = [
  "worker_health",
  "trade_event",
  "risk_event",
  "daily_summary",
  "integration",
  "market_news",
  "supervisor",
] as const;
export type NotificationCategory = (typeof notificationCategories)[number];

export interface ReasoningEntry {
  title: string;
  detail: string;
  weight: number;
  tags: string[];
}

export interface PriceBar {
  symbol: string;
  timeframe: Timeframe;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketIndicatorSnapshot {
  sma20: number;
  sma50: number;
  ema21: number;
  ema50: number;
  rsi14: number;
  macd: number;
  macdSignal: number;
  atr14: number;
  atrPct: number;
  volumeRatio: number;
  trendStrength: number;
  momentumScore: number;
}

export interface NewsIntelligenceRecord {
  source: string;
  headline: string;
  summary: string;
  originalTimestamp: string;
  ingestionTimestamp: string;
  affectedSymbols: string[];
  affectedAssetClasses: string[];
  directionalBias: DirectionalBias;
  urgency: NewsUrgency;
  relevanceScore: number;
  volatilityImpact: VolatilityImpact;
  confidence: number;
  tags: string[];
  category: string;
  rawPayloadRef: string;
  reasoningLog: ReasoningEntry[];
  dedupeHash: string;
  status: string;
}

export interface TradeCandidateRecord {
  symbol: string;
  timeframe: Timeframe;
  direction: TradeDirection;
  strategyType: string;
  detectedAt: string;
  currentPrice: number;
  proposedEntry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  confidenceScore: number;
  setupScore: number;
  featureValues: Record<string, number>;
  indicatorSnapshot: MarketIndicatorSnapshot;
  reasoningLog: ReasoningEntry[];
  status: CandidateStatus;
  correlationTags: string[];
  volatilityClassification: string;
}

export interface ValidationMetrics {
  winRateEstimate: number;
  averageReturn: number;
  averageAdverseExcursion: number;
  averageFavorableExcursion: number;
  maxDrawdown: number;
  profitFactor: number;
  expectancy: number;
  confidenceScore: number;
  confidenceIntervalLow: number;
  confidenceIntervalHigh: number;
  historicalSampleSize: number;
  dataQualityNotes: string[];
}

export interface SupportingReference {
  type: "news" | "candidate" | "validation" | "position" | "audit" | "webhook";
  id: string;
  label: string;
}

export interface StructuredDecision {
  action: DecisionAction;
  confidence: number;
  riskScore: number;
  evidenceSummary: string;
  reasons: ReasoningEntry[];
  blockingReasons: ReasoningEntry[];
  supportingReferences: SupportingReference[];
  executionParameters: {
    symbol: string;
    direction: TradeDirection;
    quantity: number;
    entry: number;
    stopLoss: number;
    takeProfit: number;
    timeInForce: string;
  } | null;
  createdAt: string;
}

export interface AccountStateSnapshot {
  balance: number;
  equity: number;
  freeMargin: number;
  usedMargin: number;
  openPnl: number;
  realizedPnlDaily: number;
  drawdownPct: number;
  maxDrawdownPct: number;
  riskState: RiskState;
  killSwitchActive: boolean;
  mode: TradingMode;
}

export interface ExecutionPositionSnapshot {
  symbol: string;
  direction: TradeDirection;
  quantity: number;
  averageEntryPrice: number;
  unrealizedPnl: number;
  exposurePct: number;
  correlationTags: string[];
}

export interface DiscordNotificationPayload {
  category: NotificationCategory;
  severity: SeverityLevel;
  title: string;
  body: string;
  dedupeKey: string;
  metadata: Record<string, unknown>;
}

export interface WorkerHealthSnapshot {
  workerType: WorkerType;
  status: "healthy" | "degraded" | "offline";
  lastHeartbeatAt: string;
  lagMs: number;
  currentTask: string;
  failureCount24h: number;
}

export interface DashboardSnapshot {
  account: AccountStateSnapshot | null;
  activeTrades: number;
  recentActions: Array<{ message: string; createdAt: string; severity: SeverityLevel }>;
  riskWarnings: Array<{ message: string; createdAt: string }>;
  workerHealth: WorkerHealthSnapshot[];
  killSwitchActive: boolean;
}

export const reasoningEntrySchema = z.object({
  title: z.string().min(1),
  detail: z.string().min(1),
  weight: z.number().min(0).max(1),
  tags: z.array(z.string()),
});

export const structuredDecisionSchema = z.object({
  action: z.enum(decisionActions),
  confidence: z.number().min(0).max(100),
  riskScore: z.number().min(0).max(100),
  evidenceSummary: z.string(),
  reasons: z.array(reasoningEntrySchema),
  blockingReasons: z.array(reasoningEntrySchema),
  supportingReferences: z.array(
    z.object({
      type: z.enum(["news", "candidate", "validation", "position", "audit", "webhook"]),
      id: z.string(),
      label: z.string(),
    }),
  ),
  executionParameters: z
    .object({
      symbol: z.string(),
      direction: z.enum(tradeDirections),
      quantity: z.number().positive(),
      entry: z.number().positive(),
      stopLoss: z.number().positive(),
      takeProfit: z.number().positive(),
      timeInForce: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
});

export const tradingViewWebhookSchema = z.object({
  alertName: z.string().min(1),
  symbol: z.string().min(1),
  timeframe: z.string().default("5m"),
  direction: z.enum(tradeDirections).default("LONG"),
  message: z.string().default(""),
  strategy: z.string().default("tradingview"),
  price: z.number().positive().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const mt5ConnectRequestSchema = z.object({
  server: z.string().min(1),
  login: z.string().min(1),
  password: z.string().min(1),
  terminalPath: z.string().optional(),
  mode: z.enum(tradingModes).default("paper"),
});

export const mt5OrderRequestSchema = z.object({
  symbol: z.string().min(1),
  direction: z.enum(tradeDirections),
  quantity: z.number().positive(),
  entry: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  timeInForce: z.string().default("GTC"),
  decisionId: z.string().min(1),
});

export type TradingViewWebhookPayload = z.infer<typeof tradingViewWebhookSchema>;
export type Mt5ConnectRequest = z.infer<typeof mt5ConnectRequestSchema>;
export type Mt5OrderRequest = z.infer<typeof mt5OrderRequestSchema>;
