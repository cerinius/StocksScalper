import { MockMarketDataProvider } from "@stock-radar/core";
import { detectScalpSetups } from "@stock-radar/core";
import { prisma } from "@stock-radar/db";

const market = new MockMarketDataProvider();

export const intradayScan = async () => {
  const latestSnapshot = await prisma.universeSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    include: { items: { include: { symbol: true } } },
  });

  if (!latestSnapshot) return { scanned: 0 };

  for (const item of latestSnapshot.items) {
    const bars = await market.getIntradayBars(item.symbol.ticker, "5m", 5);
    const [latest] = bars;
    if (!latest) continue;

    await prisma.intradayBar.upsert({
      where: {
        symbolId_ts_timeframe: {
          symbolId: item.symbolId,
          ts: new Date(latest.date),
          timeframe: "5m",
        },
      },
      update: {
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
      },
      create: {
        symbolId: item.symbolId,
        ts: new Date(latest.date),
        timeframe: "5m",
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
      },
    });

    const setups = detectScalpSetups({
      symbol: item.symbol.ticker,
      bars,
      vwap: latest.close * 0.99,
      openingRangeHigh: latest.high * 0.98,
      openingRangeLow: latest.low * 1.02,
      yesterdayHigh: latest.high * 0.97,
      yesterdayLow: latest.low * 1.01,
    });

    for (const setup of setups) {
      await prisma.setupCandidate.create({
        data: {
          symbolId: item.symbolId,
          setupType: setup.setupType,
          timeframe: setup.timeframe,
          status: "watch",
          confidence: setup.confidence,
          trigger: setup.trigger,
          invalidation: setup.invalidation,
          targets: setup.targets,
          explanation: setup.explanation,
        },
      });
    }
  }

  return { scanned: latestSnapshot.items.length };
};
