import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const setupRoutes = async (app: FastifyInstance) => {
  app.get("/api/setups", async (request) => {
    const query = z
      .object({ status: z.string().optional(), tf: z.string().optional() })
      .parse(request.query);

    return prisma.setupCandidate.findMany({
      where: {
        status: query.status ?? undefined,
        timeframe: query.tf ?? undefined,
      },
      include: { symbol: true },
      orderBy: { createdAt: "desc" },
    });
  });

  app.get("/api/setups/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return prisma.setupCandidate.findUnique({ where: { id: params.id }, include: { symbol: true } });
  });

  app.post("/api/setups/:id/status", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ status: z.enum(["watch", "triggered", "invalidated", "expired"]) })
      .parse(request.body);

    return prisma.setupCandidate.update({
      where: { id: params.id },
      data: { status: body.status },
    });
  });
};
