"use client";

import useSWR from "swr";
import { MetricCard, Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface BridgeSnapshot {
  id: string;
  bridgeHost: string;
  status: string;
  terminalConnected: boolean;
  brokerConnected: boolean;
  accountLogin: string | null;
  server: string | null;
  pingMs: number | null;
  stalenessSeconds: number;
  lastOrderAckMs: number | null;
  lastPositionSyncMs: number | null;
  lastHeartbeatAt: string;
  capturedAt: string;
  account: {
    id: string;
    displayName: string;
    mode: string;
    health: string;
    tradingMode: string;
    providerName: string;
  };
  integration: {
    id: string;
    name: string;
    kind: string;
    enabled: boolean;
    mode: string | null;
  };
}

interface BridgeOverview {
  summary: {
    accounts: number;
    connected: number;
    degraded: number;
    stale: number;
    disconnected: number;
    error: number;
    blockNewOrders: number;
  };
  latestByAccount: BridgeSnapshot[];
  recentSnapshots: BridgeSnapshot[];
}

export default function BridgePage() {
  const { data } = useSWR<BridgeOverview>("/api/bridge?limit=200", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Bridge"
        title="MT5 bridge health and freshness"
        description="Monitor terminal connectivity and staleness per account so stale links are blocked before execution."
      />

      <div className="metrics-grid">
        <MetricCard label="Accounts" value={data?.summary.accounts ?? 0} />
        <MetricCard label="Connected" value={data?.summary.connected ?? 0} tone="good" />
        <MetricCard label="Degraded" value={data?.summary.degraded ?? 0} tone={(data?.summary.degraded ?? 0) > 0 ? "warn" : "default"} />
        <MetricCard label="Stale" value={data?.summary.stale ?? 0} tone={(data?.summary.stale ?? 0) > 0 ? "critical" : "default"} />
        <MetricCard label="Disconnected" value={data?.summary.disconnected ?? 0} tone={(data?.summary.disconnected ?? 0) > 0 ? "critical" : "default"} />
        <MetricCard label="Error" value={data?.summary.error ?? 0} tone={(data?.summary.error ?? 0) > 0 ? "critical" : "default"} />
        <MetricCard label="Order Blocked" value={data?.summary.blockNewOrders ?? 0} tone={(data?.summary.blockNewOrders ?? 0) > 0 ? "critical" : "good"} />
      </div>

      <Panel title="Latest status per account" subtitle="Most recent snapshot by account, used by the stale-bridge safety gate.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Bridge Host</th>
              <th>Status</th>
              <th>Terminal</th>
              <th>Broker</th>
              <th>Staleness</th>
              <th>Ping</th>
              <th>Heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {(data?.latestByAccount ?? []).map((row) => (
              <tr key={row.id}>
                <td>
                  <strong>{row.account.displayName}</strong>
                  <div className="mono">{row.account.providerName} mode={row.account.mode}</div>
                </td>
                <td className="mono">{row.bridgeHost}</td>
                <td><StatusPill value={row.status} /></td>
                <td>{row.terminalConnected ? "Connected" : "Disconnected"}</td>
                <td>{row.brokerConnected ? "Connected" : "Disconnected"}</td>
                <td>{row.stalenessSeconds}s</td>
                <td>{row.pingMs ?? "N/A"}ms</td>
                <td>{formatDateTime(row.lastHeartbeatAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Recent snapshots" subtitle="Raw stream for debugging sudden status changes and latency spikes.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Captured</th>
              <th>Account</th>
              <th>Status</th>
              <th>Staleness</th>
              <th>Ping</th>
              <th>Order Ack</th>
              <th>Position Sync</th>
              <th>Server</th>
            </tr>
          </thead>
          <tbody>
            {(data?.recentSnapshots ?? []).map((row) => (
              <tr key={row.id}>
                <td>{formatDateTime(row.capturedAt)}</td>
                <td>{row.account.displayName}</td>
                <td><StatusPill value={row.status} /></td>
                <td>{row.stalenessSeconds}s</td>
                <td>{row.pingMs ?? "N/A"}ms</td>
                <td>{row.lastOrderAckMs ?? "N/A"}ms</td>
                <td>{row.lastPositionSyncMs ?? "N/A"}ms</td>
                <td>{row.server ?? "N/A"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
