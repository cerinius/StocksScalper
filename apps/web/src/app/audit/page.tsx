"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { DataTable, type ColumnDef } from "../../components/data-table";
import { ListToolbar, PaginationControls } from "../../components/list-toolbar";
import { FilterChips, SearchBox } from "../../components/filter-chips";
import { EmptyState } from "../../components/empty-state";
import { ReasonCard, type StructuredReason } from "../../components/reason-list";
import {
  fetcher,
  formatDateTime,
  toQueryString,
  type ListEnvelope,
} from "../../lib/api";

interface AuditItem {
  id: string;
  category: string;
  message: string;
  severity: string;
  actorType: string;
  actorId?: string;
  workerType?: string;
  entityType?: string | null;
  entityId?: string | null;
  correlationId?: string | null;
  createdAt: string;
  data?: Record<string, unknown> | null;
  symbol?: { ticker: string } | null;
}

const SEVERITY_OPTIONS = [
  { value: "INFO", label: "Info", tone: "info" as const },
  { value: "WARNING", label: "Warning", tone: "warn" as const },
  { value: "CRITICAL", label: "Critical", tone: "critical" as const },
];

const ACTOR_OPTIONS = [
  { value: "WORKER", label: "Worker" },
  { value: "USER", label: "User" },
  { value: "SYSTEM", label: "System" },
  { value: "WEBHOOK", label: "Webhook" },
];

const CATEGORY_OPTIONS = [
  { value: "idea", label: "Idea" },
  { value: "validation", label: "Validation" },
  { value: "execution", label: "Execution" },
  { value: "risk", label: "Risk" },
  { value: "broker", label: "Broker" },
  { value: "system", label: "System" },
];

export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ field: string; direction: "asc" | "desc" }>({
    field: "createdAt",
    direction: "desc",
  });
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<string[]>([]);
  const [actorFilter, setActorFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [warningsOnly, setWarningsOnly] = useState(false);

  const query = useMemo(
    () =>
      toQueryString({
        page,
        pageSize,
        sort: sort.field,
        direction: sort.direction,
        severity: warningsOnly ? ["WARNING", "CRITICAL"] : severityFilter,
        actorType: actorFilter.length === 1 ? actorFilter[0] : undefined,
        category: categoryFilter,
        search,
      }),
    [page, pageSize, sort, severityFilter, actorFilter, categoryFilter, search, warningsOnly],
  );

  const { data, isLoading, mutate } = useSWR<ListEnvelope<AuditItem>>(`/api/audit${query}`, fetcher, {
    refreshInterval: 5_000,
    keepPreviousData: true,
  });

  const rows = data?.items ?? [];
  const meta = data?.meta;

  const extractStructured = (row: AuditItem): StructuredReason | null => {
    const payload = row.data;
    if (!payload || typeof payload !== "object") return null;
    const maybe = (payload as Record<string, unknown>).structured;
    if (!maybe || typeof maybe !== "object") return null;
    return maybe as StructuredReason;
  };

  const columns: ColumnDef<AuditItem>[] = useMemo(
    () => [
      { key: "createdAt", header: "When", render: (row) => formatDateTime(row.createdAt), sortable: true },
      { key: "severity", header: "Severity", render: (row) => <StatusPill value={row.severity} /> },
      { key: "actorType", header: "Actor", render: (row) => row.actorType, collapseOnNarrow: true },
      {
        key: "category",
        header: "Category",
        render: (row) => <span className="category-pill">{row.category}</span>,
      },
      {
        key: "symbol",
        header: "Symbol",
        render: (row) => row.symbol?.ticker ?? "—",
        collapseOnNarrow: true,
      },
      { key: "message", header: "Message", render: (row) => row.message },
    ],
    [],
  );

  const copyJson = (payload: unknown) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => undefined);
  };

  return (
    <>
      <ScreenHeader
        eyebrow="Audit"
        title="Investigation-grade journal"
        description="Every meaningful decision is written here with machine-readable reason codes, observed vs expected numbers, and lineage back to the parent records."
      />
      <Panel title="Audit trail" subtitle="Filter, expand, and copy any row for post-trade review.">
        <ListToolbar
          title=""
          meta={meta}
          isLoading={isLoading}
          onRefresh={() => mutate()}
          filters={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="Search message, category, symbol" />
              <FilterChips
                label="Severity"
                options={SEVERITY_OPTIONS}
                selected={severityFilter}
                onChange={(next) => {
                  setSeverityFilter(next);
                  setPage(1);
                }}
              />
              <FilterChips
                label="Actor"
                options={ACTOR_OPTIONS}
                selected={actorFilter}
                onChange={(next) => {
                  setActorFilter(next);
                  setPage(1);
                }}
              />
              <FilterChips
                label="Category"
                options={CATEGORY_OPTIONS}
                selected={categoryFilter}
                onChange={(next) => {
                  setCategoryFilter(next);
                  setPage(1);
                }}
              />
              <label className="filter-toggle">
                <input
                  type="checkbox"
                  checked={warningsOnly}
                  onChange={(event) => {
                    setWarningsOnly(event.currentTarget.checked);
                    setPage(1);
                  }}
                />
                <span>Warnings &amp; errors only</span>
              </label>
            </>
          }
          pagination={
            <PaginationControls
              meta={meta}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          }
        />
        {rows.length === 0 ? (
          <EmptyState reason={meta?.emptyReason ?? "no_data_yet"} message={meta?.emptyMessage} />
        ) : (
          <DataTable<AuditItem>
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            sort={sort}
            onSortChange={(field, direction) => {
              setSort({ field, direction });
              setPage(1);
            }}
            renderExpanded={(row) => {
              const structured = extractStructured(row);
              return (
                <div className="audit-expanded">
                  <div className="audit-expanded-col">
                    <h4>Detail</h4>
                    {structured ? (
                      <ReasonCard reason={structured} />
                    ) : (
                      <p className="muted">No structured reason attached.</p>
                    )}
                  </div>
                  <div className="audit-expanded-col">
                    <h4>Lineage</h4>
                    <dl className="audit-lineage">
                      {row.entityType ? (
                        <>
                          <dt>Entity</dt>
                          <dd>
                            {row.entityType}
                            {row.entityId ? ` · ${row.entityId}` : ""}
                          </dd>
                        </>
                      ) : null}
                      {row.correlationId ? (
                        <>
                          <dt>Correlation</dt>
                          <dd>{row.correlationId}</dd>
                        </>
                      ) : null}
                      {row.workerType ? (
                        <>
                          <dt>Worker</dt>
                          <dd>{row.workerType}</dd>
                        </>
                      ) : null}
                      {row.actorId ? (
                        <>
                          <dt>Actor</dt>
                          <dd>{row.actorId}</dd>
                        </>
                      ) : null}
                    </dl>
                    <div className="audit-actions">
                      <button type="button" className="btn btn-ghost" onClick={() => copyJson(row)}>
                        Copy JSON
                      </button>
                      {structured ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => copyJson(structured.explanation)}
                        >
                          Copy explanation
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            }}
          />
        )}
      </Panel>
    </>
  );
}
