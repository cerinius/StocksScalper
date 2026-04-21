import { Prisma, Severity } from "@prisma/client";
import { prisma } from "@stock-radar/db";
import { buildListEnvelope, type ListEnvelope } from "@stock-radar/shared";

export interface AuditListQuery {
  page: number;
  pageSize: number;
  sortDirection: "asc" | "desc";
  category?: string;
  symbol?: string;
  actorType?: string;
  severity?: string;
  correlationId?: string;
  entityId?: string;
  from?: string;
  to?: string;
  search?: string;
}

const SEVERITY_VALUES = new Set<Severity>(["INFO", "WARNING", "CRITICAL"]);

const parseSeverity = (value: string | undefined): Severity[] | undefined => {
  if (!value) return undefined;
  const cleaned = value
    .split(",")
    .map((v) => v.trim().toUpperCase() as Severity)
    .filter((v) => SEVERITY_VALUES.has(v));
  return cleaned.length > 0 ? cleaned : undefined;
};

export const listAuditLogs = async (query: AuditListQuery): Promise<ListEnvelope<unknown>> => {
  const severities = parseSeverity(query.severity);

  const where: Prisma.AuditLogWhereInput = {
    category: query.category
      ? { in: query.category.split(",").map((v) => v.trim()).filter(Boolean) }
      : undefined,
    severity: severities ? { in: severities } : undefined,
    actorType: query.actorType
      ? (query.actorType.toUpperCase() as "SYSTEM" | "USER" | "WORKER" | "WEBHOOK")
      : undefined,
    correlationId: query.correlationId ?? undefined,
    entityId: query.entityId ?? undefined,
    createdAt:
      query.from || query.to
        ? {
            gte: query.from ? new Date(query.from) : undefined,
            lte: query.to ? new Date(query.to) : undefined,
          }
        : undefined,
    symbol: query.symbol
      ? { ticker: { equals: query.symbol.toUpperCase(), mode: "insensitive" } }
      : undefined,
    OR: query.search
      ? [
          { message: { contains: query.search, mode: "insensitive" } },
          { category: { contains: query.search, mode: "insensitive" } },
        ]
      : undefined,
  };

  const [items, total, anyRowsExist] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { symbol: true },
      orderBy: [{ createdAt: query.sortDirection }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.count().then((count) => count > 0),
  ]);

  return buildListEnvelope({
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    sort: { field: "createdAt", direction: query.sortDirection },
    appliedFilters: {
      category: query.category ?? null,
      severity: severities ?? null,
      actorType: query.actorType ?? null,
      symbol: query.symbol ?? null,
      correlationId: query.correlationId ?? null,
      entityId: query.entityId ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      search: query.search ?? null,
    },
    emptyReason: !anyRowsExist ? "no_data_yet" : "no_matches",
    emptyMessage: !anyRowsExist
      ? "The audit log is empty. Every major action is written here as it happens."
      : undefined,
  });
};

/** Audit summary: counts by category for the last N hours, for dashboards. */
export const auditSummary = async (hours: number) => {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await prisma.auditLog.groupBy({
    by: ["category", "severity"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  return {
    since: since.toISOString(),
    totals: rows.map((row) => ({
      category: row.category,
      severity: row.severity,
      count: row._count._all,
    })),
  };
};
