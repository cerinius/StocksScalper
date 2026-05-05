import { ExecutionAction, ExecutionDecisionStatus, OrderStatus, Prisma, Severity } from "@prisma/client";
import { prisma } from "@stock-radar/db";
import { buildListEnvelope, type ListEnvelope } from "@stock-radar/shared";

export interface ExecutionListQuery {
  page: number;
  pageSize: number;
  sort: string;
  sortDirection: "asc" | "desc";
  symbol?: string;
  action?: string;
  status?: string;
  strategy?: string;
  from?: string;
  to?: string;
  search?: string;
}

const DECISION_SORT_FIELDS: Record<string, keyof Prisma.ExecutionDecisionOrderByWithRelationInput> = {
  createdAt: "createdAt",
  confidence: "confidence",
  riskScore: "riskScore",
  action: "action",
};

const ACTION_VALUES = new Set<ExecutionAction>([
  "PLACE",
  "HOLD",
  "SKIP",
  "CLOSE",
  "REDUCE",
  "INVALIDATE",
]);

const STATUS_VALUES = new Set<ExecutionDecisionStatus>([
  "PROPOSED",
  "APPROVED",
  "SENT",
  "APPLIED",
  "REJECTED",
  "SIMULATED",
]);

const parseEnumList = <T extends string>(value: string | undefined, allowed: Set<T>): T[] | undefined => {
  if (!value) return undefined;
  const result = value
    .split(",")
    .map((v) => v.trim().toUpperCase() as T)
    .filter((v) => allowed.has(v));
  return result.length > 0 ? result : undefined;
};

export const listExecutionDecisions = async (query: ExecutionListQuery): Promise<ListEnvelope<unknown>> => {
  const actions = parseEnumList<ExecutionAction>(query.action, ACTION_VALUES);
  const statuses = parseEnumList<ExecutionDecisionStatus>(query.status, STATUS_VALUES);

  const where: Prisma.ExecutionDecisionWhereInput = {
    action: actions ? { in: actions } : undefined,
    status: statuses ? { in: statuses } : undefined,
    createdAt:
      query.from || query.to
        ? {
            gte: query.from ? new Date(query.from) : undefined,
            lte: query.to ? new Date(query.to) : undefined,
          }
        : undefined,
    candidate: {
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

  const sortField = DECISION_SORT_FIELDS[query.sort] ?? "createdAt";
  const orderBy: Prisma.ExecutionDecisionOrderByWithRelationInput[] = [
    { [sortField]: query.sortDirection },
    { createdAt: "desc" },
    { id: "desc" },
  ];

  const [items, total, anyRowsExist] = await Promise.all([
    prisma.executionDecision.findMany({
      where,
      include: {
        candidate: { include: { symbol: true } },
        validationRun: true,
      },
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.executionDecision.count({ where }),
    prisma.executionDecision.count().then((count: number) => count > 0),
  ]);

  return buildListEnvelope({
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    sort: { field: query.sort, direction: query.sortDirection },
    appliedFilters: {
      symbol: query.symbol ?? null,
      action: actions ?? null,
      status: statuses ?? null,
      strategy: query.strategy ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      search: query.search ?? null,
    },
    emptyReason: !anyRowsExist ? "no_data_yet" : "no_matches",
    emptyMessage: !anyRowsExist
      ? "No execution decisions have been emitted yet. Decisions are produced once validation completes for a candidate."
      : undefined,
  });
};

export interface OrderListQuery {
  page: number;
  pageSize: number;
  sort: string;
  sortDirection: "asc" | "desc";
  symbol?: string;
  status?: string;
  from?: string;
  to?: string;
}

const ORDER_STATUS_VALUES = new Set<OrderStatus>(["PENDING", "SUBMITTED", "FILLED", "REJECTED", "CANCELED"]);

export const listOrders = async (query: OrderListQuery): Promise<ListEnvelope<unknown>> => {
  const statuses = parseEnumList<OrderStatus>(query.status, ORDER_STATUS_VALUES);
  const where: Prisma.OrderWhereInput = {
    status: statuses ? { in: statuses } : undefined,
    symbol: query.symbol
      ? { ticker: { equals: query.symbol.toUpperCase(), mode: "insensitive" } }
      : undefined,
    createdAt:
      query.from || query.to
        ? {
            gte: query.from ? new Date(query.from) : undefined,
            lte: query.to ? new Date(query.to) : undefined,
          }
        : undefined,
  };

  const [items, total, anyRowsExist] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { symbol: true, decision: true },
      orderBy: [{ createdAt: query.sortDirection }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.order.count({ where }),
    prisma.order.count().then((count: number) => count > 0),
  ]);

  return buildListEnvelope({
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    sort: { field: "createdAt", direction: query.sortDirection },
    appliedFilters: {
      symbol: query.symbol ?? null,
      status: statuses ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    },
    emptyReason: !anyRowsExist ? "no_data_yet" : "no_matches",
    emptyMessage: !anyRowsExist
      ? "No orders have been sent to the broker yet."
      : undefined,
  });
};

export interface RiskEventListQuery {
  page: number;
  pageSize: number;
  sortDirection: "asc" | "desc";
  severity?: string;
  blockingOnly?: boolean;
  from?: string;
  to?: string;
}

const SEVERITY_VALUES = new Set<Severity>(["INFO", "WARNING", "CRITICAL"]);

export const listRiskEvents = async (query: RiskEventListQuery): Promise<ListEnvelope<unknown>> => {
  const severities = parseEnumList<Severity>(query.severity, SEVERITY_VALUES);
  const where: Prisma.RiskEventWhereInput = {
    severity: severities ? { in: severities } : undefined,
    blocking: query.blockingOnly ? true : undefined,
    createdAt:
      query.from || query.to
        ? {
            gte: query.from ? new Date(query.from) : undefined,
            lte: query.to ? new Date(query.to) : undefined,
          }
        : undefined,
  };

  const [items, total, anyRowsExist] = await Promise.all([
    prisma.riskEvent.findMany({
      where,
      orderBy: [{ createdAt: query.sortDirection }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.riskEvent.count({ where }),
    prisma.riskEvent.count().then((count: number) => count > 0),
  ]);

  return buildListEnvelope({
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    sort: { field: "createdAt", direction: query.sortDirection },
    appliedFilters: {
      severity: severities ?? null,
      blockingOnly: query.blockingOnly ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    },
    emptyReason: !anyRowsExist ? "no_data_yet" : "no_matches",
    emptyMessage: !anyRowsExist
      ? "No risk events have been recorded yet. This list is populated by the execution and supervisor workers."
      : undefined,
  });
};

// Legacy: keep an overview call for existing UI.
export const getExecutionOverview = async (limit: number) => {
  const [decisions, orders, riskEvents] = await Promise.all([
    prisma.executionDecision.findMany({
      include: { candidate: { include: { symbol: true } }, validationRun: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.order.findMany({
      include: { symbol: true, decision: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.riskEvent.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  return { decisions, orders, riskEvents };
};
