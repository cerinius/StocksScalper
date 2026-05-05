import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { getExposureOverview } from "./service";

export const exposurePlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/exposure",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as { limit?: string };
      return getExposureOverview({ limit: parseLimit(query.limit, 120, 500) });
    },
  );
};
