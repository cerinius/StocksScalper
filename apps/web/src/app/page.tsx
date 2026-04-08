"use client";

import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader, StatusPill } from "../components/screen";
import { fetcher, formatDateTime, formatMoney, formatPercent } from "../lib/api";
import Link from "next/link";

interface DashboardData {
  account: {
    balance: number;
    equity: number;
    freeMargin: number;
    openPnl: number;
    realizedPnlDaily: number;
    drawdownPct: number;
    riskState: string;
    killSwitchActive: boolean;
  } | null;
  activeTrades: number;
  recentActions: Array<{ message: string; createdAt: string; severity: string; category: string }>;
  riskWarnings: Array<{ id: string; eventType: string; message: string; severity: string; createdAt: string; blocking: boolean }>;
  workerHealth: Array<{ workerType: string; status: string; currentTask: string | null; lastSeenAt: string }>;
  killSwitchActive: boolean;
  dynamicMaxRiskPerTradePct: number | null;
  activeWatchlist: {
    id: string;
    name: string;
    items: { symbol: { ticker: string } }[];
  } | null;
  news: Array<{ id: string; headline: string; source: string; originalTimestamp: string; symbol: string }>;
  marketSnapshots: Array<{ id: string; symbol: { ticker: string }; timeframe: string; currentPrice: number; trendBias: string }>;
}

export default function DashboardPage() {
  const { data } = useSWR<DashboardData>("/api/dashboard/summary", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Control Tower"
        title="Trading intelligence command center"
        description="Monitor account state, worker health, risk pressure, and the latest platform actions from one place."
      />

      <div className="metrics-grid">
        <MetricCard label="Balance" value={formatMoney(data?.account?.balance)} />
        <MetricCard label="Equity" value={formatMoney(data?.account?.equity)} tone={(data?.account?.openPnl ?? 0) >= 0 ? "good" : "warn"} />
        <MetricCard label="Free Margin" value={formatMoney(data?.account?.freeMargin)} />
        <MetricCard label="Open PnL" value={formatMoney(data?.account?.openPnl)} tone={(data?.account?.openPnl ?? 0) >= 0 ? "good" : "warn"} />
        <MetricCard label="Realized Today" value={formatMoney(data?.account?.realizedPnlDaily)} tone={(data?.account?.realizedPnlDaily ?? 0) >= 0 ? "good" : "warn"} />
        <MetricCard label="Drawdown" value={formatPercent(data?.account?.drawdownPct)} tone={(data?.account?.drawdownPct ?? 0) >= 2 ? "warn" : "default"} />
        <MetricCard label="Active Trades" value={data?.activeTrades ?? 0} />
        <MetricCard label="Kill Switch" value={data?.killSwitchActive ? "Active" : "Clear"} tone={data?.killSwitchActive ? "critical" : "good"} />
        <MetricCard label="Risk / Trade" value={data?.dynamicMaxRiskPerTradePct ? `${data.dynamicMaxRiskPerTradePct.toFixed(2)}%` : "Base"} tone={(data?.dynamicMaxRiskPerTradePct ?? 0.75) < 0.75 ? "warn" : "default"} />
      </div>

      <div className="panel-grid">
        <Panel title="Favorites Overview" subtitle={data?.activeWatchlist?.name ?? "No active watchlist"}>
          <div className="list-stack">
            {(data?.activeWatchlist?.items ?? []).map((item) => (
              <div className="list-item" key={item.symbol.ticker}>
                <p>{item.symbol.ticker}</p>
              </div>
            ))}
            <Link href="/watchlists">Manage Watchlists</Link>
          </div>
        </Panel>

        <Panel title="News by Favorites" subtitle="Latest news for your active watchlist.">
          <div className="list-stack">
            {(data?.news ?? []).map((newsItem) => (
              <div className="list-item" key={newsItem.id}>
                <p>{newsItem.headline}</p>
                <small>{newsItem.source} - {formatDateTime(newsItem.originalTimestamp)}</small>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="panel-grid">
        <Panel title="Market Opportunities" subtitle="Latest market snapshots for your active watchlist.">
          <table className="data-table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Timeframe</th>
                <th>Price</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              {(data?.marketSnapshots ?? []).map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{snapshot.symbol.ticker}</td>
                  <td>{snapshot.timeframe}</td>
                  <td>{formatMoney(snapshot.currentPrice)}</td>
                  <td><StatusPill value={snapshot.trendBias} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Worker Health" subtitle="Heartbeat and task visibility across the autonomous worker fleet.">
          <table className="data-table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th>Task</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {(data?.workerHealth ?? []).map((worker) => (
                <tr key={worker.workerType}>
                  <td>{worker.workerType}</td>
                  <td><StatusPill value={worker.status} /></td>
                  <td>{worker.currentTask ?? "idle"}</td>
                  <td>{formatDateTime(worker.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="Recent Platform Actions" subtitle="Latest audit trail entries from workers, controls, and integrations.">
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Severity</th>
              <th>Category</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {(data?.recentActions ?? []).map((action, index) => (
              <tr key={`${action.createdAt}-${index}`}>
                <td>{formatDateTime(action.createdAt)}</td>
                <td><StatusPill value={action.severity} /></td>
                <td>{action.category}</td>
                <td>{action.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
