import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { listTradeIdeas } from "./service";

export const tradeIdeasPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/trade-ideas",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      return listTradeIdeas({
        symbol: query.symbol,
        timeframe: query.timeframe,
        status: query.status,
        limit: parseLimit(query.limit, 40, 200),
      });
    },
  );
};
