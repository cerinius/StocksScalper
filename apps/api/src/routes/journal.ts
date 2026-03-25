import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@stock-radar/db";

export const journalRoutes = async (app: FastifyInstance) => {
  app.get("/api/journal", async () => {
    return prisma.order.findMany({ include: { symbol: true }, orderBy: { submittedAt: "desc" } });
  });

  app.post("/api/journal", async (request) => {
    const body = z
      .object({
        symbolId: z.string(),
        direction: z.string(),
        quantity: z.number(),
        entryPrice: z.number(),
        stopLoss: z.number().optional(),
        takeProfit: z.number().optional(),
        notes: z.string().optional(),
      })
      .parse(request.body);

    return prisma.order.create({
      data: {
        symbolId: body.symbolId,
        integrationId: "manual",
        broker: "manual",
        mode: "PAPER",
        direction: body.direction,
        orderType: "MARKET",
        quantity: body.quantity,
        entryPrice: body.entryPrice,
        stopLoss: body.stopLoss ?? 0,
        takeProfit: body.takeProfit ?? 0,
        status: "PENDING",
        submittedAt: new Date(),
      },
    });
  });

  app.put("/api/journal/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        stopLoss: z.number().optional(),
        takeProfit: z.number().optional(),
        status: z.enum(["PENDING", "SUBMITTED", "FILLED", "REJECTED", "CANCELED"]).optional(),
      })
      .parse(request.body);

    return prisma.order.update({
      where: { id: params.id },
      data: body,
    });
  });
};
