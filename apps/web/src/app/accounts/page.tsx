"use client";

import Link from "next/link";
import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatMoney, formatPercent, formatRelativeTime } from "../../lib/api";

interface AccountOverview {
  id: string;
  displayName: string;
  kind: string;
  providerName: string;
  tradingMode: string;
  mode: string;
  health: string;
  phaseKind: string | null;
  isActive: boolean;
  latestSnapshot: {
    capturedAt: string;
    balance: number;
    equity: number;
    openPnl: number;
    drawdownPct: number;
    dailyLossUsedPct: number;
    totalLossUsedPct: number;
    openPositionCount: number;
    riskState: string;
    killSwitchActive: boolean;
  } | null;
  openPositions: number;
}

export default function AccountsPage() {
  const { data } = useSWR<AccountOverview[]>("/api/accounts", fetcher, { refreshInterval: 5000 });
  const accounts = data ?? [];

  return (
    <>
      <ScreenHeader
        eyebrow="Accounts"
        title="Multi-account health and phase overview"
        description="Track funded and evaluation accounts, distance to limits, and active risk posture in one place."
      />

      <div className="metrics-grid">
        <MetricCard label="Active Accounts" value={accounts.length} />
        <MetricCard label="Funded" value={accounts.filter((a) => a.phaseKind === "FUNDED").length} />
        <MetricCard label="Evaluation" value={accounts.filter((a) => a.phaseKind === "EVALUATION" || a.phaseKind === "VERIFICATION").length} />
        <MetricCard
          label="Kill Switch Active"
          value={accounts.filter((a) => a.latestSnapshot?.killSwitchActive).length}
          tone={accounts.some((a) => a.latestSnapshot?.killSwitchActive) ? "critical" : "default"}
        />
      </div>

      <Panel title="Account roster" subtitle="Latest account state with direct drill-down into phase, profile, and allocation decisions.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Phase</th>
              <th>Mode</th>
              <th>Health</th>
              <th>Equity</th>
              <th>Open PnL</th>
              <th>DD Used</th>
              <th>Positions</th>
              <th>Snapshot</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <Link href={`/accounts/${account.id}`}>
                    <strong>{account.displayName}</strong>
                  </Link>
                  <div className="mono">{account.providerName}</div>
                </td>
                <td>{account.phaseKind ?? "N/A"}</td>
                <td>{account.mode}</td>
                <td><StatusPill value={account.health} /></td>
                <td>{formatMoney(account.latestSnapshot?.equity)}</td>
                <td className={(account.latestSnapshot?.openPnl ?? 0) >= 0 ? "positive" : "negative"}>
                  {formatMoney(account.latestSnapshot?.openPnl)}
                </td>
                <td>
                  {formatPercent(account.latestSnapshot?.dailyLossUsedPct)} / {formatPercent(account.latestSnapshot?.totalLossUsedPct)}
                </td>
                <td>{account.latestSnapshot?.openPositionCount ?? account.openPositions}</td>
                <td>{formatRelativeTime(account.latestSnapshot?.capturedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
