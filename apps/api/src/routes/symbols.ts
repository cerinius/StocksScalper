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

    const latestFeature = await prisma.featureDaily.findFirst({
      where: { symbolId: symbol.id },
      orderBy: { date: "desc" },
    });
    const latestLevel = await prisma.levelMap.findFirst({
      where: { symbolId: symbol.id },
      orderBy: { date: "desc" },
    });
    return { symbol, latestFeature, latestLevel };
  });

  app.get("/api/symbol/:ticker/daily", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    const query = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(request.query);
    const symbol = await prisma.symbol.findUnique({ where: { ticker: params.ticker } });
    if (!symbol) return [];

    return prisma.dailyBar.findMany({
      where: {
        symbolId: symbol.id,
        date: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      orderBy: { date: "asc" },
    });
  });

  app.get("/api/symbol/:ticker/intraday", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    const query = z
      .object({ tf: z.string().default("5m"), from: z.string().optional(), to: z.string().optional() })
      .parse(request.query);
    const symbol = await prisma.symbol.findUnique({ where: { ticker: params.ticker } });
    if (!symbol) return [];

    return prisma.intradayBar.findMany({
      where: {
        symbolId: symbol.id,
        timeframe: query.tf,
        ts: {
          gte: query.from ? new Date(query.from) : undefined,
          lte: query.to ? new Date(query.to) : undefined,
        },
      },
      orderBy: { ts: "asc" },
    });
  });

  app.get("/api/symbol/:ticker/news", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    const query = z.object({ days: z.string().optional() }).parse(request.query);
    const symbol = await prisma.symbol.findUnique({ where: { ticker: params.ticker } });
    if (!symbol) return [];

    const days = Number(query.days ?? "7");
    const since = new Date(Date.now() - days * 86_400_000);

    return prisma.newsItem.findMany({
      where: { symbolId: symbol.id, publishedAt: { gte: since } },
      orderBy: { publishedAt: "desc" },
    });
  });
};
