import type { FastifyInstance } from "fastify";
import { parseListQuery } from "@stock-radar/shared";
import { authPreHandler, requireRole } from "../../lib/auth";
import { parseLimit } from "../../lib/http";
import {
  getExecutionOverview,
  listExecutionDecisions,
  listOrders,
  listRiskEvents,
  type ExecutionListQuery,
  type OrderListQuery,
  type RiskEventListQuery,
} from "./service";

const toStringOrUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export const executionPlugin = async (app: FastifyInstance) => {
  // Legacy overview endpoint kept for backwards compatibility.
  app.get(
    "/api/execution",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const query = request.query as Record<string, string | undefined>;
      return getExecutionOverview(parseLimit(query.limit, 30, 100));
    },
  );

  app.get(
    "/api/execution/decisions",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const { page, pageSize, sort, direction } = parseListQuery(raw, {
        sort: "createdAt",
        direction: "desc",
        pageSize: 25,
      });
      const query: ExecutionListQuery = {
        page,
        pageSize,
        sort,
        sortDirection: direction,
        symbol: toStringOrUndefined(raw.symbol),
        action: toStringOrUndefined(raw.action),
        status: toStringOrUndefined(raw.status),
        strategy: toStringOrUndefined(raw.strategy),
        from: toStringOrUndefined(raw.from),
        to: toStringOrUndefined(raw.to),
        search: toStringOrUndefined(raw.search),
      };
      return listExecutionDecisions(query);
    },
  );

  app.get(
    "/api/execution/orders",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const { page, pageSize, direction } = parseListQuery(raw, {
        sort: "createdAt",
        direction: "desc",
        pageSize: 25,
      });
      const query: OrderListQuery = {
        page,
        pageSize,
        sort: "createdAt",
        sortDirection: direction,
        symbol: toStringOrUndefined(raw.symbol),
        status: toStringOrUndefined(raw.status),
        from: toStringOrUndefined(raw.from),
        to: toStringOrUndefined(raw.to),
      };
      return listOrders(query);
    },
  );

  app.get(
    "/api/execution/risk-events",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const { page, pageSize, direction } = parseListQuery(raw, {
        sort: "createdAt",
        direction: "desc",
        pageSize: 25,
      });
      const query: RiskEventListQuery = {
        page,
        pageSize,
        sortDirection: direction,
        severity: toStringOrUndefined(raw.severity),
        blockingOnly: raw.blockingOnly === "true",
        from: toStringOrUndefined(raw.from),
        to: toStringOrUndefined(raw.to),
      };
      return listRiskEvents(query);
    },
  );
};
