import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const universeRoutes = async (app: FastifyInstance) => {
  app.get("/api/universe/current", async () => {
    return prisma.symbol.findMany({ where: { isActive: true }, orderBy: { ticker: "asc" } });
  });

  app.get("/api/universe/:ticker", async (request) => {
    const params = z.object({ ticker: z.string() }).parse(request.params);
    return prisma.symbol.findUnique({ where: { ticker: params.ticker } });
  });

  app.get("/api/universe/history", async (request) => {
    const query = z.object({ symbol: z.string().optional() }).parse(request.query);
    if (!query.symbol) {
      return prisma.symbol.findMany({ where: { isActive: true }, orderBy: { ticker: "asc" } });
    }

    return prisma.priceBar.findMany({
      where: { symbol: { ticker: query.symbol } },
      orderBy: { timestamp: "desc" },
      take: 200,
    });
  });
};
