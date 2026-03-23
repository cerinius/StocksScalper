import type { DailyBar, SetupTimeframe, SetupType } from "../types";

type JsonMap = Record<string, unknown>;

export type BacktestOutcome =
  | "win"
  | "loss"
  | "expired"
  | "not_triggered"
  | "insufficient_data";

export interface EvaluatableSetup {
  id: string;
  symbol: string;
  createdAt: string;
  setupType: SetupType;
  timeframe: SetupTimeframe;
  confidence: number;
  trigger: JsonMap | null | undefined;
  invalidation: JsonMap | null | undefined;
  targets: JsonMap | null | undefined;
}

export interface SetupBacktestResult {
  setupId: string;
  symbol: string;
  setupType: SetupType;
  timeframe: SetupTimeframe;
  createdAt: string;
  confidence: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  outcome: BacktestOutcome;
  entryAt: string | null;
  exitAt: string | null;
  holdBars: number;
  rMultiple: number | null;
  returnPct: number | null;
}

export interface StrategyScorecard {
  key: string;
  setupType: SetupType;
  timeframe: SetupTimeframe;
  sampleSize: number;
  triggeredCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  expired: number;
  pending: number;
  winRate: number;
  expectancyR: number;
  averageReturnPct: number;
  averageHoldBars: number;
  averageConfidence: number;
}

export interface RankedSetup {
  setupId: string;
  symbol: string;
  setupType: SetupType;
  timeframe: SetupTimeframe;
  createdAt: string;
  confidence: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  priorityScore: number;
  strategyWinRate: number;
  strategyExpectancyR: number;
  strategySampleSize: number;
}

const SWING_HOLD_BARS = 15;
const SCALP_HOLD_BARS = 12;

const isJsonMap = (value: unknown): value is JsonMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getNumericField = (value: JsonMap | null | undefined, key: string): number | null => {
  if (!value || !isJsonMap(value)) return null;

  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
};

const toAscendingBars = (bars: DailyBar[]): DailyBar[] =>
  [...bars].sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());

const toIsoString = (value: string): string => new Date(value).toISOString();

const average = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, current) => total + current, 0) / values.length;

export const getTradeLevels = (setup: Pick<EvaluatableSetup, "trigger" | "invalidation" | "targets">) => {
  const entry = getNumericField(setup.trigger, "level");
  const stop = getNumericField(setup.invalidation, "level");

  if (entry === null || stop === null || stop >= entry) {
    return {
      entry,
      stop,
      target: getNumericField(setup.targets, "level"),
      riskReward: null,
    };
  }

  const risk = entry - stop;
  const fixedTarget = getNumericField(setup.targets, "level");
  const atrMultiple = getNumericField(setup.targets, "atrMultiple");
  const target = fixedTarget ?? (atrMultiple !== null ? entry + risk * atrMultiple : entry + risk * 2);
  const riskReward = target > entry ? (target - entry) / risk : null;

  return { entry, stop, target, riskReward };
};

export const backtestSetup = (setup: EvaluatableSetup, bars: DailyBar[]): SetupBacktestResult => {
  const { entry, stop, target, riskReward } = getTradeLevels(setup);
  const baseResult: SetupBacktestResult = {
    setupId: setup.id,
    symbol: setup.symbol,
    setupType: setup.setupType,
    timeframe: setup.timeframe,
    createdAt: setup.createdAt,
    confidence: setup.confidence,
    entry,
    stop,
    target,
    riskReward,
    outcome: "insufficient_data",
    entryAt: null,
    exitAt: null,
    holdBars: 0,
    rMultiple: null,
    returnPct: null,
  };

  if (entry === null || stop === null || target === null || stop >= entry) {
    return baseResult;
  }

  const createdAt = new Date(setup.createdAt).getTime();
  const evaluationBars = toAscendingBars(bars)
    .filter((bar) => new Date(bar.date).getTime() >= createdAt)
    .slice(0, setup.timeframe === "swing" ? SWING_HOLD_BARS : SCALP_HOLD_BARS);

  if (evaluationBars.length === 0) {
    return baseResult;
  }

  const risk = entry - stop;
  let inTrade = false;
  let entryAt: string | null = null;
  let exitAt: string | null = null;
  let lastClose = evaluationBars[evaluationBars.length - 1]?.close ?? entry;
  let holdBars = 0;

  for (const bar of evaluationBars) {
    lastClose = bar.close;

    if (!inTrade) {
      if (bar.high < entry) {
        continue;
      }

      inTrade = true;
      entryAt = toIsoString(bar.date);
    }

    holdBars += 1;

    const stopHit = bar.low <= stop;
    const targetHit = bar.high >= target;

    if (stopHit && targetHit) {
      exitAt = toIsoString(bar.date);
      return {
        ...baseResult,
        entryAt,
        exitAt,
        holdBars,
        outcome: "loss",
        rMultiple: -1,
        returnPct: ((stop - entry) / entry) * 100,
      };
    }

    if (stopHit) {
      exitAt = toIsoString(bar.date);
      return {
        ...baseResult,
        entryAt,
        exitAt,
        holdBars,
        outcome: "loss",
        rMultiple: -1,
        returnPct: ((stop - entry) / entry) * 100,
      };
    }

    if (targetHit) {
      exitAt = toIsoString(bar.date);
      return {
        ...baseResult,
        entryAt,
        exitAt,
        holdBars,
        outcome: "win",
        rMultiple: (target - entry) / risk,
        returnPct: ((target - entry) / entry) * 100,
      };
    }
  }

  if (!inTrade) {
    return {
      ...baseResult,
      outcome: "not_triggered",
      holdBars: 0,
    };
  }

  return {
    ...baseResult,
    entryAt,
    exitAt: toIsoString(evaluationBars[evaluationBars.length - 1].date),
    holdBars,
    outcome: "expired",
    rMultiple: (lastClose - entry) / risk,
    returnPct: ((lastClose - entry) / entry) * 100,
  };
};

export const buildStrategyScorecards = (results: SetupBacktestResult[]): StrategyScorecard[] => {
  const groups = new Map<string, SetupBacktestResult[]>();

  for (const result of results) {
    const key = `${result.timeframe}:${result.setupType}`;
    const existing = groups.get(key) ?? [];
    existing.push(result);
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const closed = group.filter((result) => ["win", "loss", "expired"].includes(result.outcome));
      const wins = group.filter((result) => result.outcome === "win").length;
      const losses = group.filter((result) => result.outcome === "loss").length;
      const expired = group.filter((result) => result.outcome === "expired").length;
      const pending = group.filter((result) =>
        ["not_triggered", "insufficient_data"].includes(result.outcome),
      ).length;

      return {
        key,
        setupType: group[0].setupType,
        timeframe: group[0].timeframe,
        sampleSize: group.length,
        triggeredCount: group.filter((result) => result.entryAt !== null).length,
        closedCount: closed.length,
        wins,
        losses,
        expired,
        pending,
        winRate: closed.length === 0 ? 0 : wins / closed.length,
        expectancyR: average(closed.flatMap((result) => (result.rMultiple === null ? [] : [result.rMultiple]))),
        averageReturnPct: average(
          closed.flatMap((result) => (result.returnPct === null ? [] : [result.returnPct])),
        ),
        averageHoldBars: average(closed.map((result) => result.holdBars)),
        averageConfidence: average(group.map((result) => result.confidence)),
      };
    })
    .sort((left, right) => {
      if (right.expectancyR !== left.expectancyR) {
        return right.expectancyR - left.expectancyR;
      }

      if (right.winRate !== left.winRate) {
        return right.winRate - left.winRate;
      }

      return right.sampleSize - left.sampleSize;
    });
};

export const rankTradeCandidates = (
  setups: EvaluatableSetup[],
  scorecards: StrategyScorecard[],
): RankedSetup[] => {
  const scorecardMap = new Map(scorecards.map((scorecard) => [scorecard.key, scorecard]));

  return setups
    .map((setup) => {
      const levels = getTradeLevels(setup);
      const scorecard = scorecardMap.get(`${setup.timeframe}:${setup.setupType}`);
      const strategyWinRate = scorecard?.winRate ?? 0;
      const strategyExpectancyR = scorecard?.expectancyR ?? 0;
      const strategySampleSize = scorecard?.sampleSize ?? 0;
      const priorityScore =
        setup.confidence * 0.45 +
        strategyWinRate * 35 +
        Math.max(strategyExpectancyR, 0) * 20 +
        (levels.riskReward ?? 0) * 8;

      return {
        setupId: setup.id,
        symbol: setup.symbol,
        setupType: setup.setupType,
        timeframe: setup.timeframe,
        createdAt: setup.createdAt,
        confidence: setup.confidence,
        entry: levels.entry,
        stop: levels.stop,
        target: levels.target,
        riskReward: levels.riskReward,
        priorityScore,
        strategyWinRate,
        strategyExpectancyR,
        strategySampleSize,
      };
    })
    .sort((left, right) => right.priorityScore - left.priorityScore);
};
