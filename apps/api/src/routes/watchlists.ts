import { prisma } from "@stock-radar/db";
import { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const createWatchlistSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

const updateWatchlistSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
});

const addSymbolSchema = z.object({
  symbol: z.string(),
});

const watchlists: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/watchlists", async () => {
    return prisma.watchlist.findMany({
      include: {
        items: {
          include: {
            symbol: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  });

  fastify.post("/api/watchlists", async (request, reply) => {
    const body = createWatchlistSchema.parse(request.body);
    const watchlist = await prisma.watchlist.create({
      data: {
        name: body.name,
        description: body.description,
        tier: "default",
        scanIntervalMs: 60000,
      },
    });
    return reply.status(201).send(watchlist);
  });

  fastify.get("/api/watchlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const watchlist = await prisma.watchlist.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            symbol: true,
          },
        },
      },
    });
    if (!watchlist) {
      return reply.status(404).send({ message: "Watchlist not found" });
    }
    return watchlist;
  });

  fastify.put("/api/watchlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateWatchlistSchema.parse(request.body);

    if (body.isActive) {
      // Deactivate all other watchlists
      await prisma.watchlist.updateMany({
        where: {
          isActive: true,
          NOT: {
            id: id,
          },
        },
        data: {
          isActive: false,
        },
      });
    }

    const watchlist = await prisma.watchlist.update({
      where: { id },
      data: body,
    });
    return watchlist;
  });

  fastify.delete("/api/watchlists/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.watchlist.delete({ where: { id } });
    return reply.status(204).send();
  });

  fastify.post("/api/watchlists/:id/symbols", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { symbol: ticker } = addSymbolSchema.parse(request.body);

    const symbol = await prisma.symbol.upsert({
      where: { ticker },
      update: {},
      create: {
        ticker,
        name: ticker,
        assetClass: "EQUITY", // default to EQUITY for now
      },
    });

    const watchlistItem = await prisma.watchlistItem.create({
      data: {
        watchlistId: id,
        symbolId: symbol.id,
      },
    });
    return reply.status(201).send(watchlistItem);
  });

  fastify.delete("/api/watchlists/:id/symbols/:symbolId", async (request, reply) => {
    const { id: watchlistId, symbolId } = request.params as { id: string; symbolId: string };
    await prisma.watchlistItem.delete({
      where: {
        watchlistId_symbolId: {
          watchlistId,
          symbolId,
        },
      },
    });
    return reply.status(204).send();
  });
};

export default watchlists;
