import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const tradingViewRoutes = async (app: FastifyInstance) => {
  app.post("/api/tradingview/webhook", async (request, reply) => {
    const secret = request.headers["x-webhook-secret"] as string | undefined;
    if (!secret || secret !== process.env.WEBHOOK_SECRET) {
      reply.status(401);
      return { error: "Unauthorized" };
    }

    const body = z
      .object({
        symbol: z.string(),
        eventType: z.string(),
        payload: z.record(z.unknown()).optional(),
      })
      .parse(request.body);

    const symbol = await prisma.symbol.findUnique({ where: { ticker: body.symbol } });
    if (!symbol) {
      reply.status(404);
      return { error: "Symbol not found" };
    }

    const candidate = await prisma.setupCandidate.findFirst({
      where: { symbolId: symbol.id },
      orderBy: { createdAt: "desc" },
    });

    if (!candidate) {
      reply.status(400);
      return { error: "No setup candidate to attach" };
    }

    const event = await prisma.setupEvent.create({
      data: {
        setupCandidateId: candidate.id,
        occurredAt: new Date(),
        eventType: body.eventType,
        payload: body.payload ?? {},
      },
    });

    return { stored: true, eventId: event.id };
  });
};
