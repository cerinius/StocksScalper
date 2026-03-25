import { average, clamp } from "@stock-radar/shared";

export interface MonteCarloOptions {
  simulations?: number;
  riskPerTradePct?: number;
  ruinDrawdownPct?: number;
  seed?: number;
}

export interface MonteCarloSummary {
  simulations: number;
  riskPerTradePct: number;
  ruinDrawdownPct: number;
  riskOfRuinPct: number;
  expectedReturnPct: number;
  medianReturnPct: number;
  bestReturnPct: number;
  worstReturnPct: number;
  drawdownPct50: number;
  drawdownPct95: number;
}

interface SimulationResult {
  returnPct: number;
  maxDrawdownPct: number;
}

const createRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_295;
  };
};

const percentile = (values: number[], pct: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((pct / 100) * (sorted.length - 1))));
  return sorted[index];
};

const shuffle = (values: number[], random: () => number) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
};

const simulateSequence = (outcomesR: number[], riskPerTradePct: number, random: () => number): SimulationResult => {
  let equity = 100;
  let peakEquity = 100;
  let maxDrawdownPct = 0;

  for (const outcome of shuffle(outcomesR, random)) {
    equity *= 1 + (outcome * riskPerTradePct) / 100;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peakEquity - equity) / Math.max(peakEquity, 1)) * 100);
  }

  return {
    returnPct: equity - 100,
    maxDrawdownPct,
  };
};

export const runMonteCarloSimulation = (
  outcomesR: number[],
  options: MonteCarloOptions = {},
): MonteCarloSummary => {
  const simulations = Math.max(1, options.simulations ?? 1000);
  const riskPerTradePct = clamp(options.riskPerTradePct ?? 0.75, 0.05, 5);
  const ruinDrawdownPct = clamp(options.ruinDrawdownPct ?? 20, 5, 95);

  if (outcomesR.length === 0) {
    return {
      simulations,
      riskPerTradePct,
      ruinDrawdownPct,
      riskOfRuinPct: 0,
      expectedReturnPct: 0,
      medianReturnPct: 0,
      bestReturnPct: 0,
      worstReturnPct: 0,
      drawdownPct50: 0,
      drawdownPct95: 0,
    };
  }

  const random = createRng(options.seed ?? 42);
  const results = Array.from({ length: simulations }).map(() => simulateSequence(outcomesR, riskPerTradePct, random));
  const returns = results.map((result) => result.returnPct);
  const drawdowns = results.map((result) => result.maxDrawdownPct);
  const ruined = drawdowns.filter((value) => value >= ruinDrawdownPct).length;

  return {
    simulations,
    riskPerTradePct,
    ruinDrawdownPct,
    riskOfRuinPct: ruined / simulations,
    expectedReturnPct: average(returns),
    medianReturnPct: percentile(returns, 50),
    bestReturnPct: Math.max(...returns),
    worstReturnPct: Math.min(...returns),
    drawdownPct50: percentile(drawdowns, 50),
    drawdownPct95: percentile(drawdowns, 95),
  };
};
