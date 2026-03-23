import {
  backtestSetup,
  buildStrategyScorecards,
  rankTradeCandidates,
  type DailyBar,
  type EvaluatableSetup,
  type SetupType,
  type Timeframe,
} from "@stock-radar/core";
import { prisma } from "@stock-radar/db";
import { createProviders } from "./providers";

interface SetupRecord {
  id: string;
  createdAt: Date;
  setupType: SetupType;
  timeframe: Timeframe;
  status: string;
  confidence: number;
  trigger: unknown;
  invalidation: unknown;
  targets: unknown;
  symbol: {
    ticker: string;
  };
}

interface TradeRecord {
  id: string;
  createdAt: Date;
  setupType: SetupType;
  direction: string;
  entry: number;
  stop: number;
  target: number;
  exit: number | null;
  pnl: number | null;
  notes: string | null;
  symbol: {
    ticker: string;
  };
}

const { market } = createProviders();

const toJsonMap = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const mapSetupRecord = (setup: SetupRecord): EvaluatableSetup => ({
  id: setup.id,
  symbol: setup.symbol.ticker,
  createdAt: setup.createdAt.toISOString(),
  setupType: setup.setupType,
  timeframe: setup.timeframe,
  confidence: setup.confidence,
  trigger: toJsonMap(setup.trigger),
  invalidation: toJsonMap(setup.invalidation),
  targets: toJsonMap(setup.targets),
});

const loadBarsForSetups = async (setups: EvaluatableSetup[]) => {
  const keys = [...new Set(setups.map((setup) => `${setup.symbol}:${setup.timeframe}`))];

  const bars = await Promise.all(
    keys.map(async (key) => {
      const [symbol, timeframe] = key.split(":") as [string, Timeframe];
      const data =
        timeframe === "swing"
          ? await market.getDailyBars(symbol, 60)
          : await market.getIntradayBars(symbol, "5m", 20);

      return [key, data] as const;
    }),
  );

  return new Map<string, DailyBar[]>(bars);
};

const sum = (values: number[]) => values.reduce((total, current) => total + current, 0);

const getTradePnl = (trade: TradeRecord): number => {
  if (trade.pnl !== null) return trade.pnl;
  if (trade.exit === null) return 0;

  const direction = trade.direction.toLowerCase() === "short" ? -1 : 1;
  return (trade.exit - trade.entry) * direction;
};

const getBacktestPayload = async (limit = 250) => {
  const setupRecords = (await prisma.setupCandidate.findMany({
    include: { symbol: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  })) as SetupRecord[];

  const setups = setupRecords.map(mapSetupRecord);
  const barsBySetup = await loadBarsForSetups(setups);
  const evaluations = setups.map((setup) => {
    const bars = barsBySetup.get(`${setup.symbol}:${setup.timeframe}`) ?? [];
    return backtestSetup(setup, bars);
  });

  const scorecards = buildStrategyScorecards(evaluations);
  const watchedSetups = setupRecords
    .filter((setup) => setup.status === "watch")
    .map(mapSetupRecord);
  const rankedCandidates = rankTradeCandidates(watchedSetups, scorecards).slice(0, 8);

  return {
    generatedAt: new Date().toISOString(),
    evaluations,
    scorecards,
    rankedCandidates,
  };
};

export const getBacktestReport = async (limit = 250) => {
  const { generatedAt, evaluations, scorecards, rankedCandidates } = await getBacktestPayload(limit);

  return {
    generatedAt,
    scorecards,
    topCandidates: rankedCandidates,
    recentEvaluations: evaluations
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .slice(0, 40),
  };
};

export const getDashboardOverview = async () => {
  const [
    latestSnapshot,
    watchSetupCount,
    journalEntriesRaw,
    recentTradesRaw,
    backtestPayload,
  ] = await Promise.all([
    prisma.universeSnapshot.findFirst({
      orderBy: { snapshotDate: "desc" },
      include: { items: true },
    }),
    prisma.setupCandidate.count({ where: { status: "watch" } }),
    prisma.tradeJournal.findMany({ include: { symbol: true }, orderBy: { createdAt: "desc" } }) as Promise<
      TradeRecord[]
    >,
    prisma.tradeJournal.findMany({
      include: { symbol: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }) as Promise<TradeRecord[]>,
    getBacktestPayload(),
  ]);

  const journalEntries = journalEntriesRaw as TradeRecord[];
  const recentTrades = recentTradesRaw as TradeRecord[];
  const { generatedAt, evaluations, scorecards, rankedCandidates } = backtestPayload;

  const closedTrades = journalEntries.filter((trade) => trade.exit !== null || trade.pnl !== null);
  const realizedPnl = sum(closedTrades.map(getTradePnl));
  const winningTrades = closedTrades.filter((trade) => getTradePnl(trade) > 0).length;
  const openTrades = journalEntries.filter((trade) => trade.exit === null).length;
  const evaluatedSetups = evaluations.filter((evaluation) => evaluation.outcome !== "insufficient_data").length;

  return {
    generatedAt,
    snapshot: latestSnapshot
      ? {
          snapshotDate: latestSnapshot.snapshotDate.toISOString(),
          universeSize: latestSnapshot.items.length,
          notes: latestSnapshot.notes,
        }
      : null,
    metrics: {
      trackedUniverse: latestSnapshot?.items.length ?? 0,
      watchSetups: watchSetupCount,
      openTrades,
      closedTrades: closedTrades.length,
      realizedPnl,
      tradeWinRate: closedTrades.length === 0 ? 0 : winningTrades / closedTrades.length,
      evaluatedSetups,
    },
    topCandidates: rankedCandidates,
    strategyScorecards: scorecards.slice(0, 6),
    recentTrades: recentTrades.map((trade) => ({
      id: trade.id,
      symbol: trade.symbol.ticker,
      createdAt: trade.createdAt.toISOString(),
      setupType: trade.setupType,
      direction: trade.direction,
      entry: trade.entry,
      stop: trade.stop,
      target: trade.target,
      exit: trade.exit,
      pnl: getTradePnl(trade),
      notes: trade.notes,
    })),
  };
};
