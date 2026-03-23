"use client";

import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader } from "../../components/screen";
import { fetcher, formatDateTime, formatMoney, formatPercent } from "../../lib/api";

interface PortfolioResponse {
  account: {
    balance: number;
    equity: number;
    freeMargin: number;
    openPnl: number;
    drawdownPct: number;
    riskState: string;
  } | null;
  openPositions: Array<{
    id: string;
    direction: string;
    quantity: number;
    avgEntryPrice: number;
    unrealizedPnl: number;
    exposurePct: number;
    symbol: { ticker: string };
  }>;
  closedPositions: Array<{
    id: string;
    direction: string;
    realizedPnl: number;
    closedAt: string | null;
    symbol: { ticker: string };
  }>;
  exposureBySymbol: Array<{ symbol: string; exposurePct: number; direction: string; unrealizedPnl: number }>;
}

export default function PortfolioPage() {
  const { data } = useSWR<PortfolioResponse>("/api/portfolio", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Portfolio"
        title="Exposure, positions, and drawdown"
        description="Monitor current portfolio shape, open and closed trades, and the account-level risk state."
      />

      <div className="metrics-grid">
        <MetricCard label="Balance" value={formatMoney(data?.account?.balance)} />
        <MetricCard label="Equity" value={formatMoney(data?.account?.equity)} />
        <MetricCard label="Free Margin" value={formatMoney(data?.account?.freeMargin)} />
        <MetricCard label="Open PnL" value={formatMoney(data?.account?.openPnl)} tone={(data?.account?.openPnl ?? 0) >= 0 ? "good" : "warn"} />
        <MetricCard label="Drawdown" value={formatPercent(data?.account?.drawdownPct)} tone={(data?.account?.drawdownPct ?? 0) >= 2 ? "warn" : "default"} />
        <MetricCard label="Risk State" value={data?.account?.riskState ?? "N/A"} tone={(data?.account?.riskState ?? "").includes("CAUTION") ? "warn" : "default"} />
      </div>

      <Panel title="Open positions" subtitle="Current live or paper inventory with exposure and unrealized PnL.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Direction</th>
              <th>Qty</th>
              <th>Entry</th>
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
                <td>{position.avgEntryPrice.toFixed(2)}</td>
                <td>{position.exposurePct.toFixed(2)}%</td>
                <td className={position.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(position.unrealizedPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Closed positions" subtitle="Most recent exits and realized outcomes.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Direction</th>
              <th>Realized</th>
              <th>Closed</th>
            </tr>
          </thead>
          <tbody>
            {(data?.closedPositions ?? []).map((position) => (
              <tr key={position.id}>
                <td>{position.symbol.ticker}</td>
                <td>{position.direction}</td>
                <td className={position.realizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(position.realizedPnl)}</td>
                <td>{formatDateTime(position.closedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
