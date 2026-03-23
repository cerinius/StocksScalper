import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { getExecutionOverview } from "./service";

export const executionPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/execution",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      return getExecutionOverview(parseLimit(query.limit, 30, 100));
    },
  );
};
