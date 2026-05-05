"use client";

import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader } from "../../components/screen";
import { fetcher, formatMoney, formatPercent } from "../../lib/api";

interface ExposureResponse {
  summary: {
    openPositionCount: number;
    accountCount: number;
    symbolCount: number;
    correlationGroupCount: number;
    totalGrossExposurePct: number;
    totalUnrealizedPnl: number;
    totalRiskUsd: number;
    capturedAt: string;
  };
  byAccount: Array<{
    accountId: string;
    accountName: string;
    mode: string;
    health: string;
    openPositionCount: number;
    grossExposurePct: number;
    netLongQty: number;
    netShortQty: number;
    unrealizedPnl: number;
    riskUsd: number;
    equity: number | null;
  }>;
  bySymbol: Array<{
    symbol: string;
    correlationGroup: string | null;
    assetClass: string;
    openPositionCount: number;
    longQty: number;
    shortQty: number;
    netQty: number;
    grossExposurePct: number;
    unrealizedPnl: number;
  }>;
  byCorrelationGroup: Array<{
    group: string;
    openPositionCount: number;
    grossExposurePct: number;
    unrealizedPnl: number;
  }>;
  byAssetClass: Array<{
    assetClass: string;
    openPositionCount: number;
    grossExposurePct: number;
    unrealizedPnl: number;
  }>;
}

export default function ExposurePage() {
  const { data } = useSWR<ExposureResponse>("/api/exposure?limit=300", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Exposure"
        title="Cross-account exposure and concentration"
        description="Track how risk is distributed across accounts, symbols, correlation groups, and asset classes."
      />

      <div className="metrics-grid">
        <MetricCard label="Open Positions" value={data?.summary.openPositionCount ?? 0} />
        <MetricCard label="Accounts" value={data?.summary.accountCount ?? 0} />
        <MetricCard label="Symbols" value={data?.summary.symbolCount ?? 0} />
        <MetricCard label="Correlation Groups" value={data?.summary.correlationGroupCount ?? 0} />
        <MetricCard label="Gross Exposure" value={formatPercent(data?.summary.totalGrossExposurePct)} tone={(data?.summary.totalGrossExposurePct ?? 0) > 300 ? "warn" : "default"} />
        <MetricCard label="Unrealized PnL" value={formatMoney(data?.summary.totalUnrealizedPnl)} tone={(data?.summary.totalUnrealizedPnl ?? 0) >= 0 ? "good" : "warn"} />
        <MetricCard label="Open Risk (USD)" value={formatMoney(data?.summary.totalRiskUsd)} tone={(data?.summary.totalRiskUsd ?? 0) > 0 ? "warn" : "default"} />
      </div>

      <Panel title="By account" subtitle="Where open risk is concentrated right now.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Mode</th>
              <th>Health</th>
              <th>Positions</th>
              <th>Gross Exposure</th>
              <th>Open Risk</th>
              <th>Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {(data?.byAccount ?? []).map((row) => (
              <tr key={row.accountId}>
                <td>{row.accountName}</td>
                <td>{row.mode}</td>
                <td>{row.health}</td>
                <td>{row.openPositionCount}</td>
                <td>{formatPercent(row.grossExposurePct)}</td>
                <td>{formatMoney(row.riskUsd)}</td>
                <td className={row.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(row.unrealizedPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="By symbol" subtitle="Symbol-level concentration and directional imbalance.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Asset Class</th>
              <th>Correlation Group</th>
              <th>Positions</th>
              <th>Net Qty</th>
              <th>Gross Exposure</th>
              <th>Unrealized</th>
            </tr>
          </thead>
          <tbody>
            {(data?.bySymbol ?? []).map((row) => (
              <tr key={row.symbol}>
                <td>{row.symbol}</td>
                <td>{row.assetClass}</td>
                <td>{row.correlationGroup ?? "N/A"}</td>
                <td>{row.openPositionCount}</td>
                <td>{row.netQty.toFixed(2)}</td>
                <td>{formatPercent(row.grossExposurePct)}</td>
                <td className={row.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(row.unrealizedPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <div className="panel-grid">
        <Panel title="By correlation group" subtitle="Clustered risk across similar symbols.">
          <table className="data-table">
            <thead>
              <tr>
                <th>Group</th>
                <th>Positions</th>
                <th>Gross Exposure</th>
                <th>Unrealized</th>
              </tr>
            </thead>
            <tbody>
              {(data?.byCorrelationGroup ?? []).map((row) => (
                <tr key={row.group}>
                  <td>{row.group}</td>
                  <td>{row.openPositionCount}</td>
                  <td>{formatPercent(row.grossExposurePct)}</td>
                  <td className={row.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(row.unrealizedPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="By asset class" subtitle="Macro distribution across asset classes.">
          <table className="data-table">
            <thead>
              <tr>
                <th>Asset Class</th>
                <th>Positions</th>
                <th>Gross Exposure</th>
                <th>Unrealized</th>
              </tr>
            </thead>
            <tbody>
              {(data?.byAssetClass ?? []).map((row) => (
                <tr key={row.assetClass}>
                  <td>{row.assetClass}</td>
                  <td>{row.openPositionCount}</td>
                  <td>{formatPercent(row.grossExposurePct)}</td>
                  <td className={row.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(row.unrealizedPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
