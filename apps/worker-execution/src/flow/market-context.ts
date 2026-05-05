import { calculatePearsonCorrelation } from "@stock-radar/core";
import { prisma } from "@stock-radar/db";
import { getPlatformConfig } from "@stock-radar/config";

const config = getPlatformConfig();

export const getQuote = async (symbol: string, mid: number) => {
  try {
    const response = await fetch(`${config.services.mt5AdapterUrl}/quote/${symbol}?mid=${mid}`);
    if (!response.ok) return null;
    return (await response.json()) as { bid: number; ask: number; mid: number; spreadPct: number };
  } catch {
    return null;
  }
};

const getRecentCloses = async (symbolId: string, timeframe: string, take: number) => {
  const bars = await prisma.priceBar.findMany({
    where: { symbolId, timeframe },
    orderBy: { timestamp: "desc" },
    take,
  });
  return bars.map((bar: { close: number }) => bar.close).reverse();
};

/**
 * Build a single candidate's per-account-agnostic market context
 * (spread, correlation). This is shared across all candidate×account
 * evaluations because the correlation to an open position on account
 * X is still about symbol-level price action.
 */
export const getCorrelationContext = async (
  candidate: { symbolId: string; timeframe: string; direction: string },
  openPositions: Array<{ symbolId: string; direction: string; exposurePct: number; symbol: { ticker: string } }>,
) => {
  if (openPositions.length === 0) {
    return { correlatedExposurePct: 0, correlatedSymbols: [] as string[] };
  }

  const candidateCloses = await getRecentCloses(candidate.symbolId, candidate.timeframe, config.risk.correlationLookbackBars);
  if (candidateCloses.length < 8) {
    return { correlatedExposurePct: 0, correlatedSymbols: [] as string[] };
  }

  let correlatedExposurePct = 0;
  const correlatedSymbols: string[] = [];
  for (const position of openPositions) {
    const positionCloses = await getRecentCloses(position.symbolId, candidate.timeframe, config.risk.correlationLookbackBars);
    const correlation = Math.abs(calculatePearsonCorrelation(candidateCloses, positionCloses));
    if (correlation < config.risk.correlationBlockThreshold) continue;
    if (position.direction !== candidate.direction) continue;
    correlatedExposurePct += position.exposurePct;
    correlatedSymbols.push(`${position.symbol.ticker} (${correlation.toFixed(2)})`);
  }
  return {
    correlatedExposurePct: Number(correlatedExposurePct.toFixed(2)),
    correlatedSymbols,
  };
};
