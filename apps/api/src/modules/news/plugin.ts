import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit, parseOffset } from "../../lib/http";
import { listNewsItems } from "./service";

export const newsPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/news",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      return listNewsItems({
        symbol: query.symbol,
        urgency: query.urgency,
        limit: parseLimit(query.limit, 25, 100),
        offset: parseOffset(query.offset, 0),
      });
    },
  );
};
