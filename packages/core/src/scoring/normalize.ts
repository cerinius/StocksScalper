import type { ScoredCandidate, ScoreWeights, UniverseCandidate } from "../types";

export const winsorize = (values: number[], lowerPct = 0.05, upperPct = 0.95): number[] => {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const lowerIdx = Math.floor(lowerPct * (sorted.length - 1));
  const upperIdx = Math.ceil(upperPct * (sorted.length - 1));
  const lower = sorted[lowerIdx];
  const upper = sorted[upperIdx];
  return values.map((value) => Math.min(Math.max(value, lower), upper));
};

export const minMaxNormalize = (values: number[]): number[] => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return values.map(() => 0.5);
  return values.map((value) => (value - min) / (max - min));
};

export const scoreUniverse = (
  candidates: UniverseCandidate[],
  weights: ScoreWeights,
): ScoredCandidate[] => {
  const liquidity = winsorize(candidates.map((c) => c.metrics.dollarVolume));
  const volatility = winsorize(candidates.map((c) => c.metrics.atrPct));
  const volume = winsorize(candidates.map((c) => c.metrics.rvol));
  const trend = winsorize(candidates.map((c) => c.metrics.trendScore));
  const catalyst = winsorize(candidates.map((c) => c.metrics.catalystScore));

  const normLiquidity = minMaxNormalize(liquidity);
  const normVolatility = minMaxNormalize(volatility);
  const normVolume = minMaxNormalize(volume);
  const normTrend = minMaxNormalize(trend);
  const normCatalyst = minMaxNormalize(catalyst);

  const totalWeight =
    weights.liquidity + weights.volatility + weights.volume + weights.trend + weights.catalyst;

  return candidates.map((candidate, idx) => {
    const liquidityScore = normLiquidity[idx] * weights.liquidity;
    const volatilityScore = normVolatility[idx] * weights.volatility;
    const volumeScore = normVolume[idx] * weights.volume;
    const trendScore = normTrend[idx] * weights.trend;
    const catalystScore = normCatalyst[idx] * weights.catalyst;
    const totalScore =
      ((liquidityScore + volatilityScore + volumeScore + trendScore + catalystScore) / totalWeight) *
      100;

    return {
      symbol: candidate.symbol,
      totalScore,
      components: {
        liquidityScore,
        volatilityScore,
        volumeScore,
        trendScore,
        catalystScore,
      },
      metrics: candidate.metrics,
    };
  });
};
