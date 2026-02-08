import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const journalRoutes = async (app: FastifyInstance) => {
  app.get("/api/journal", async () => {
    return prisma.tradeJournal.findMany({ include: { symbol: true }, orderBy: { createdAt: "desc" } });
  });

  app.post("/api/journal", async (request) => {
    const body = z
      .object({
        symbolId: z.string(),
        setupType: z.string(),
        direction: z.string(),
        entry: z.number(),
        stop: z.number(),
        target: z.number(),
        exit: z.number().optional(),
        pnl: z.number().optional(),
        notes: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .parse(request.body);

    return prisma.tradeJournal.create({
      data: {
        ...body,
        tags: body.tags ?? undefined,
      },
    });
  });

  app.put("/api/journal/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        entry: z.number().optional(),
        stop: z.number().optional(),
        target: z.number().optional(),
        exit: z.number().optional(),
        pnl: z.number().optional(),
        notes: z.string().optional(),
        tags: z.array(z.string()).optional(),
      })
      .parse(request.body);

    return prisma.tradeJournal.update({
      where: { id: params.id },
      data: { ...body, tags: body.tags ?? undefined },
    });
  });
};
