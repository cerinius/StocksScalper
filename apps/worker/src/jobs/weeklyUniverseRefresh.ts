import { prisma } from "@stock-radar/db";
import { MockMarketDataProvider } from "@stock-radar/core";
import { scoreUniverse } from "@stock-radar/core";

const weights = {
  liquidity: 35,
  volatility: 25,
  volume: 20,
  trend: 10,
  catalyst: 10,
};

export const weeklyUniverseRefresh = async () => {
  const provider = new MockMarketDataProvider();
  const candidates = await provider.getUniverse();

  const filtered = candidates.filter(
    (candidate) =>
      candidate.metrics.price >= 5 &&
      candidate.metrics.price <= 500 &&
      candidate.metrics.dollarVolume >= 50_000_000 &&
      candidate.metrics.avgVolume >= 2_000_000 &&
      candidate.metrics.atrPct >= 2,
  );

  const scored = scoreUniverse(filtered, weights)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 100);

  const snapshot = await prisma.universeSnapshot.create({
    data: {
      snapshotDate: new Date(),
      notes: "Weekly universe refresh",
    },
  });

  for (const [idx, item] of scored.entries()) {
    const symbol = await prisma.symbol.upsert({
      where: { ticker: item.symbol },
      update: {},
      create: { ticker: item.symbol, name: item.symbol, exchange: "NASDAQ" },
    });

    await prisma.universeSnapshotItem.create({
      data: {
        snapshotId: snapshot.id,
        symbolId: symbol.id,
        rank: idx + 1,
        totalScore: item.totalScore,
        liquidityScore: item.components.liquidityScore,
        volatilityScore: item.components.volatilityScore,
        volumeScore: item.components.volumeScore,
        trendScore: item.components.trendScore,
        catalystScore: item.components.catalystScore,
        metrics: item.metrics,
      },
    });
  }

  return { snapshotId: snapshot.id, total: scored.length };
};
