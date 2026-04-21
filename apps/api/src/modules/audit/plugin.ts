import type { FastifyInstance } from "fastify";
import { parseListQuery } from "@stock-radar/shared";
import { authPreHandler, requireRole } from "../../lib/auth";
import { auditSummary, listAuditLogs, type AuditListQuery } from "./service";

const toStringOrUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export const auditPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/audit",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const { page, pageSize, direction } = parseListQuery(raw, {
        sort: "createdAt",
        direction: "desc",
        pageSize: 50,
        maxPageSize: 200,
      });
      const query: AuditListQuery = {
        page,
        pageSize,
        sortDirection: direction,
        category: toStringOrUndefined(raw.category),
        severity: toStringOrUndefined(raw.severity),
        actorType: toStringOrUndefined(raw.actorType),
        symbol: toStringOrUndefined(raw.symbol),
        correlationId: toStringOrUndefined(raw.correlationId),
        entityId: toStringOrUndefined(raw.entityId),
        from: toStringOrUndefined(raw.from),
        to: toStringOrUndefined(raw.to),
        search: toStringOrUndefined(raw.search),
      };
      return listAuditLogs(query);
    },
  );

  app.get(
    "/api/audit/summary",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const hours = Number(raw.hours ?? "24");
      return auditSummary(Number.isFinite(hours) && hours > 0 ? hours : 24);
    },
  );
};
