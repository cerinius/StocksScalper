import { CandidateStatus, Prisma } from "@prisma/client";
import { prisma } from "@stock-radar/db";
import { buildListEnvelope, type ListEnvelope } from "@stock-radar/shared";
import { candidateStatuses, type CandidateStatus as CandidateStatusType } from "@stock-radar/types";

export interface TradeIdeasFilters {
  symbol?: string;
  timeframe?: string;
  status?: string | string[];
  /** Trade direction filter (LONG / SHORT). */
  tradeDirection?: string;
  strategy?: string;
  minSetupScore?: number;
  maxSetupScore?: number;
  minConfidence?: number;
  from?: string;
  to?: string;
  search?: string;
}

export interface TradeIdeasQuery extends TradeIdeasFilters {
  page: number;
  pageSize: number;
  sort: string;
  /** Sort direction (asc / desc). Distinct from tradeDirection. */
  sortDirection: "asc" | "desc";
}

// Sort fields the API will honour. Anything else falls back to detectedAt desc.
const SORT_FIELDS: Record<string, keyof Prisma.TradeCandidateOrderByWithRelationInput> = {
  detectedAt: "detectedAt",
  createdAt: "createdAt",
  setupScore: "setupScore",
  confidenceScore: "confidenceScore",
  riskReward: "riskReward",
  status: "status",
};

const toUpperStatus = (value: string): CandidateStatusType | null => {
  const upper = value.trim().toUpperCase() as CandidateStatusType;
  return (candidateStatuses as readonly string[]).includes(upper) ? upper : null;
};

export const normaliseStatusFilter = (value: TradeIdeasFilters["status"]): CandidateStatusType[] | undefined => {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : value.split(",");
  const cleaned = raw
    .map((entry) => toUpperStatus(entry))
    .filter((entry): entry is CandidateStatusType => Boolean(entry));
  return cleaned.length > 0 ? cleaned : undefined;
};

export const listTradeIdeas = async (query: TradeIdeasQuery): Promise<ListEnvelope<unknown>> => {
  const statusFilter = normaliseStatusFilter(query.status);

  const where: Prisma.TradeCandidateWhereInput = {
    timeframe: query.timeframe,
    status: statusFilter ? { in: statusFilter as CandidateStatus[] } : undefined,
    direction: query.tradeDirection ? query.tradeDirection.toUpperCase() : undefined,
    strategyType: query.strategy,
    setupScore:
      query.minSetupScore !== undefined || query.maxSetupScore !== undefined
        ? {
            gte: query.minSetupScore,
            lte: query.maxSetupScore,
          }
        : undefined,
    confidenceScore: query.minConfidence !== undefined ? { gte: query.minConfidence } : undefined,
    detectedAt:
      query.from || query.to
        ? {
            gte: query.from ? new Date(query.from) : undefined,
            lte: query.to ? new Date(query.to) : undefined,
          }
        : undefined,
    symbol: query.symbol
      ? {
          ticker: { equals: query.symbol.toUpperCase(), mode: "insensitive" },
        }
      : undefined,
    OR: query.search
      ? [
          { symbol: { ticker: { contains: query.search, mode: "insensitive" } } },
          { strategyType: { contains: query.search, mode: "insensitive" } },
          { direction: { contains: query.search, mode: "insensitive" } },
        ]
      : undefined,
  };

  const sortField = SORT_FIELDS[query.sort] ?? "detectedAt";
  // Secondary sort on detectedAt (desc) guarantees a stable, "latest-first" order
  // even when the primary sort is a non-unique field like setupScore or status.
  const orderBy: Prisma.TradeCandidateOrderByWithRelationInput[] = [
    { [sortField]: query.sortDirection },
    { detectedAt: "desc" },
    { id: "desc" },
  ];

  const [items, total, anyRowsExist] = await Promise.all([
    prisma.tradeCandidate.findMany({
      where,
      include: {
        symbol: true,
        marketSnapshot: true,
        validationRuns: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.tradeCandidate.count({ where }),
    // Quick sanity check so the UI can distinguish "no data yet" from "filters hide everything".
    prisma.tradeCandidate.count().then((count) => count > 0),
  ]);

  return buildListEnvelope({
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    sort: { field: query.sort, direction: query.sortDirection },
    appliedFilters: {
      symbol: query.symbol ?? null,
      timeframe: query.timeframe ?? null,
      status: statusFilter ?? null,
      tradeDirection: query.tradeDirection ?? null,
      strategy: query.strategy ?? null,
      minSetupScore: query.minSetupScore ?? null,
      minConfidence: query.minConfidence ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      search: query.search ?? null,
    },
    emptyReason: !anyRowsExist ? "no_data_yet" : "no_matches",
    emptyMessage: !anyRowsExist
      ? "No ideas have been generated yet. Once the market worker scans your watchlist, new ideas will appear here within a few seconds."
      : undefined,
  });
};

/**
 * Group ideas by a dimension for the grouped-view mode. Runs *after* filtering
 * but independently of pagination so each group shows its own count.
 */
export const groupTradeIdeas = async (
  query: TradeIdeasQuery,
  dimension: "symbol" | "strategy" | "timeframe" | "status" | "day",
) => {
  const envelope = await listTradeIdeas({ ...query, pageSize: 500, page: 1 });
  type Row = {
    id: string;
    detectedAt: Date;
    symbol: { ticker: string } | null;
    strategyType: string;
    timeframe: string;
    status: string;
  };
  const groups = new Map<string, { key: string; label: string; count: number; latestAt: string; items: Row[] }>();

  for (const rawItem of envelope.items as Row[]) {
    const key = ((): string => {
      switch (dimension) {
        case "symbol":
          return rawItem.symbol?.ticker ?? "—";
        case "strategy":
          return rawItem.strategyType;
        case "timeframe":
          return rawItem.timeframe;
        case "status":
          return rawItem.status;
        case "day":
          return new Date(rawItem.detectedAt).toISOString().slice(0, 10);
      }
    })();

    const existing = groups.get(key);
    const detectedIso = new Date(rawItem.detectedAt).toISOString();
    if (existing) {
      existing.count += 1;
      existing.items.push(rawItem);
      if (detectedIso > existing.latestAt) existing.latestAt = detectedIso;
    } else {
      groups.set(key, { key, label: key, count: 1, latestAt: detectedIso, items: [rawItem] });
    }
  }

  return {
    dimension,
    groups: Array.from(groups.values()).sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1)),
    meta: envelope.meta,
  };
};
