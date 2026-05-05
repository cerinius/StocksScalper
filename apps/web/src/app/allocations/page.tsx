"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { FilterChips, SearchBox } from "../../components/filter-chips";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime, toQueryString } from "../../lib/api";

interface AllocationDecision {
  id: string;
  createdAt: string;
  policy: string;
  setupKey: string;
  status: string;
  selectedAccountIds: string[];
  summary: string | null;
  candidate: {
    id: string;
    direction: string;
    timeframe: string;
    strategyType: string;
    symbol: { ticker: string };
  };
  candidates: Array<{
    id: string;
    selected: boolean;
    totalScore: number;
    reasonCodes: string[];
    componentsJson?: {
      healthFit?: number;
      modeFit?: number;
      drawdownHeadroom?: number;
      utilizationFit?: number;
      validationFit?: number;
    } | null;
    message: string;
    account: { displayName: string; mode: string; health: string };
  }>;
}

export default function AllocationsPage() {
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [policyFilter, setPolicyFilter] = useState<string[]>([]);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [search, setSearch] = useState("");

  const endpoint = useMemo(
    () =>
      `/api/allocations${toQueryString({
        limit: 100,
        status: statusFilter,
        policy: policyFilter,
        selectedOnly: selectedOnly ? "true" : undefined,
        search: search.trim() || undefined,
      })}`,
    [policyFilter, search, selectedOnly, statusFilter],
  );

  const { data } = useSWR<AllocationDecision[]>(endpoint, fetcher, { refreshInterval: 5000 });
  const rows = data ?? [];

  return (
    <>
      <ScreenHeader
        eyebrow="Allocations"
        title="Setup allocation decisions"
        description="Review how each validated candidate was scored across accounts, then routed by policy."
      />

      <Panel
        title="Filters"
        subtitle="Narrow the stream by allocation outcome/policy and search by setup, strategy, or symbol."
      >
        <div className="list-stack">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search setup, strategy, or symbol"
            ariaLabel="Search allocations"
          />
          <FilterChips
            label="Status"
            selected={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: "ALLOCATED", label: "Allocated", tone: "good" },
              { value: "PARTIAL", label: "Partial", tone: "warn" },
              { value: "SKIPPED", label: "Skipped", tone: "neutral" },
              { value: "FAILED", label: "Failed", tone: "critical" },
              { value: "PENDING", label: "Pending", tone: "info" },
            ]}
          />
          <FilterChips
            label="Policy"
            selected={policyFilter}
            onChange={setPolicyFilter}
            options={[
              { value: "ONE_ACCOUNT_ONLY", label: "One" },
              { value: "MAX_N_ACCOUNTS", label: "Top N" },
              { value: "ALL_ELIGIBLE", label: "All eligible" },
              { value: "CHALLENGE_ONLY", label: "Challenge only" },
              { value: "FUNDED_ONLY", label: "Funded only" },
              { value: "STRATEGY_TAGGED", label: "Strategy tagged" },
            ]}
          />
          <label className="grouping-toggle">
            <span className="eyebrow">Selection</span>
            <select value={selectedOnly ? "true" : "false"} onChange={(event) => setSelectedOnly(event.currentTarget.value === "true")}>
              <option value="false">All rows</option>
              <option value="true">Selected only</option>
            </select>
          </label>
        </div>
      </Panel>

      <Panel title="Recent allocation stream" subtitle="Each row shows candidate-level policy output and per-account fit signals.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Candidate</th>
              <th>Policy</th>
              <th>Status</th>
              <th>Selected Accounts</th>
              <th>Per-account fit summary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((decision) => (
              <tr key={decision.id}>
                <td>{formatDateTime(decision.createdAt)}</td>
                <td>
                  <strong>{decision.candidate.symbol.ticker}</strong>
                  <div className="mono">{decision.candidate.direction} {decision.candidate.timeframe}</div>
                </td>
                <td>
                  {decision.policy}
                  <div className="mono">{decision.setupKey}</div>
                </td>
                <td><StatusPill value={decision.status} /></td>
                <td>{decision.selectedAccountIds.length}</td>
                <td>
                  <div className="list-stack">
                    {decision.candidates.map((candidateRow) => (
                      <div className="list-item" key={candidateRow.id}>
                        <strong>{candidateRow.account.displayName}</strong>
                        <div className="mono">mode={candidateRow.account.mode} health={candidateRow.account.health}</div>
                        <p>fit={candidateRow.totalScore.toFixed(1)} selected={candidateRow.selected ? "yes" : "no"}</p>
                        {candidateRow.componentsJson ? (
                          <p className="mono">
                            h={candidateRow.componentsJson.healthFit ?? 0} m={candidateRow.componentsJson.modeFit ?? 0}{" "}
                            dd={candidateRow.componentsJson.drawdownHeadroom ?? 0} u={candidateRow.componentsJson.utilizationFit ?? 0}{" "}
                            v={candidateRow.componentsJson.validationFit ?? 0}
                          </p>
                        ) : null}
                        {candidateRow.reasonCodes.length > 0 ? (
                          <p className="mono">reasons: {candidateRow.reasonCodes.join(", ")}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
