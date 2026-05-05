import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { getBridgeOverview } from "./service";

export const bridgePlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/bridge",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as { limit?: string };
      return getBridgeOverview({ limit: parseLimit(query.limit, 120, 500) });
    },
  );
};
