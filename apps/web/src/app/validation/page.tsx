"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { DataTable, type ColumnDef } from "../../components/data-table";
import { ListToolbar, PaginationControls } from "../../components/list-toolbar";
import { FilterChips, SearchBox } from "../../components/filter-chips";
import { EmptyState } from "../../components/empty-state";
import {
  fetcher,
  formatDateTime,
  toQueryString,
  type ListEnvelope,
} from "../../lib/api";

interface ValidationItem {
  id: string;
  status: string;
  finalValidationScore: number;
  winRateEstimate: number;
  expectancy: number;
  sampleSize: number;
  confidenceScore?: number;
  profitFactor?: number;
  maxDrawdown?: number;
  createdAt?: string;
  dataQualityNotes?: string[] | null;
  reasonsFor?: Array<{ title?: string; detail?: string }> | null;
  reasonsAgainst?: Array<{ title?: string; detail?: string }> | null;
  backtestMetadata?: {
    monteCarlo?: {
      drawdownPct95?: number;
      riskOfRuinPct?: number;
    };
    realAnalogCount?: number;
  };
  candidate: { symbol: { ticker: string }; strategyType: string; timeframe: string };
  backtestResults?: Array<{ id: string; similarityScore: number; outcomeR: number; holdBars: number }>;
}

const STATUS_OPTIONS = [
  { value: "PENDING", label: "Running", tone: "info" as const },
  { value: "PASSED", label: "Passed", tone: "good" as const },
  { value: "FAILED", label: "Failed", tone: "critical" as const },
  { value: "STALE", label: "Stale", tone: "warn" as const },
];

export default function ValidationPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ field: string; direction: "asc" | "desc" }>({
    field: "createdAt",
    direction: "desc",
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [minScore, setMinScore] = useState<string>("");

  const query = useMemo(
    () =>
      toQueryString({
        page,
        pageSize,
        sort: sort.field,
        direction: sort.direction,
        status: statusFilter,
        minScore: minScore || undefined,
        search,
      }),
    [page, pageSize, sort, statusFilter, minScore, search],
  );

  const { data, isLoading, mutate } = useSWR<ListEnvelope<ValidationItem>>(
    `/api/validation${query}`,
    fetcher,
    { refreshInterval: 10_000, keepPreviousData: true },
  );

  const rows = data?.items ?? [];
  const meta = data?.meta;

  const columns: ColumnDef<ValidationItem>[] = useMemo(
    () => [
      { key: "symbol", header: "Symbol", render: (row) => <strong>{row.candidate.symbol.ticker}</strong> },
      { key: "strategy", header: "Strategy", render: (row) => row.candidate.strategyType, collapseOnNarrow: true },
      { key: "timeframe", header: "TF", render: (row) => row.candidate.timeframe, width: "72px" },
      { key: "status", header: "Status", render: (row) => <StatusPill value={row.status} /> },
      {
        key: "finalValidationScore",
        header: "Score",
        render: (row) => row.finalValidationScore.toFixed(1),
        sortable: true,
        align: "right",
      },
      {
        key: "winRateEstimate",
        header: "Win rate",
        render: (row) => `${(row.winRateEstimate * 100).toFixed(1)}%`,
        align: "right",
      },
      {
        key: "expectancy",
        header: "Expectancy",
        render: (row) => `${row.expectancy.toFixed(2)}R`,
        sortable: true,
        align: "right",
      },
      {
        key: "sampleSize",
        header: "Sample",
        render: (row) => row.sampleSize,
        sortable: true,
        align: "right",
      },
      {
        key: "mcDd95",
        header: "MC DD 95",
        render: (row) =>
          row.backtestMetadata?.monteCarlo?.drawdownPct95 !== undefined
            ? `${row.backtestMetadata.monteCarlo.drawdownPct95.toFixed(1)}%`
            : "—",
        align: "right",
        collapseOnNarrow: true,
      },
      {
        key: "ruin",
        header: "Ruin risk",
        render: (row) =>
          row.backtestMetadata?.monteCarlo?.riskOfRuinPct !== undefined
            ? `${(row.backtestMetadata.monteCarlo.riskOfRuinPct * 100).toFixed(1)}%`
            : "—",
        align: "right",
        collapseOnNarrow: true,
      },
      {
        key: "createdAt",
        header: "Run at",
        render: (row) => (row.createdAt ? formatDateTime(row.createdAt) : "—"),
        sortable: true,
      },
    ],
    [],
  );

  return (
    <>
      <ScreenHeader
        eyebrow="Validation"
        title="Historical analogs and rule-based scoring"
        description="Inspect how each candidate matched against real history: expectancy, drawdown, and analog quality."
      />
      <Panel title="Validation runs" subtitle="Every run is explainable end-to-end. Expand a row to see the exact reasons it passed or failed.">
        <ListToolbar
          title=""
          meta={meta}
          isLoading={isLoading}
          onRefresh={() => mutate()}
          filters={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="Search by symbol, strategy, or note" />
              <FilterChips
                label="Status"
                options={STATUS_OPTIONS}
                selected={statusFilter}
                onChange={(next) => {
                  setStatusFilter(next);
                  setPage(1);
                }}
              />
              <label className="filter-toggle">
                <span>Min score</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minScore}
                  onChange={(event) => {
                    setMinScore(event.currentTarget.value);
                    setPage(1);
                  }}
                  placeholder="0"
                />
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
          <EmptyState
            reason={meta?.emptyReason ?? "no_data_yet"}
            message={meta?.emptyMessage}
            actions={
              <button type="button" className="btn btn-ghost" onClick={() => mutate()}>
                Refresh
              </button>
            }
          />
        ) : (
          <DataTable<ValidationItem>
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            sort={sort}
            onSortChange={(field, direction) => {
              setSort({ field, direction });
              setPage(1);
            }}
            renderExpanded={(row) => (
              <div className="validation-expanded">
                <div className="validation-expanded-col">
                  <h4>Reasons for</h4>
                  {(row.reasonsFor ?? []).length === 0 ? (
                    <p className="muted">None recorded.</p>
                  ) : (
                    <ul className="reasoning-list">
                      {(row.reasonsFor ?? []).map((entry, index) => (
                        <li key={index}>
                          <strong>{entry.title ?? "Note"}:</strong> {entry.detail ?? ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="validation-expanded-col">
                  <h4>Reasons against</h4>
                  {(row.reasonsAgainst ?? []).length === 0 ? (
                    <p className="muted">None recorded.</p>
                  ) : (
                    <ul className="reasoning-list">
                      {(row.reasonsAgainst ?? []).map((entry, index) => (
                        <li key={index}>
                          <strong>{entry.title ?? "Note"}:</strong> {entry.detail ?? ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="validation-expanded-col">
                  <h4>Data quality notes</h4>
                  {(row.dataQualityNotes ?? []).length === 0 ? (
                    <p className="muted">No issues noted.</p>
                  ) : (
                    <ul className="reasoning-list">
                      {(row.dataQualityNotes ?? []).map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  )}
                  {row.backtestMetadata?.realAnalogCount !== undefined ? (
                    <p className="muted">Real analogs found: {row.backtestMetadata.realAnalogCount}</p>
                  ) : null}
                </div>
              </div>
            )}
          />
        )}
      </Panel>
    </>
  );
}
