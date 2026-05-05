"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader, StatusPill } from "../../../components/screen";
import { fetcher, formatDateTime, formatMoney, formatPercent } from "../../../lib/api";

interface AccountDetailResponse {
  account: {
    id: string;
    displayName: string;
    kind: string;
    providerName: string;
    tradingMode: string;
    mode: string;
    health: string;
    currentPhase: { kind: string; startedAt: string } | null;
    activeRuleProfile: {
      version: number;
      maxRiskPerTradePct: number;
      maxOpenPositions: number;
      maxConcurrentRiskPct: number;
      dailyLossLimitUsd: number;
      totalLossLimitUsd: number;
    } | null;
  };
  latestSnapshot: {
    equity: number;
    balance: number;
    drawdownPct: number;
    dailyLossUsedPct: number;
    totalLossUsedPct: number;
    openPositionCount: number;
    capturedAt: string;
  } | null;
  openPositions: Array<{
    id: string;
    symbol: { ticker: string };
    direction: string;
    quantity: number;
    unrealizedPnl: number;
    exposurePct: number;
  }>;
  allocationHistory: Array<{
    id: string;
    createdAt: string;
    selected: boolean;
    totalScore: number;
    componentsJson?: {
      healthFit?: number;
      modeFit?: number;
      drawdownHeadroom?: number;
      utilizationFit?: number;
      validationFit?: number;
    } | null;
    reasonCodes: string[];
    message: string;
    allocationStatus: string;
    policy: string;
    setupKey: string;
    candidate: {
      id: string;
      symbol: string;
      direction: string;
      timeframe: string;
      strategyType: string;
    };
  }>;
}

export default function AccountDetailPage() {
  const params = useParams<{ id: string }>();
  const accountId = params.id;
  const { data } = useSWR<AccountDetailResponse>(accountId ? `/api/accounts/${accountId}` : null, fetcher, {
    refreshInterval: 5000,
  });

  const account = data?.account;

  return (
    <>
      <ScreenHeader
        eyebrow="Account"
        title={account?.displayName ?? "Account detail"}
        description="Phase progress, active rules, live positions, and recent allocation outcomes for this account."
        actions={<Link className="button secondary" href="/accounts">Back to accounts</Link>}
      />

      <div className="metrics-grid">
        <MetricCard label="Phase" value={account?.currentPhase?.kind ?? "N/A"} />
        <MetricCard label="Mode" value={account?.mode ?? "N/A"} />
        <MetricCard label="Health" value={account?.health ?? "N/A"} tone={account?.health === "CRITICAL" ? "critical" : account?.health === "WARNING" ? "warn" : "default"} />
        <MetricCard label="Equity" value={formatMoney(data?.latestSnapshot?.equity)} />
        <MetricCard label="Drawdown" value={formatPercent(data?.latestSnapshot?.drawdownPct)} tone={(data?.latestSnapshot?.drawdownPct ?? 0) >= 5 ? "warn" : "default"} />
        <MetricCard label="Open Positions" value={data?.latestSnapshot?.openPositionCount ?? 0} />
      </div>

      <Panel title="Rule profile" subtitle="Active deterministic caps and constraints for this account.">
        <table className="data-table">
          <tbody>
            <tr>
              <th>Profile version</th>
              <td>{account?.activeRuleProfile?.version ?? "N/A"}</td>
            </tr>
            <tr>
              <th>Max risk per trade</th>
              <td>{formatPercent((account?.activeRuleProfile?.maxRiskPerTradePct ?? 0) * 100)}</td>
            </tr>
            <tr>
              <th>Max open positions</th>
              <td>{account?.activeRuleProfile?.maxOpenPositions ?? "N/A"}</td>
            </tr>
            <tr>
              <th>Daily loss limit</th>
              <td>{formatMoney(account?.activeRuleProfile?.dailyLossLimitUsd)}</td>
            </tr>
            <tr>
              <th>Total loss limit</th>
              <td>{formatMoney(account?.activeRuleProfile?.totalLossLimitUsd)}</td>
            </tr>
          </tbody>
        </table>
      </Panel>

      <Panel title="Open positions" subtitle="Current inventory on this account.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Direction</th>
              <th>Qty</th>
              <th>Exposure</th>
              <th>Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {(data?.openPositions ?? []).map((position) => (
              <tr key={position.id}>
                <td>{position.symbol.ticker}</td>
                <td>{position.direction}</td>
                <td>{position.quantity}</td>
                <td>{formatPercent(position.exposurePct)}</td>
                <td className={position.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(position.unrealizedPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Allocation history" subtitle="How recent setups scored for this account and whether they were selected.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Candidate</th>
              <th>Policy</th>
              <th>Status</th>
              <th>Fit score</th>
              <th>Selected</th>
              <th>Fit details</th>
              <th>Reasons</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {(data?.allocationHistory ?? []).map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.createdAt)}</td>
                <td>
                  <strong>{row.candidate.symbol}</strong>
                  <div className="mono">{row.candidate.direction} {row.candidate.timeframe}</div>
                </td>
                <td>{row.policy}</td>
                <td><StatusPill value={row.allocationStatus} /></td>
                <td>{row.totalScore.toFixed(1)}</td>
                <td>{row.selected ? "Yes" : "No"}</td>
                <td className="mono">
                  {row.componentsJson
                    ? `h=${row.componentsJson.healthFit ?? 0} m=${row.componentsJson.modeFit ?? 0} dd=${row.componentsJson.drawdownHeadroom ?? 0} u=${row.componentsJson.utilizationFit ?? 0} v=${row.componentsJson.validationFit ?? 0}`
                    : "N/A"}
                </td>
                <td className="mono">{row.reasonCodes.length > 0 ? row.reasonCodes.join(", ") : "—"}</td>
                <td>{row.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
