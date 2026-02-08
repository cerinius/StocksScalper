import { MockMarketDataProvider, MockNewsProvider } from "@stock-radar/core";
import { detectSwingSetups } from "@stock-radar/core";
import { prisma } from "@stock-radar/db";

const market = new MockMarketDataProvider();
const newsProvider = new MockNewsProvider();

export const dailyUpdate = async () => {
  const latestSnapshot = await prisma.universeSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    include: { items: { include: { symbol: true } } },
  });

  if (!latestSnapshot) return { updated: 0 };

  for (const item of latestSnapshot.items) {
    const bars = await market.getDailyBars(item.symbol.ticker, 60);
    const [latest, prev] = bars;
    if (!latest || !prev) continue;

    await prisma.dailyBar.upsert({
      where: { symbolId_date: { symbolId: item.symbolId, date: new Date(latest.date) } },
      update: {
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
      },
      create: {
        symbolId: item.symbolId,
        date: new Date(latest.date),
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
      },
    });

    await prisma.featureDaily.upsert({
      where: { symbolId_date: { symbolId: item.symbolId, date: new Date(latest.date) } },
      update: {
        atr14: 2,
        atrPct: 2.5,
        rvol: 1.2,
        sma20: latest.close * 0.98,
        sma50: latest.close * 0.95,
        sma200: latest.close * 0.9,
        returns20: 0.1,
        returns60: 0.2,
      },
      create: {
        symbolId: item.symbolId,
        date: new Date(latest.date),
        atr14: 2,
        atrPct: 2.5,
        rvol: 1.2,
        sma20: latest.close * 0.98,
        sma50: latest.close * 0.95,
        sma200: latest.close * 0.9,
        returns20: 0.1,
        returns60: 0.2,
      },
    });

    await prisma.levelMap.upsert({
      where: { symbolId_date: { symbolId: item.symbolId, date: new Date(latest.date) } },
      update: {
        prevHigh: prev.high,
        prevLow: prev.low,
        prevClose: prev.close,
        weekHigh: Math.max(...bars.slice(0, 5).map((bar) => bar.high)),
        weekLow: Math.min(...bars.slice(0, 5).map((bar) => bar.low)),
      },
      create: {
        symbolId: item.symbolId,
        date: new Date(latest.date),
        prevHigh: prev.high,
        prevLow: prev.low,
        prevClose: prev.close,
        weekHigh: Math.max(...bars.slice(0, 5).map((bar) => bar.high)),
        weekLow: Math.min(...bars.slice(0, 5).map((bar) => bar.low)),
      },
    });

    const news = await newsProvider.getNews(item.symbol.ticker, 7);
    for (const newsItem of news) {
      await prisma.newsItem.upsert({
        where: { url_publishedAt: { url: newsItem.url, publishedAt: new Date(newsItem.publishedAt) } },
        update: {
          headline: newsItem.headline,
          source: newsItem.source,
          summary: newsItem.summary,
          tags: newsItem.tags,
        },
        create: {
          symbolId: item.symbolId,
          publishedAt: new Date(newsItem.publishedAt),
          headline: newsItem.headline,
          source: newsItem.source,
          url: newsItem.url,
          summary: newsItem.summary,
          tags: newsItem.tags,
        },
      });
    }

    const setups = detectSwingSetups({
      symbol: item.symbol.ticker,
      bars,
      news,
      levels: {
        prevHigh: prev.high,
        prevLow: prev.low,
        weekHigh: Math.max(...bars.slice(0, 5).map((bar) => bar.high)),
        weekLow: Math.min(...bars.slice(0, 5).map((bar) => bar.low)),
      },
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
          relatedSnapshotId: latestSnapshot.id,
        },
      });
    }
  }

  return { updated: latestSnapshot.items.length };
};
