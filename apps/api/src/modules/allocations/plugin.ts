import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { listAllocationDecisions } from "./service";

export const allocationsPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/allocations",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as {
        limit?: string;
        status?: string;
        policy?: string;
        setupKey?: string;
        accountId?: string;
        selectedOnly?: string;
        search?: string;
      };
      return listAllocationDecisions({
        limit: parseLimit(query.limit, 50, 200),
        status: query.status,
        policy: query.policy,
        setupKey: query.setupKey,
        accountId: query.accountId,
        selectedOnly: query.selectedOnly === "true",
        search: query.search,
      });
    },
  );
};
