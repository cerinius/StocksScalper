import type { FastifyInstance } from "fastify";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import { listAuditLogs } from "./service";

export const auditPlugin = async (app: FastifyInstance) => {
  app.get("/api/audit", { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return listAuditLogs({
      category: query.category,
      symbol: query.symbol,
      limit: parseLimit(query.limit, 40, 200),
    });
  });
};
