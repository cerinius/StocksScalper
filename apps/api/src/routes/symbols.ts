import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const symbolRoutes = async (app: FastifyInstance) => {
  app.get("/api/symbols", async (request) => {
    const query = z.object({ search: z.string().optional() }).parse(request.query);
    return prisma.symbol.findMany({
      where: query.search
        ? {
            OR: [
              { ticker: { contains: query.search, mode: "insensitive" } },
              { name: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : undefined,
      orderBy: { ticker: "asc" },
      take: 50,
    });
  });

  app.get("/api/symbol/:ticker/summary", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    const symbol = await prisma.symbol.findUnique({ where: { ticker: params.ticker } });
    if (!symbol) return null;

    const latestPriceBar = await prisma.priceBar.findFirst({
      where: { symbolId: symbol.id },
      orderBy: { timestamp: "desc" },
    });

    const latestSnapshot = await prisma.marketSnapshot.findFirst({
      where: { symbolId: symbol.id },
      orderBy: { snapshotAt: "desc" },
    });

    return {
      symbol,
      latestPriceBar,
      latestSnapshot,
    };
  });

  app.get("/api/symbol/:ticker/daily", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(request.query);
    const symbol = await prisma.symbol.findUnique({ where: { ticker: params.ticker } });
    if (!symbol) return [];

    return prisma.priceBar.findMany({
      where: {
        symbolId: symbol.id,
        timeframe: "1d",
        timestamp: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      orderBy: { timestamp: "asc" },
    });
  });

  app.get("/api/symbol/:ticker/intraday", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    const query = z
      .object({ tf: z.string().default("5m"), from: z.string().optional(), to: z.string().optional() })
      .parse(request.query);
    const symbol = await prisma.symbol.findUnique({ where: { ticker: params.ticker } });
    if (!symbol) return [];

    return prisma.priceBar.findMany({
      where: {
        symbolId: symbol.id,
        timeframe: query.tf,
        timestamp: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      orderBy: { timestamp: "asc" },
      take: 500,
    });
  });

  app.get("/api/symbol/:ticker/news", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    const query = z.object({ days: z.string().optional() }).parse(request.query);
    const symbol = await prisma.symbol.findUnique({ where: { ticker: params.ticker } });
    if (!symbol) return [];

    const days = Number(query.days ?? "7");
    const since = new Date(Date.now() - days * 86_400_000);

    return prisma.symbolNewsLink.findMany({
      where: {
        symbolId: symbol.id,
        newsItem: {
          originalTimestamp: { gte: since },
        },
      },
      include: { newsItem: true },
      orderBy: { newsItem: { originalTimestamp: "desc" } },
    });
  });
};
