import { Prisma, ValidationStatus } from "@prisma/client";
import { prisma } from "@stock-radar/db";
import { buildListEnvelope, type ListEnvelope } from "@stock-radar/shared";
import { validationStatuses, type ValidationStatus as ValidationStatusType } from "@stock-radar/types";

export interface ValidationListQuery {
  page: number;
  pageSize: number;
  sort: string;
  sortDirection: "asc" | "desc";
  symbol?: string;
  timeframe?: string;
  status?: string;
  strategy?: string;
  minScore?: number;
  minSampleSize?: number;
  from?: string;
  to?: string;
  search?: string;
}

const SORT_FIELDS: Record<string, keyof Prisma.ValidationRunOrderByWithRelationInput> = {
  createdAt: "createdAt",
  finalValidationScore: "finalValidationScore",
  winRateEstimate: "winRateEstimate",
  expectancy: "expectancy",
  sampleSize: "sampleSize",
  status: "status",
};

const normaliseStatus = (value: string | undefined): ValidationStatusType[] | undefined => {
  if (!value) return undefined;
  const upper = value.split(",").map((v) => v.trim().toUpperCase() as ValidationStatusType);
  const valid = upper.filter((v) => (validationStatuses as readonly string[]).includes(v));
  return valid.length > 0 ? valid : undefined;
};

export const listValidationRuns = async (query: ValidationListQuery): Promise<ListEnvelope<unknown>> => {
  const statusFilter = normaliseStatus(query.status);

  const where: Prisma.ValidationRunWhereInput = {
    status: statusFilter ? { in: statusFilter as ValidationStatus[] } : undefined,
    finalValidationScore: query.minScore !== undefined ? { gte: query.minScore } : undefined,
    sampleSize: query.minSampleSize !== undefined ? { gte: query.minSampleSize } : undefined,
    createdAt:
      query.from || query.to
        ? {
            gte: query.from ? new Date(query.from) : undefined,
            lte: query.to ? new Date(query.to) : undefined,
          }
        : undefined,
    candidate: {
      timeframe: query.timeframe,
      strategyType: query.strategy,
      symbol: query.symbol
        ? { ticker: { equals: query.symbol.toUpperCase(), mode: "insensitive" } }
        : undefined,
      ...(query.search
        ? {
            OR: [
              { symbol: { ticker: { contains: query.search, mode: "insensitive" } } },
              { strategyType: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
  };

  const sortField = SORT_FIELDS[query.sort] ?? "createdAt";
  const orderBy: Prisma.ValidationRunOrderByWithRelationInput[] = [
    { [sortField]: query.sortDirection },
    { createdAt: "desc" },
    { id: "desc" },
  ];

  const [items, total, anyRowsExist] = await Promise.all([
    prisma.validationRun.findMany({
      where,
      include: {
        candidate: { include: { symbol: true } },
        backtestResults: {
          orderBy: { similarityScore: "desc" },
          take: 5,
        },
      },
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.validationRun.count({ where }),
    prisma.validationRun.count().then((count: number) => count > 0),
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
      strategy: query.strategy ?? null,
      minScore: query.minScore ?? null,
      minSampleSize: query.minSampleSize ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      search: query.search ?? null,
    },
    emptyReason: !anyRowsExist ? "no_data_yet" : "no_matches",
    emptyMessage: !anyRowsExist
      ? "No validations have run yet. Validations are queued automatically whenever a new idea is detected."
      : undefined,
  });
};
