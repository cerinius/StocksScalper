import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { listValidationRuns } from "./service";

export const validationPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/validation",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      return listValidationRuns(parseLimit(query.limit, 30, 100));
    },
  );
};
