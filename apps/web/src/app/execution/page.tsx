"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { DataTable, type ColumnDef } from "../../components/data-table";
import { ListToolbar, PaginationControls } from "../../components/list-toolbar";
import { FilterChips, SearchBox } from "../../components/filter-chips";
import { EmptyState } from "../../components/empty-state";
import { ReasonList, type StructuredReason } from "../../components/reason-list";
import {
  fetcher,
  formatDateTime,
  toQueryString,
  type ListEnvelope,
} from "../../lib/api";

type TabKey = "decisions" | "orders" | "risk";

interface ExecutionDecision {
  id: string;
  action: string;
  status: string;
  confidence: number;
  riskScore: number;
  evidenceSummary: string;
  createdAt: string;
  reasons?: Array<{ title?: string; detail?: string }> | null;
  blockingReasons?: Array<{ title?: string; detail?: string }> | null;
  structuredReasons?: StructuredReason[] | null;
  structuredBlockingReasons?: StructuredReason[] | null;
  candidate: { symbol: { ticker: string }; strategyType: string; timeframe: string };
}

interface OrderRow {
  id: string;
  status: string;
  direction: string;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  createdAt: string;
  filledAt?: string | null;
  rejectedAt?: string | null;
  errorMessage?: string | null;
  symbol: { ticker: string };
}

interface RiskEventRow {
  id: string;
  severity: string;
  eventType: string;
  message: string;
  blocking: boolean;
  createdAt: string;
  candidate?: { symbol?: { ticker: string } } | null;
}

const ACTION_OPTIONS = [
  { value: "PLACE", label: "Place", tone: "good" as const },
  { value: "HOLD", label: "Hold", tone: "info" as const },
  { value: "SKIP", label: "Skip", tone: "warn" as const },
  { value: "INVALIDATE", label: "Invalidate", tone: "warn" as const },
];

const ORDER_STATUS_OPTIONS = [
  { value: "PENDING", label: "Pending", tone: "info" as const },
  { value: "SUBMITTED", label: "Submitted", tone: "info" as const },
  { value: "FILLED", label: "Filled", tone: "good" as const },
  { value: "REJECTED", label: "Rejected", tone: "critical" as const },
  { value: "CANCELED", label: "Cancelled", tone: "warn" as const },
];

const SEVERITY_OPTIONS = [
  { value: "INFO", label: "Info", tone: "info" as const },
  { value: "WARNING", label: "Warning", tone: "warn" as const },
  { value: "CRITICAL", label: "Critical", tone: "critical" as const },
];

export default function ExecutionPage() {
  const [tab, setTab] = useState<TabKey>("decisions");

  return (
    <>
      <ScreenHeader
        eyebrow="Execution"
        title="Decision engine, orders, and risk events"
        description="Trace every execution outcome to the exact rule that produced it."
      />
      <div className="tab-strip" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "decisions"}
          className={`tab ${tab === "decisions" ? "active" : ""}`}
          onClick={() => setTab("decisions")}
        >
          Decisions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "orders"}
          className={`tab ${tab === "orders" ? "active" : ""}`}
          onClick={() => setTab("orders")}
        >
          Orders
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "risk"}
          className={`tab ${tab === "risk" ? "active" : ""}`}
          onClick={() => setTab("risk")}
        >
          Risk events
        </button>
      </div>

      {tab === "decisions" ? <DecisionsTab /> : null}
      {tab === "orders" ? <OrdersTab /> : null}
      {tab === "risk" ? <RiskTab /> : null}
    </>
  );
}

function DecisionsTab() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<{ field: string; direction: "asc" | "desc" }>({ field: "createdAt", direction: "desc" });
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState<string[]>([]);

  const query = useMemo(
    () =>
      toQueryString({
        page,
        pageSize,
        sort: sort.field,
        direction: sort.direction,
        action: actionFilter,
        search,
      }),
    [page, pageSize, sort, actionFilter, search],
  );

  const { data, isLoading, mutate } = useSWR<ListEnvelope<ExecutionDecision>>(
    `/api/execution/decisions${query}`,
    fetcher,
    { refreshInterval: 5_000, keepPreviousData: true },
  );

  const rows = data?.items ?? [];
  const meta = data?.meta;

  const columns: ColumnDef<ExecutionDecision>[] = useMemo(
    () => [
      { key: "createdAt", header: "Time", render: (row) => formatDateTime(row.createdAt), sortable: true },
      { key: "symbol", header: "Symbol", render: (row) => <strong>{row.candidate.symbol.ticker}</strong> },
      { key: "strategy", header: "Strategy", render: (row) => row.candidate.strategyType, collapseOnNarrow: true },
      { key: "timeframe", header: "TF", render: (row) => row.candidate.timeframe, width: "72px" },
      { key: "action", header: "Action", render: (row) => <StatusPill value={row.action} /> },
      { key: "status", header: "Status", render: (row) => <StatusPill value={row.status} /> },
      {
        key: "confidence",
        header: "Confidence",
        render: (row) => row.confidence.toFixed(1),
        sortable: true,
        align: "right",
      },
      {
        key: "riskScore",
        header: "Risk",
        render: (row) => row.riskScore.toFixed(1),
        sortable: true,
        align: "right",
      },
    ],
    [],
  );

  return (
    <Panel title="Decision stream" subtitle="Every execution outcome with its exact trigger chain.">
      <ListToolbar
        title=""
        meta={meta}
        isLoading={isLoading}
        onRefresh={() => mutate()}
        filters={
          <>
            <SearchBox value={search} onChange={setSearch} placeholder="Search by symbol or evidence" />
            <FilterChips
              label="Action"
              options={ACTION_OPTIONS}
              selected={actionFilter}
              onChange={(next) => {
                setActionFilter(next);
                setPage(1);
              }}
            />
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
        <DataTable<ExecutionDecision>
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          sort={sort}
          onSortChange={(field, direction) => {
            setSort({ field, direction });
            setPage(1);
          }}
          renderExpanded={(row) => (
            <div className="decision-expanded">
              <div>
                <h4>Evidence summary</h4>
                <p>{row.evidenceSummary}</p>
              </div>
              <div>
                <h4>Supporting reasons</h4>
                {row.structuredReasons && row.structuredReasons.length > 0 ? (
                  <ReasonList reasons={row.structuredReasons} />
                ) : (
                  <ul className="reasoning-list">
                    {(row.reasons ?? []).map((entry, index) => (
                      <li key={index}>
                        <strong>{entry.title ?? "Note"}:</strong> {entry.detail ?? ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4>Blocking reasons</h4>
                {row.structuredBlockingReasons && row.structuredBlockingReasons.length > 0 ? (
                  <ReasonList reasons={row.structuredBlockingReasons} />
                ) : (row.blockingReasons ?? []).length === 0 ? (
                  <p className="muted">No blockers — nothing prevented this action.</p>
                ) : (
                  <ul className="reasoning-list">
                    {(row.blockingReasons ?? []).map((entry, index) => (
                      <li key={index}>
                        <strong>{entry.title ?? "Block"}:</strong> {entry.detail ?? ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        />
      )}
    </Panel>
  );
}

function OrdersTab() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<{ field: string; direction: "asc" | "desc" }>({ field: "createdAt", direction: "desc" });
  const [statusFilter, setStatusFilter] = useState<string[]>([]);

  const query = useMemo(
    () =>
      toQueryString({
        page,
        pageSize,
        sort: sort.field,
        direction: sort.direction,
        status: statusFilter,
      }),
    [page, pageSize, sort, statusFilter],
  );

  const { data, isLoading, mutate } = useSWR<ListEnvelope<OrderRow>>(`/api/execution/orders${query}`, fetcher, {
    refreshInterval: 5_000,
    keepPreviousData: true,
  });

  const rows = data?.items ?? [];
  const meta = data?.meta;

  const columns: ColumnDef<OrderRow>[] = useMemo(
    () => [
      { key: "symbol", header: "Symbol", render: (row) => <strong>{row.symbol.ticker}</strong> },
      { key: "status", header: "Status", render: (row) => <StatusPill value={row.status} /> },
      { key: "direction", header: "Side", render: (row) => row.direction },
      { key: "quantity", header: "Qty", render: (row) => row.quantity.toFixed(2), align: "right" },
      { key: "entryPrice", header: "Entry", render: (row) => row.entryPrice.toFixed(4), align: "right" },
      { key: "stopLoss", header: "Stop", render: (row) => row.stopLoss.toFixed(4), align: "right" },
      { key: "takeProfit", header: "Target", render: (row) => row.takeProfit.toFixed(4), align: "right" },
      { key: "createdAt", header: "Created", render: (row) => formatDateTime(row.createdAt), sortable: true },
      { key: "filledAt", header: "Filled", render: (row) => (row.filledAt ? formatDateTime(row.filledAt) : "—") },
    ],
    [],
  );

  return (
    <Panel title="Orders" subtitle="All orders submitted to the broker, including rejections.">
      <ListToolbar
        title=""
        meta={meta}
        isLoading={isLoading}
        onRefresh={() => mutate()}
        filters={
          <FilterChips
            label="Status"
            options={ORDER_STATUS_OPTIONS}
            selected={statusFilter}
            onChange={(next) => {
              setStatusFilter(next);
              setPage(1);
            }}
          />
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
        <DataTable<OrderRow>
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.id}
          sort={sort}
          onSortChange={(field, direction) => {
            setSort({ field, direction });
            setPage(1);
          }}
          renderExpanded={(row) => (
            <div className="decision-expanded">
              {row.errorMessage ? (
                <div>
                  <h4>Broker response</h4>
                  <p className="error">{row.errorMessage}</p>
                </div>
              ) : (
                <p className="muted">No broker error recorded.</p>
              )}
            </div>
          )}
        />
      )}
    </Panel>
  );
}

function RiskTab() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [severityFilter, setSeverityFilter] = useState<string[]>([]);
  const [blockingOnly, setBlockingOnly] = useState(false);

  const query = useMemo(
    () =>
      toQueryString({
        page,
        pageSize,
        severity: severityFilter,
        blockingOnly: blockingOnly ? "true" : undefined,
      }),
    [page, pageSize, severityFilter, blockingOnly],
  );

  const { data, isLoading, mutate } = useSWR<ListEnvelope<RiskEventRow>>(
    `/api/execution/risk-events${query}`,
    fetcher,
    { refreshInterval: 10_000, keepPreviousData: true },
  );

  const rows = data?.items ?? [];
  const meta = data?.meta;

  const columns: ColumnDef<RiskEventRow>[] = useMemo(
    () => [
      { key: "createdAt", header: "When", render: (row) => formatDateTime(row.createdAt) },
      { key: "severity", header: "Severity", render: (row) => <StatusPill value={row.severity} /> },
      {
        key: "symbol",
        header: "Symbol",
        render: (row) => row.candidate?.symbol?.ticker ?? "—",
        collapseOnNarrow: true,
      },
      { key: "eventType", header: "Type", render: (row) => row.eventType },
      { key: "message", header: "Message", render: (row) => row.message },
      { key: "blocking", header: "Blocking", render: (row) => (row.blocking ? "Yes" : "No") },
    ],
    [],
  );

  return (
    <Panel title="Risk events" subtitle="Every guardrail firing is recorded here for post-trade review.">
      <ListToolbar
        title=""
        meta={meta}
        isLoading={isLoading}
        onRefresh={() => mutate()}
        filters={
          <>
            <FilterChips
              label="Severity"
              options={SEVERITY_OPTIONS}
              selected={severityFilter}
              onChange={(next) => {
                setSeverityFilter(next);
                setPage(1);
              }}
            />
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={blockingOnly}
                onChange={(event) => {
                  setBlockingOnly(event.currentTarget.checked);
                  setPage(1);
                }}
              />
              <span>Blocking only</span>
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
        <DataTable<RiskEventRow> columns={columns} rows={rows} getRowKey={(row) => row.id} />
      )}
    </Panel>
  );
}
