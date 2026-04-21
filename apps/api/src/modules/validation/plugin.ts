import type { FastifyInstance } from "fastify";
import { parseListQuery } from "@stock-radar/shared";
import { authPreHandler, requireRole } from "../../lib/auth";
import { listValidationRuns, type ValidationListQuery } from "./service";

const toNumber = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const toStringOrUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

export const validationPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/validation",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const { page, pageSize, sort, direction } = parseListQuery(raw, {
        sort: "createdAt",
        direction: "desc",
        pageSize: 25,
        maxPageSize: 200,
      });
      const query: ValidationListQuery = {
        page,
        pageSize,
        sort,
        sortDirection: direction,
        symbol: toStringOrUndefined(raw.symbol),
        timeframe: toStringOrUndefined(raw.timeframe),
        status: toStringOrUndefined(raw.status),
        strategy: toStringOrUndefined(raw.strategy),
        minScore: toNumber(raw.minScore),
        minSampleSize: toNumber(raw.minSampleSize),
        from: toStringOrUndefined(raw.from),
        to: toStringOrUndefined(raw.to),
        search: toStringOrUndefined(raw.search),
      };
      return listValidationRuns(query);
    },
  );
};
