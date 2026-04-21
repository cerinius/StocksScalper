"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { DataTable, type ColumnDef } from "../../components/data-table";
import { ListToolbar, PaginationControls } from "../../components/list-toolbar";
import { FilterChips, GroupingToggle, SearchBox } from "../../components/filter-chips";
import { EmptyState } from "../../components/empty-state";
import {
  fetcher,
  formatDateTime,
  toQueryString,
  type ListEnvelope,
} from "../../lib/api";

interface TradeIdea {
  id: string;
  timeframe: string;
  direction: string;
  strategyType: string;
  volatilityClassification: string;
  confidenceScore: number;
  setupScore: number;
  riskReward: number;
  status: string;
  detectedAt: string;
  reasoningLog?: Array<{ title?: string; detail?: string }> | null;
  symbol: { ticker: string };
}

interface GroupBucket {
  key: string;
  label: string;
  count: number;
  latestAt: string | null;
  passed?: number;
  failed?: number;
}

const STATUS_OPTIONS: Array<{ value: string; label: string; tone: "info" | "good" | "warn" | "critical" | "neutral" }> = [
  { value: "NEW", label: "New", tone: "info" },
  { value: "SCANNED", label: "Scanned", tone: "info" },
  { value: "VALIDATING", label: "Validating", tone: "info" },
  { value: "VALIDATED", label: "Validated", tone: "good" },
  { value: "REJECTED", label: "Rejected", tone: "critical" },
  { value: "EXECUTED", label: "Executed", tone: "good" },
  { value: "CLOSED", label: "Closed", tone: "neutral" },
  { value: "INVALIDATED", label: "Invalidated", tone: "warn" },
];

const DIRECTION_OPTIONS = [
  { value: "LONG", label: "Long", tone: "good" as const },
  { value: "SHORT", label: "Short", tone: "warn" as const },
];

const TIMEFRAME_OPTIONS = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
];

const GROUP_OPTIONS = [
  { value: "", label: "None" },
  { value: "symbol", label: "Symbol" },
  { value: "strategy", label: "Strategy" },
  { value: "timeframe", label: "Timeframe" },
  { value: "status", label: "Status" },
  { value: "day", label: "Day" },
];

export default function TradeIdeasPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ field: string; direction: "asc" | "desc" }>({
    field: "detectedAt",
    direction: "desc",
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [directionFilter, setDirectionFilter] = useState<string[]>([]);
  const [timeframeFilter, setTimeframeFilter] = useState<string[]>([]);
  const [grouping, setGrouping] = useState<string>("");
  const [showActionableOnly, setShowActionableOnly] = useState(false);

  const query = useMemo(() => {
    const effectiveStatus = showActionableOnly
      ? ["NEW", "SCANNED", "VALIDATING", "VALIDATED"]
      : statusFilter;
    return toQueryString({
      page,
      pageSize,
      sort: sort.field,
      direction: sort.direction,
      status: effectiveStatus,
      tradeDirection: directionFilter,
      timeframe: timeframeFilter,
      search,
    });
  }, [page, pageSize, sort, statusFilter, directionFilter, timeframeFilter, search, showActionableOnly]);

  const { data, isLoading, mutate } = useSWR<ListEnvelope<TradeIdea>>(
    `/api/trade-ideas${query}`,
    fetcher,
    { refreshInterval: 5_000, revalidateOnFocus: true, keepPreviousData: true },
  );

  const groupedQuery = grouping ? toQueryString({ dimension: grouping, pageSize: 500 }) : null;
  const { data: grouped } = useSWR<ListEnvelope<GroupBucket>>(
    groupedQuery ? `/api/trade-ideas/grouped${groupedQuery}` : null,
    fetcher,
    { refreshInterval: 15_000 },
  );

  const rows = data?.items ?? [];
  const meta = data?.meta;

  const columns: ColumnDef<TradeIdea>[] = useMemo(
    () => [
      {
        key: "symbol",
        header: "Symbol",
        render: (row) => <strong>{row.symbol.ticker}</strong>,
        sortable: false,
      },
      {
        key: "timeframe",
        header: "TF",
        render: (row) => row.timeframe,
        width: "72px",
      },
      {
        key: "direction",
        header: "Direction",
        render: (row) => (
          <span className={`direction-pill tone-${row.direction === "LONG" ? "good" : "warn"}`}>{row.direction}</span>
        ),
      },
      {
        key: "strategyType",
        header: "Strategy",
        render: (row) => row.strategyType,
        collapseOnNarrow: true,
      },
      {
        key: "volatilityClassification",
        header: "Regime",
        render: (row) => <StatusPill value={row.volatilityClassification} />,
        collapseOnNarrow: true,
      },
      {
        key: "setupScore",
        header: "Setup",
        render: (row) => row.setupScore.toFixed(1),
        sortable: true,
        align: "right",
      },
      {
        key: "confidenceScore",
        header: "Confidence",
        render: (row) => row.confidenceScore.toFixed(1),
        sortable: true,
        align: "right",
      },
      {
        key: "riskReward",
        header: "R / R",
        render: (row) => row.riskReward.toFixed(2),
        sortable: true,
        align: "right",
      },
      {
        key: "status",
        header: "Status",
        render: (row) => <StatusPill value={row.status} />,
      },
      {
        key: "detectedAt",
        header: "Detected",
        render: (row) => formatDateTime(row.detectedAt),
        sortable: true,
      },
    ],
    [],
  );

  const activeFilterCount =
    statusFilter.length + directionFilter.length + timeframeFilter.length + (search ? 1 : 0) + (showActionableOnly ? 1 : 0);

  return (
    <>
      <ScreenHeader
        eyebrow="Trade Ideas"
        title="Pipeline of ranked candidate setups"
        description="Every idea the market layer surfaces — grouped, filterable, and traceable back to the exact reason it landed here."
      />
      <Panel title="Current candidates" subtitle="Newest appear first by default. Use filters and grouping to investigate.">
        <ListToolbar
          title=""
          meta={meta}
          isLoading={isLoading}
          onRefresh={() => mutate()}
          filters={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="Search by ticker, strategy, or keyword" />
              <FilterChips
                label="Status"
                options={STATUS_OPTIONS}
                selected={statusFilter}
                onChange={(next) => {
                  setStatusFilter(next);
                  setPage(1);
                }}
              />
              <FilterChips
                label="Direction"
                options={DIRECTION_OPTIONS}
                selected={directionFilter}
                onChange={(next) => {
                  setDirectionFilter(next);
                  setPage(1);
                }}
              />
              <FilterChips
                label="Timeframe"
                options={TIMEFRAME_OPTIONS}
                selected={timeframeFilter}
                onChange={(next) => {
                  setTimeframeFilter(next);
                  setPage(1);
                }}
              />
              <label className="filter-toggle">
                <input
                  type="checkbox"
                  checked={showActionableOnly}
                  onChange={(event) => {
                    setShowActionableOnly(event.currentTarget.checked);
                    setPage(1);
                  }}
                />
                <span>Actionable only</span>
              </label>
              <GroupingToggle options={GROUP_OPTIONS} value={grouping} onChange={setGrouping} />
              {activeFilterCount > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setStatusFilter([]);
                    setDirectionFilter([]);
                    setTimeframeFilter([]);
                    setSearch("");
                    setShowActionableOnly(false);
                    setPage(1);
                  }}
                >
                  Clear filters ({activeFilterCount})
                </button>
              ) : null}
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

        {grouping && grouped && grouped.items.length > 0 ? (
          <div className="group-summary">
            <h3 className="group-summary-title">Grouped by {grouping}</h3>
            <div className="group-summary-grid">
              {grouped.items.slice(0, 24).map((bucket) => (
                <div key={bucket.key} className="group-summary-card">
                  <div className="group-summary-label">{bucket.label}</div>
                  <div className="group-summary-count">{bucket.count}</div>
                  {bucket.latestAt ? (
                    <div className="group-summary-latest">Latest {formatDateTime(bucket.latestAt)}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            reason={meta?.emptyReason ?? "no_data_yet"}
            message={meta?.emptyMessage}
            debug={{ appliedFilters: meta?.appliedFilters, page, pageSize, sort }}
            actions={
              activeFilterCount > 0 ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setStatusFilter([]);
                    setDirectionFilter([]);
                    setTimeframeFilter([]);
                    setSearch("");
                    setShowActionableOnly(false);
                    setPage(1);
                  }}
                >
                  Clear all filters
                </button>
              ) : (
                <button type="button" className="btn btn-ghost" onClick={() => mutate()}>
                  Refresh
                </button>
              )
            }
          />
        ) : (
          <DataTable<TradeIdea>
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            sort={sort}
            onSortChange={(field, direction) => {
              setSort({ field, direction });
              setPage(1);
            }}
            renderExpanded={(row) => (
              <div className="idea-expanded">
                <div className="idea-expanded-col">
                  <h4>Why this idea fired</h4>
                  {(row.reasoningLog ?? []).length === 0 ? (
                    <p className="muted">No reasoning log recorded.</p>
                  ) : (
                    <ul className="reasoning-list">
                      {(row.reasoningLog ?? []).slice(0, 6).map((entry, index) => (
                        <li key={index}>
                          <strong>{entry.title ?? "Note"}:</strong> {entry.detail ?? ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="idea-expanded-col">
                  <h4>Key numbers</h4>
                  <ul className="idea-numbers">
                    <li>
                      <span>Setup score</span> <strong>{row.setupScore.toFixed(1)}</strong>
                    </li>
                    <li>
                      <span>Confidence</span> <strong>{row.confidenceScore.toFixed(1)}</strong>
                    </li>
                    <li>
                      <span>Risk / Reward</span> <strong>{row.riskReward.toFixed(2)}</strong>
                    </li>
                    <li>
                      <span>Timeframe</span> <strong>{row.timeframe}</strong>
                    </li>
                    <li>
                      <span>Strategy</span> <strong>{row.strategyType}</strong>
                    </li>
                    <li>
                      <span>Regime</span> <strong>{row.volatilityClassification}</strong>
                    </li>
                  </ul>
                </div>
              </div>
            )}
          />
        )}
      </Panel>
    </>
  );
}
