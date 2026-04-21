import type { FastifyInstance } from "fastify";
import { parseListQuery } from "@stock-radar/shared";
import { authPreHandler, requireRole } from "../../lib/auth";
import { groupTradeIdeas, listTradeIdeas, type TradeIdeasQuery } from "./service";

const toNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const toStringOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

const readQuery = (raw: Record<string, string | undefined>): TradeIdeasQuery => {
  const { page, pageSize, sort, direction } = parseListQuery(raw, {
    sort: "detectedAt",
    direction: "desc",
    pageSize: 25,
    maxPageSize: 200,
  });

  return {
    page,
    pageSize,
    sort,
    sortDirection: direction,
    symbol: toStringOrUndefined(raw.symbol),
    timeframe: toStringOrUndefined(raw.timeframe),
    status: toStringOrUndefined(raw.status),
    tradeDirection: toStringOrUndefined(raw.tradeDirection) ?? toStringOrUndefined(raw.dir),
    strategy: toStringOrUndefined(raw.strategy),
    minSetupScore: toNumber(raw.minSetupScore),
    maxSetupScore: toNumber(raw.maxSetupScore),
    minConfidence: toNumber(raw.minConfidence),
    from: toStringOrUndefined(raw.from),
    to: toStringOrUndefined(raw.to),
    search: toStringOrUndefined(raw.search),
  };
};

export const tradeIdeasPlugin = async (app: FastifyInstance) => {
  app.get(
    "/api/trade-ideas",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => listTradeIdeas(readQuery(request.query as Record<string, string | undefined>)),
  );

  app.get(
    "/api/trade-ideas/grouped",
    { preHandler: [authPreHandler, requireRole("ADMIN", "OPERATOR", "VIEWER")] },
    async (request) => {
      const raw = request.query as Record<string, string | undefined>;
      const query = readQuery(raw);
      const dimension = (raw.groupBy ?? "symbol") as "symbol" | "strategy" | "timeframe" | "status" | "day";
      return groupTradeIdeas(query, dimension);
    },
  );
};
