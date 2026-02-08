import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const universeRoutes = async (app: FastifyInstance) => {
  app.get("/api/universe/current", async () => {
    const latest = await prisma.universeSnapshot.findFirst({
      orderBy: { snapshotDate: "desc" },
      include: { items: { include: { symbol: true }, orderBy: { rank: "asc" } } },
    });
    return latest ?? { items: [] };
  });

  app.get("/api/universe/:date", async (request) => {
    const params = z.object({ date: z.string() }).parse(request.params);
    const snapshotDate = new Date(params.date);
    return prisma.universeSnapshot.findFirst({
      where: { snapshotDate },
      include: { items: { include: { symbol: true }, orderBy: { rank: "asc" } } },
    });
  });

  app.get("/api/universe/history", async (request) => {
    const query = z.object({ symbol: z.string().optional() }).parse(request.query);
    if (!query.symbol) {
      return prisma.universeSnapshot.findMany({ orderBy: { snapshotDate: "desc" } });
    }

    const symbol = await prisma.symbol.findUnique({ where: { ticker: query.symbol } });
    if (!symbol) return [];

    return prisma.universeSnapshotItem.findMany({
      where: { symbolId: symbol.id },
      include: { snapshot: true },
      orderBy: { snapshot: { snapshotDate: "desc" } },
    });
  });
};
