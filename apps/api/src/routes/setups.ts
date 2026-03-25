import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const setupRoutes = async (app: FastifyInstance) => {
  app.get("/api/setups", async (request) => {
    const query = z
      .object({
        status: z
          .enum(["NEW", "SCANNED", "VALIDATING", "VALIDATED", "REJECTED", "EXECUTED", "CLOSED", "INVALIDATED"])
          .optional(),
        tf: z.string().optional(),
      })
      .parse(request.query);

    return prisma.tradeCandidate.findMany({
      where: {
        status: query.status ?? undefined,
        timeframe: query.tf ?? undefined,
      },
      include: { symbol: true },
      orderBy: { detectedAt: "desc" },
    });
  });

  app.get("/api/setups/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return prisma.tradeCandidate.findUnique({ where: { id: params.id }, include: { symbol: true } });
  });

  app.post("/api/setups/:id/status", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({ status: z.enum(["NEW", "SCANNED", "VALIDATING", "VALIDATED", "REJECTED", "EXECUTED", "CLOSED", "INVALIDATED"]) })
      .parse(request.body);

    return prisma.tradeCandidate.update({
      where: { id: params.id },
      data: { status: body.status },
    });
  });
};
